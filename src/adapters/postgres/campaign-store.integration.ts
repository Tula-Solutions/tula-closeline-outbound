import { afterAll, describe, expect, test } from 'bun:test'
import {
  type Campaign,
  type CampaignId,
  formatId,
  type MembershipId,
  type OrganizationId,
  type Step,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { newOrganizationId } from '~/testing'
import { createPostgresCampaignStore } from './campaign-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const store = createPostgresCampaignStore((organizationId, fn) =>
  withOrganization(database.db, organizationId, fn)
)

const member = (): MembershipId => formatId('mem', crypto.randomUUID())

function newCampaign(owner: MembershipId, at: string, extra: Partial<Campaign> = {}): Campaign {
  return {
    id: formatId('cpg', crypto.randomUUID()),
    name: 'Q3 outreach',
    goal: 'Book intro calls',
    state: 'draft',
    audience: { kind: 'filter', status: 'active' },
    audienceVersion: 1,
    sequenceVersion: 0,
    previewedVersion: null,
    previewedAt: null,
    approvalMode: 'review',
    language: 'en',
    sendWindow: {
      timeZone: 'America/New_York',
      days: ['mon', 'tue'],
      startMinute: 540,
      endMinute: 1020,
    },
    windowZone: 'campaign',
    dailyCap: 50,
    ownerMembershipId: owner,
    teamId: null,
    playId: null,
    createdAt: at,
    updatedAt: at,
    launchedAt: null,
    archivedAt: null,
    ...extra,
  } as Campaign
}

const STEPS: Step[] = [
  {
    kind: 'email',
    key: 'intro',
    goal: 'Introduce us',
    variants: {
      variants: [
        { key: 'a', label: 'A', angle: 'Customer story', weight: 60 },
        { key: 'b', label: 'B', angle: 'Direct ask', weight: 40 },
      ],
      promotion: { mode: 'manual' },
    },
    next: 'pause',
  },
  { kind: 'wait', key: 'pause', waitHours: 48, next: 'bye' },
  { kind: 'end', key: 'bye' },
] as Step[]

async function seed(org: OrganizationId, owner: MembershipId, at: string, extra = {}) {
  const campaign = newCampaign(owner, at, extra)
  await store.insertIfAbsent(org, campaign, null, owner)
  return campaign
}

describe('the Postgres Campaign store', () => {
  test('insertIfAbsent writes once; a replay returns what is stored', async () => {
    const org = newOrganizationId()
    const owner = member()
    const campaign = newCampaign(owner, '2026-03-10T12:00:00.000Z')
    const first = await store.insertIfAbsent(org, campaign, null, owner)
    expect(first.created).toBe(true)
    expect(first.campaign).toEqual(campaign)
    const again = await store.insertIfAbsent(org, { ...campaign, name: 'Changed' }, null, owner)
    expect(again.created).toBe(false)
    expect(again.campaign.name).toBe('Q3 outreach')
    expect(await store.find(org, campaign.id)).toEqual(campaign)
    expect(await store.find(org, formatId('cpg', crypto.randomUUID()))).toBeNull()
  })

  test('a copy with a first Sequence version stores it at that version', async () => {
    const org = newOrganizationId()
    const owner = member()
    const campaign = newCampaign(owner, '2026-03-10T12:00:00.000Z', { sequenceVersion: 1 })
    await store.insertIfAbsent(org, campaign, STEPS, owner)
    const read = await store.readSequence(org, campaign.id, 1)
    expect(read?.steps).toEqual(STEPS)
  })

  test('lists newest first by keyset with filters, and never across Organizations', async () => {
    const org = newOrganizationId()
    const other = newOrganizationId()
    const mine = member()
    const theirs = member()
    const ids: CampaignId[] = []
    for (let i = 0; i < 5; i++) {
      const at = `2026-03-10T12:00:0${i}.000Z`
      ids.push((await seed(org, i % 2 === 0 ? mine : theirs, at)).id)
    }
    await seed(other, mine, '2026-03-10T12:00:09.000Z')
    const [c0, , c2, , c4] = ids as [CampaignId, CampaignId, CampaignId, CampaignId, CampaignId]
    const seen: CampaignId[] = []
    let after = null
    for (;;) {
      const page = await store.list(org, {}, after, 2)
      seen.push(...page.items.map((c) => c.id))
      if (page.next === null) {
        break
      }
      after = page.next
    }
    expect(seen).toEqual([...ids].reverse())
    const owned = await store.list(org, { visibleOwners: [mine] }, null, 10)
    expect(owned.items.map((c) => c.id)).toEqual([c4, c2, c0])
    const none = await store.list(org, { visibleOwners: [] }, null, 10)
    expect(none.items).toEqual([])
    const drafts = await store.list(org, { state: 'running' }, null, 10)
    expect(drafts.items).toEqual([])
    expect((await store.list(other, {}, null, 10)).items).toHaveLength(1)
    expect(await store.find(other, c0)).toBeNull()
  })

  test('modify replaces under the lock, refuses by throwing, and reports a missing Campaign', async () => {
    const org = newOrganizationId()
    const campaign = await seed(org, member(), '2026-03-10T12:00:00.000Z')
    const changed = await store.modify(org, campaign.id, (c) => ({ ...c, name: 'Renamed' }))
    expect(changed?.name).toBe('Renamed')
    await expect(
      store.modify(org, campaign.id, () => {
        throw new Error('refused')
      })
    ).rejects.toThrow('refused')
    expect((await store.find(org, campaign.id))?.name).toBe('Renamed')
    expect(await store.modify(org, formatId('cpg', crypto.randomUUID()), (c) => c)).toBeNull()
    expect(await store.modify(newOrganizationId(), campaign.id, (c) => c)).toBeNull()
  })

  test('saveSequence writes a new version with its variants and keeps every older one', async () => {
    const org = newOrganizationId()
    const owner = member()
    const campaign = await seed(org, owner, '2026-03-10T12:00:00.000Z')
    expect(await store.readSequence(org, campaign.id, 0)).toBeNull()
    const save = (steps: readonly Step[]) =>
      store.saveSequence(org, campaign.id, (current, sequence) => ({
        kind: 'save',
        campaign: { ...current, sequenceVersion: sequence.version + 1 },
        steps,
        createdBy: owner,
      }))
    const one = await save(STEPS)
    expect(one?.campaign.sequenceVersion).toBe(1)
    expect(one?.sequence.steps).toEqual(STEPS)
    const second = STEPS.slice(1)
    const two = await save(second)
    expect(two?.sequence.version).toBe(2)
    expect((await store.readSequence(org, campaign.id, 1))?.steps).toEqual(STEPS)
    expect((await store.readSequence(org, campaign.id, 2))?.steps).toEqual(second)
    expect(await store.readSequence(org, campaign.id, 3)).toBeNull()
    const unchanged = await store.saveSequence(org, campaign.id, () => ({ kind: 'unchanged' }))
    expect(unchanged?.campaign.sequenceVersion).toBe(2)
    expect(
      await store.saveSequence(newOrganizationId(), campaign.id, () => ({ kind: 'unchanged' }))
    ).toBeNull()
  })

  test('an automatic promotion policy round-trips, and one winner is kept per Step', async () => {
    const org = newOrganizationId()
    const owner = member()
    const campaign = await seed(org, owner, '2026-03-10T12:00:00.000Z')
    const steps = STEPS.map((s) =>
      s.kind === 'email' && s.variants !== null
        ? {
            ...s,
            variants: {
              ...s.variants,
              promotion: { mode: 'auto', minSamplePerVariant: 250, marginPercentagePoints: 4.5 },
            },
          }
        : s
    ) as Step[]
    await store.saveSequence(org, campaign.id, (current, sequence) => ({
      kind: 'save',
      campaign: { ...current, sequenceVersion: sequence.version + 1 },
      steps,
      createdBy: owner,
    }))
    expect((await store.readSequence(org, campaign.id, 1))?.steps).toEqual(steps)
    expect(await store.promotionOf(org, campaign.id, 1, 'intro')).toBeNull()
    const auto = {
      variantKey: 'b',
      source: 'auto' as const,
      promotedByMembershipId: null,
      promotedAt: '2026-03-11T12:00:00.000Z',
    }
    const first = await store.promote(org, campaign.id, 1, 'intro', auto)
    expect(first).toEqual({ promotion: auto, created: true })
    const manual = {
      ...auto,
      variantKey: 'a',
      source: 'manual' as const,
      promotedByMembershipId: owner,
    }
    const second = await store.promote(org, campaign.id, 1, 'intro', manual)
    expect(second).toEqual({ promotion: auto, created: false })
    expect(await store.promotionOf(org, campaign.id, 1, 'intro')).toEqual(auto)
    expect((await store.readSequence(org, campaign.id, 1))?.steps).toEqual(steps)
    expect(await store.promotionOf(newOrganizationId(), campaign.id, 1, 'intro')).toBeNull()
  })
})
