import { afterAll, describe, expect, test } from 'bun:test'
import {
  type Campaign,
  type CampaignId,
  type Enrollment,
  type EnrollmentEvent,
  formatId,
  type MembershipId,
  type OrganizationId,
  type ProspectId,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { newOrganizationId } from '~/testing'
import { createPostgresCampaignStore } from './campaign-store'
import { createPostgresEnrollmentStore } from './enrollment-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const campaigns = createPostgresCampaignStore((organizationId, fn) =>
  withOrganization(database.db, organizationId, fn)
)
const store = createPostgresEnrollmentStore((organizationId, fn) =>
  withOrganization(database.db, organizationId, fn)
)

const AT = '2026-03-10T12:00:00.000Z'
const member = (): MembershipId => formatId('mem', crypto.randomUUID())

async function seedCampaign(org: OrganizationId): Promise<CampaignId> {
  const owner = member()
  const id: CampaignId = formatId('cpg', crypto.randomUUID())
  const campaign = {
    id,
    name: 'Q3',
    goal: 'Book calls',
    state: 'running',
    audience: { kind: 'filter', status: 'active' },
    audienceVersion: 1,
    sequenceVersion: 0,
    previewedVersion: null,
    previewedAt: null,
    approvalMode: 'review',
    language: 'en',
    sendWindow: { timeZone: 'America/New_York', days: ['mon'], startMinute: 540, endMinute: 1020 },
    windowZone: 'campaign',
    dailyCap: 50,
    ownerMembershipId: owner,
    teamId: null,
    playId: null,
    createdAt: AT,
    updatedAt: AT,
    launchedAt: null,
    archivedAt: null,
  } as Campaign
  await campaigns.insertIfAbsent(org, campaign, null, owner)
  return id
}

function row(campaignId: CampaignId, at: string, prospectId?: ProspectId) {
  const id = formatId('enr', crypto.randomUUID())
  const enrollment: Enrollment = {
    id,
    campaignId,
    prospectId: prospectId ?? formatId('prs', crypto.randomUUID()),
    state: 'active',
    stopReason: null,
    currentStepKey: 'intro',
    currentStep: 0,
    attemptEpoch: 0,
    nextDueAt: at,
    enrolledAt: at,
    stoppedAt: null,
    completedAt: null,
  }
  const event = (kind: EnrollmentEvent['kind']): EnrollmentEvent => ({
    id: formatId('eev', crypto.randomUUID()),
    enrollmentId: id,
    kind,
    stepKey: null,
    variantKey: null,
    sendId: null,
    stopReason: null,
    actorMembershipId: null,
    occurredAt: at,
  })
  return { enrollment, events: [event('enrolled'), event('step_entered')] }
}

describe('the Postgres Enrollment store', () => {
  test('insertIfAbsent writes once per Prospect and Campaign, never a second row', async () => {
    const org = newOrganizationId()
    const campaignId = await seedCampaign(org)
    const first = row(campaignId, AT)
    expect((await store.insertIfAbsent(org, first.enrollment, first.events)).created).toBe(true)
    const again = row(campaignId, AT, first.enrollment.prospectId)
    const replay = await store.insertIfAbsent(org, again.enrollment, again.events)
    expect(replay.created).toBe(false)
    expect(replay.enrollment.id).toBe(first.enrollment.id)
    const page = await store.list(org, campaignId, {}, null, 50)
    expect(page.items).toHaveLength(1)
    const log = await store.activity(org, first.enrollment.id, null, 50)
    expect(log.items).toHaveLength(2)
  })

  test('lists newest first by keyset and filters by state', async () => {
    const org = newOrganizationId()
    const campaignId = await seedCampaign(org)
    const made: Enrollment['id'][] = []
    for (let i = 0; i < 5; i++) {
      const r = row(campaignId, `2026-03-10T12:00:0${i}.000Z`)
      await store.insertIfAbsent(org, r.enrollment, r.events)
      made.push(r.enrollment.id)
    }
    const seen: string[] = []
    let after = null
    do {
      const page = await store.list(org, campaignId, {}, after, 2)
      seen.push(...page.items.map((e) => e.id))
      after = page.next
    } while (after !== null)
    expect(seen).toEqual([...made].reverse())
    await store.stop(org, made[0] as Enrollment['id'], 'removed_by_rep', AT, null)
    const stopped = await store.list(org, campaignId, { state: 'stopped' }, null, 10)
    expect(stopped.items.map((e) => e.id)).toEqual(made.slice(0, 1))
  })

  test('stop ends an active Enrollment once and is a no-op after', async () => {
    const org = newOrganizationId()
    const campaignId = await seedCampaign(org)
    const r = row(campaignId, AT)
    await store.insertIfAbsent(org, r.enrollment, r.events)
    const first = await store.stop(org, r.enrollment.id, 'removed_by_rep', AT, member())
    expect(first?.stopped).toBe(true)
    expect(first?.enrollment).toMatchObject({
      state: 'stopped',
      stopReason: 'removed_by_rep',
      currentStep: null,
      nextDueAt: null,
    })
    const second = await store.stop(org, r.enrollment.id, 'removed_by_rep', AT, member())
    expect(second?.stopped).toBe(false)
    const log = await store.activity(org, r.enrollment.id, null, 50)
    expect(log.items.filter((e) => e.kind === 'stopped')).toHaveLength(1)
    expect(
      await store.stop(org, formatId('enr', crypto.randomUUID()), 'removed_by_rep', AT, null)
    ).toBeNull()
  })

  test('activeElsewhere names Prospects active in another Campaign only', async () => {
    const org = newOrganizationId()
    const a = await seedCampaign(org)
    const b = await seedCampaign(org)
    const inA = row(a, AT)
    const inB = row(b, AT, inA.enrollment.prospectId)
    await store.insertIfAbsent(org, inA.enrollment, inA.events)
    await store.insertIfAbsent(org, inB.enrollment, inB.events)
    const free = formatId('prs', crypto.randomUUID())
    const ids = [inA.enrollment.prospectId, free]
    expect([...(await store.activeElsewhere(org, a, ids))]).toEqual([inA.enrollment.prospectId])
    await store.stop(org, inB.enrollment.id, 'removed_by_rep', AT, null)
    expect((await store.activeElsewhere(org, a, ids)).size).toBe(0)
  })

  test('a second Organization sees nothing and changes nothing', async () => {
    const org = newOrganizationId()
    const other = newOrganizationId()
    const campaignId = await seedCampaign(org)
    const r = row(campaignId, AT)
    await store.insertIfAbsent(org, r.enrollment, r.events)
    expect(await store.find(other, r.enrollment.id)).toBeNull()
    expect(await store.findByProspect(other, campaignId, r.enrollment.prospectId)).toBeNull()
    expect((await store.list(other, campaignId, {}, null, 10)).items).toHaveLength(0)
    expect((await store.activity(other, r.enrollment.id, null, 10)).items).toHaveLength(0)
    expect(await store.stop(other, r.enrollment.id, 'removed_by_rep', AT, null)).toBeNull()
    expect((await store.find(org, r.enrollment.id))?.state).toBe('active')
    expect(
      (
        await store.activeElsewhere(other, formatId('cpg', crypto.randomUUID()), [
          r.enrollment.prospectId,
        ])
      ).size
    ).toBe(0)
  })
})
