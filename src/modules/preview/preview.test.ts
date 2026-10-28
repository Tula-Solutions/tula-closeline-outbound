import { describe, expect, test } from 'bun:test'
import { type CampaignId, formatId, type ProspectId } from 'tula-closeline-contract'
import { ModelBudgetExceededError } from '~/ports/model'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
type Any = any
type Reply = { status: number; body: Record<string, Any> }
const newProspectId = (): ProspectId => formatId('prs', crypto.randomUUID())

const WINDOW = {
  timeZone: 'America/New_York',
  days: ['mon', 'tue'],
  startMinute: 540,
  endMinute: 1020,
}
const STEPS = [
  { kind: 'wait', key: 'first', waitHours: 24, next: 'intro' },
  { kind: 'email', key: 'intro', goal: 'Introduce us', variants: null, next: 'bye' },
  { kind: 'end', key: 'bye' },
]

async function world() {
  const t = await createTestApp()
  const who = (role: TestIdentity['role'], organizationId = newOrganizationId()): TestIdentity => ({
    userId: newUserId(),
    organizationId,
    role,
  })
  const admin = who('admin')
  const other = who('admin')
  const call = async (method: string, path: string, as: TestIdentity, body?: unknown) => {
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(as)),
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, Any>,
    } as Reply
  }
  const voice = { tone: 'Warm', preferredWords: [], bannedPhrases: [], signOff: null }
  for (const as of [admin, other]) {
    await call('PUT', '/v1/brand-voice', as, {
      ...voice,
      maxLengthCharacters: 1200,
      expectedVersion: 0,
    })
  }
  const campaign = async (as: TestIdentity): Promise<CampaignId> => {
    const made = await call('POST', '/v1/campaigns', as, {
      name: 'Q3',
      goal: 'Book calls',
      audience: { kind: 'filter', status: 'active' },
      sendWindow: WINDOW,
      dailyCap: 50,
    })
    const id = made.body.id as CampaignId
    const saved = await call('PUT', `/v1/campaigns/${id}/sequence`, as, {
      expectedVersion: 0,
      steps: STEPS,
    })
    expect(saved.status).toBe(200)
    return id
  }
  const seed = (as: TestIdentity) => {
    const id = newProspectId()
    t.deps.core.seed(as.organizationId, { id, ownerId: as.userId, values: { firstName: 'Ada' } })
    return id
  }
  const preview = (as: TestIdentity, id: CampaignId, prospectIds: ProspectId[], extra = {}) =>
    call('POST', `/v1/campaigns/${id}/preview`, as, { sequenceVersion: 1, prospectIds, ...extra })
  return { t, admin, other, call, campaign, seed, preview }
}

describe('preview on sample Prospects', () => {
  test('answers a Brief and Draft for each Prospect from the first email Step', async () => {
    const w = await world()
    const id = await w.campaign(w.admin)
    const prospects = [w.seed(w.admin), w.seed(w.admin)]
    const reply = await w.preview(w.admin, id, prospects)
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ sequenceVersion: 1, stepKey: 'intro' })
    expect(reply.body.items).toHaveLength(2)
    for (const item of reply.body.items) {
      expect(item.failureCode).toBeNull()
      expect(item.draft).toMatchObject({ goal: 'Introduce us', stepKey: 'intro', campaignId: id })
      expect(item.brief.prospectId).toBe(item.prospectId)
    }
  })

  test('six Prospects is preview.too_many_prospects', async () => {
    const w = await world()
    const id = await w.campaign(w.admin)
    const six = Array.from({ length: 6 }, () => w.seed(w.admin))
    const reply = await w.preview(w.admin, id, six)
    expect(reply.status).toBe(422)
    expect(reply.body.error.code).toBe('preview.too_many_prospects')
  })

  test('leaves Prospect data, suppression, the queue and the Draft store unchanged', async () => {
    const w = await world()
    const id = await w.campaign(w.admin)
    const prospect = w.seed(w.admin)
    const org = w.admin.organizationId
    const before = {
      prospect: JSON.stringify(w.t.deps.core.read(org, prospect)),
      writes: w.t.deps.core.writeCalls(),
      suppressed: w.t.deps.suppression.suppressed(org),
      queue: w.t.deps.queue.depth(),
    }
    const reply = await w.preview(w.admin, id, [prospect])
    expect(reply.status).toBe(200)
    expect(JSON.stringify(w.t.deps.core.read(org, prospect))).toBe(before.prospect)
    expect(w.t.deps.core.writeCalls()).toBe(before.writes)
    expect(w.t.deps.suppression.suppressed(org)).toEqual(before.suppressed)
    expect(w.t.deps.queue.depth()).toEqual(before.queue)
    expect(w.t.deps.queue.deadLetters()).toHaveLength(0)
    expect(await w.t.deps.drafts.store.get(org, reply.body.items[0].draft.id)).toBeNull()
    const listed = await w.call('GET', `/v1/outreach-drafts?prospectId=${prospect}`, w.admin)
    expect(JSON.stringify(listed.body)).not.toContain(reply.body.items[0].draft.id)
  })

  test('one Prospect failing is a row, not a failed call', async () => {
    const w = await world()
    const id = await w.campaign(w.admin)
    w.t.deps.researchModel.script(new ModelBudgetExceededError())
    const reply = await w.preview(w.admin, id, [w.seed(w.admin)])
    expect(reply.status).toBe(200)
    expect(reply.body.items[0]).toMatchObject({
      brief: null,
      draft: null,
      failureCode: 'draft.budget_exceeded',
    })
  })

  test('a stale Sequence version and a Step that is not an email are refused', async () => {
    const w = await world()
    const id = await w.campaign(w.admin)
    const prospect = w.seed(w.admin)
    const stale = await w.preview(w.admin, id, [prospect], { sequenceVersion: 2 })
    expect(stale.body.error.code).toBe('campaign.sequence_version_conflict')
    const notEmail = await w.preview(w.admin, id, [prospect], { stepKey: 'bye' })
    expect(notEmail.body.error.code).toBe('request.invalid')
  })

  test('another Organization cannot preview the Campaign or its Prospects', async () => {
    const w = await world()
    const id = await w.campaign(w.admin)
    const mine = w.seed(w.admin)
    const theirs = w.seed(w.other)
    const campaign = await w.preview(w.other, id, [theirs])
    expect(campaign.status).toBe(404)
    expect(campaign.body.error.code).toBe('campaign.not_found')
    const prospect = await w.preview(w.admin, id, [mine, theirs])
    expect(prospect.status).toBe(404)
    expect(prospect.body.error.code).toBe('prospect.not_found')
    // Nothing of the first call leaked into the second Organization's world.
    expect(JSON.stringify(prospect.body)).not.toContain(theirs)
  })
})
