import { describe, expect, test } from 'bun:test'
import {
  type Campaign,
  type CampaignId,
  formatId,
  type OrganizationId,
  type ProspectId,
  type Step,
} from 'tula-closeline-contract'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'
import { AUDIENCE_PAGE } from './audience'

type Body = Record<string, unknown>

const STEPS: Step[] = [
  { kind: 'email', key: 'intro', goal: 'Introduce us', variants: null, next: 'bye' },
  { kind: 'end', key: 'bye' },
]

const newProspect = (): ProspectId => formatId('prs', crypto.randomUUID())

async function world() {
  const t = await createTestApp()
  const org = newOrganizationId()
  const who = (role: TestIdentity['role']): TestIdentity => ({
    userId: newUserId(),
    organizationId: org,
    role,
  })
  const owner = who('owner')
  const rep = who('rep')
  const otherRep = who('rep')
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
    return { status: response.status, body: (await response.json()) as Body }
  }
  /** A running Campaign with a one-email Sequence, owned by `as`. */
  const running = async (as: TestIdentity, state: Campaign['state'] = 'running') => {
    const made = await call('POST', '/v1/campaigns', as, {
      name: 'Q3',
      goal: 'Book calls',
      audience: { kind: 'filter', status: 'active' },
      sendWindow: {
        timeZone: 'America/New_York',
        days: ['mon'],
        startMinute: 540,
        endMinute: 1020,
      },
      dailyCap: 50,
    })
    const campaign = made.body as unknown as Campaign
    await call('PUT', `/v1/campaigns/${campaign.id}/sequence`, as, {
      expectedVersion: 0,
      steps: STEPS,
    })
    await t.deps.campaigns.store.modify(org, campaign.id as CampaignId, (c) => ({ ...c, state }))
    return campaign.id
  }
  const prospect = (as: TestIdentity, org2: OrganizationId = org) => {
    const id = newProspect()
    t.deps.core.seed(org2, { id, ownerId: as.userId, values: { email: 'a@b.test' } })
    return id
  }
  const allow = (id: ProspectId, org2: OrganizationId = org) =>
    t.deps.guard.allow({ organizationId: org2, prospectId: id }, 'email')
  const enroll = (campaignId: string, ids: string[], as: TestIdentity) =>
    call('POST', `/v1/campaigns/${campaignId}/enrollments`, as, { prospectIds: ids })
  const drain = async () => {
    for (let i = 0; i < 400; i++) {
      if ((await t.deps.consumer.pollOnce()) === 0) {
        return
      }
    }
  }
  /** The id of a refused Prospect's stopped Enrollment, read back through the list. */
  const stoppedId = async (campaignId: string, stopReason: string, prospectId?: string) => {
    const q = `?stopReason=${stopReason}${prospectId === undefined ? '' : `&prospectId=${prospectId}`}`
    const page = await call('GET', `/v1/campaigns/${campaignId}/enrollments${q}`, rep)
    return (page.body.items as Body[])[0]?.id as string
  }
  return { t, org, stoppedId, owner, rep, otherRep, call, running, prospect, allow, enroll, drain }
}

const results = (body: Body) => body.results as Body[]

describe('enroll', () => {
  test('enrolls an allowed Prospect, and a re-run creates no duplicate', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    const p = w.prospect(w.rep)
    w.allow(p)
    const first = await w.enroll(id, [p], w.rep)
    expect(first.status).toBe(200)
    expect(results(first.body)[0]).toMatchObject({ outcome: 'enrolled', refusal: null })
    const again = await w.enroll(id, [p], w.rep)
    expect(results(again.body)[0]).toMatchObject({
      outcome: 'refused',
      refusal: 'already_active',
      enrollmentId: results(first.body)[0]?.enrollmentId,
    })
    const list = await w.call('GET', `/v1/campaigns/${id}/enrollments`, w.rep)
    expect(list.body.items as unknown[]).toHaveLength(1)
  })

  test('a suppressed Prospect ends enrolled-as-stopped with enrollment.suppressed in the log', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    const p = w.prospect(w.rep)
    w.t.deps.guard.deny({ organizationId: w.org, prospectId: p }, 'email', 'consent.suppressed')
    const reply = await w.enroll(id, [p], w.rep)
    expect(results(reply.body)[0]).toMatchObject({ outcome: 'refused', refusal: 'suppressed' })
    const enrollmentId = await w.stoppedId(id, 'suppressed')
    const got = await w.call('GET', `/v1/enrollments/${enrollmentId}`, w.rep)
    expect(got.body).toMatchObject({
      state: 'stopped',
      stopReason: 'suppressed',
      currentStep: null,
    })
    const log = await w.call('GET', `/v1/enrollments/${enrollmentId}/activity`, w.rep)
    const kinds = (log.body.items as Body[]).map((e) => e.kind)
    expect(kinds).toContain('stopped')
    expect(JSON.stringify(log.body)).toContain('suppressed')
    // The refusal sticks on a re-run; nothing new is created.
    const again = await w.enroll(id, [p], w.rep)
    expect(results(again.body)[0]).toMatchObject({ refusal: 'suppressed' })
  })

  test('no consent, and an unavailable check, both end as no_consent', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    const missing = w.prospect(w.rep)
    const reply = await w.enroll(id, [missing], w.rep)
    expect(results(reply.body)[0]).toMatchObject({ refusal: 'no_consent' })
    const other = w.prospect(w.rep)
    w.allow(other)
    w.t.deps.guard.setUnavailable()
    const down = await w.enroll(id, [other], w.rep)
    expect(results(down.body)[0]).toMatchObject({ refusal: 'no_consent' })
    const enrollmentId = await w.stoppedId(id, 'no_consent', other)
    const got = await w.call('GET', `/v1/enrollments/${enrollmentId}`, w.rep)
    expect(got.body).toMatchObject({ stopReason: 'no_consent' })
  })

  test('only a running or paused Campaign takes Enrollments', async () => {
    const w = await world()
    const p = w.prospect(w.rep)
    w.allow(p)
    for (const state of ['draft', 'archived'] as const) {
      const id = await w.running(w.rep, state)
      const reply = await w.enroll(id, [p], w.rep)
      expect(reply.status).toBe(409)
      expect((reply.body.error as Body).code).toBe('campaign.invalid_state')
    }
  })

  test('an unknown or out-of-view Prospect is not_found; active elsewhere is refused', async () => {
    const w = await world()
    const a = await w.running(w.rep)
    const b = await w.running(w.rep)
    const theirs = w.prospect(w.otherRep)
    w.allow(theirs)
    const mine = w.prospect(w.rep)
    w.allow(mine)
    const unknown = newProspect()
    const reply = await w.enroll(a, [theirs, unknown, mine], w.rep)
    expect(results(reply.body).map((r) => r.refusal)).toEqual(['not_found', 'not_found', null])
    const elsewhere = await w.enroll(b, [mine], w.rep)
    expect(results(elsewhere.body)[0]).toMatchObject({ refusal: 'already_active' })
  })

  test('a second Organization cannot see or touch the first one’s Enrollments', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    const p = w.prospect(w.rep)
    w.allow(p)
    const done = await w.enroll(id, [p], w.rep)
    const enrollmentId = results(done.body)[0]?.enrollmentId as string
    const stranger: TestIdentity = {
      userId: newUserId(),
      organizationId: newOrganizationId(),
      role: 'owner',
    }
    expect((await w.call('GET', `/v1/enrollments/${enrollmentId}`, stranger)).status).toBe(404)
    expect((await w.call('DELETE', `/v1/enrollments/${enrollmentId}`, stranger, {})).status).toBe(
      404
    )
    expect((await w.call('GET', `/v1/campaigns/${id}/enrollments`, stranger)).status).toBe(404)
    expect((await w.enroll(id, [p], stranger)).status).toBe(404)
  })

  test('a Rep cannot reach Enrollments of a Campaign they cannot see', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    const reply = await w.call('GET', `/v1/campaigns/${id}/enrollments`, w.otherRep)
    expect(reply.status).toBe(404)
  })
})

describe('remove and paging', () => {
  test('removing is idempotent and ends the Enrollment as removed_by_rep once', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    const p = w.prospect(w.rep)
    w.allow(p)
    const enrollmentId = results((await w.enroll(id, [p], w.rep)).body)[0]?.enrollmentId as string
    const first = await w.call('DELETE', `/v1/enrollments/${enrollmentId}`, w.rep, {})
    expect(first.body).toMatchObject({ state: 'stopped', stopReason: 'removed_by_rep' })
    const second = await w.call('DELETE', `/v1/enrollments/${enrollmentId}`, w.rep, {})
    expect(second.status).toBe(200)
    const log = await w.call('GET', `/v1/enrollments/${enrollmentId}/activity`, w.rep)
    expect((log.body.items as Body[]).filter((e) => e.kind === 'stopped')).toHaveLength(1)
  })

  test('lists are cursor pages and a bad cursor is refused', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    const ids = [w.prospect(w.rep), w.prospect(w.rep), w.prospect(w.rep)]
    for (const p of ids) {
      w.allow(p)
    }
    await w.enroll(id, ids, w.rep)
    const seen: unknown[] = []
    let cursor: string | null = null
    for (let i = 0; i < 5 && (i === 0 || cursor !== null); i++) {
      const q: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`
      const page = await w.call('GET', `/v1/campaigns/${id}/enrollments${q}`, w.rep)
      seen.push(...(page.body.items as unknown[]))
      cursor = page.body.nextCursor as string | null
    }
    expect(seen).toHaveLength(3)
    const bad = await w.call('GET', `/v1/campaigns/${id}/enrollments?cursor=nope`, w.rep)
    expect(bad.status).toBe(400)
  })
})

describe('audience check', () => {
  test('counts suppressed, no-consent and active-elsewhere members, and a replay answers the same check', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    const other = await w.running(w.rep)
    const ok = w.prospect(w.rep)
    const sup = w.prospect(w.rep)
    w.prospect(w.rep)
    const busy = w.prospect(w.rep)
    for (const p of [ok, busy]) {
      w.allow(p)
    }
    w.t.deps.guard.deny({ organizationId: w.org, prospectId: sup }, 'email', 'consent.suppressed')
    await w.enroll(other, [busy], w.rep)
    const started = await w.call('POST', `/v1/campaigns/${id}/audience-check`, w.rep, {})
    expect(started.status).toBe(202)
    expect(started.body.state).toBe('pending')
    const again = await w.call('POST', `/v1/campaigns/${id}/audience-check`, w.rep, {})
    expect(again.body.requestedAt).toBe(started.body.requestedAt)
    await w.drain()
    const done = await w.call('GET', `/v1/campaigns/${id}/audience-check`, w.rep)
    expect(done.body.state).toBe('ready')
    expect(done.body.counts).toMatchObject({
      total: 4,
      verified: 4,
      suppressed: 1,
      noConsent: 1,
      activeInOtherCampaign: 1,
      eligible: 1,
    })
  })

  test('an audience of 10,000 resolves in pages of at most 100, none holding the whole list', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    for (let i = 0; i < 10_000; i++) {
      const p = newProspect()
      w.t.deps.core.seed(w.org, { id: p, ownerId: w.rep.userId, values: { email: 'a@b.test' } })
      w.allow(p)
    }
    const limits: number[] = []
    const real = w.t.deps.campaigns.audience.list
    w.t.deps.campaigns.audience.list = async (...args) => {
      limits.push(args[3])
      return real(...args)
    }
    await w.call('POST', `/v1/campaigns/${id}/audience-check`, w.rep, {})
    await w.drain()
    const done = await w.call('GET', `/v1/campaigns/${id}/audience-check`, w.rep)
    expect(done.body.state).toBe('ready')
    expect((done.body.counts as Body).total).toBe(10_000)
    expect((done.body.counts as Body).eligible).toBe(10_000)
    expect(limits).toHaveLength(10_000 / AUDIENCE_PAGE)
    expect(Math.max(...limits)).toBeLessThanOrEqual(AUDIENCE_PAGE)
  }, 60_000)

  test('an archived Campaign refuses a check, and no check yet is campaign.not_found', async () => {
    const w = await world()
    const archived = await w.running(w.rep, 'archived')
    const refused = await w.call('POST', `/v1/campaigns/${archived}/audience-check`, w.rep, {})
    expect((refused.body.error as Body).code).toBe('campaign.invalid_state')
    const fresh = await w.running(w.rep)
    const none = await w.call('GET', `/v1/campaigns/${fresh}/audience-check`, w.rep)
    expect(none.status).toBe(404)
  })

  test('a check fails when the audience changes under it', async () => {
    const w = await world()
    const id = await w.running(w.rep)
    w.allow(w.prospect(w.rep))
    await w.call('POST', `/v1/campaigns/${id}/audience-check`, w.rep, {})
    await w.t.deps.campaigns.store.modify(w.org, id, (c) => ({
      ...c,
      audienceVersion: c.audienceVersion + 1,
    }))
    await w.drain()
    const done = await w.call('GET', `/v1/campaigns/${id}/audience-check`, w.rep)
    expect(done.body.state).toBe('failed')
  })
})
