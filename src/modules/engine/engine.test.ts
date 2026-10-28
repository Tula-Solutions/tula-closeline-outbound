import { describe, expect, test } from 'bun:test'
import {
  type CampaignId,
  type EnrollmentId,
  formatId,
  type OrganizationId,
  type ProspectId,
  type Step,
} from 'tula-closeline-contract'
import { assignVariant } from '~/modules/variant/assign'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'
import { PAUSED_RECHECK_MS, RETRY_MS, runStep, stopForProspect, sweep } from './service'

type Body = Record<string, unknown>

const ALL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const OPEN = { timeZone: 'UTC', days: [...ALL_DAYS], startMinute: 0, endMinute: 1440 }
const GROUNDED = { ungrounded: false, autoSendable: true }

const STEPS: Step[] = [
  { kind: 'email', key: 'intro', goal: 'Introduce us', variants: null, next: 'pause' },
  { kind: 'wait', key: 'pause', waitHours: 48, next: 'check' },
  {
    kind: 'branch',
    key: 'check',
    arms: [{ condition: { kind: 'no_response', afterHours: 24 }, next: 'bye' }],
    default: 'bye',
  },
  { kind: 'end', key: 'bye' },
]

async function world(steps: Step[] = STEPS) {
  const t = await createTestApp()
  const org = newOrganizationId()
  const owner: TestIdentity = { userId: newUserId(), organizationId: org, role: 'owner' }
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(owner)),
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Body }
  }
  const started = await call('POST', '/v1/mailboxes/connect', { provider: 'gmail' })
  const url = new URL(started.body.authorizationUrl as string)
  await call('POST', '/v1/mailboxes/connect/complete', {
    state: url.searchParams.get('state'),
    code: url.searchParams.get('code'),
  })
  const made = await call('POST', '/v1/campaigns', {
    name: 'Q3',
    goal: 'Book calls',
    audience: { kind: 'filter', status: 'active' },
    sendWindow: { timeZone: 'UTC', days: ['mon'], startMinute: 540, endMinute: 1020 },
    dailyCap: 50,
  })
  const campaignId = made.body.id as CampaignId
  await call('PUT', `/v1/campaigns/${campaignId}/sequence`, { expectedVersion: 0, steps })
  const setCampaign = (patch: Record<string, unknown>) =>
    t.deps.campaigns.store.modify(org, campaignId, (c) => ({ ...c, ...patch }))
  await setCampaign({ state: 'running', sendWindow: OPEN, approvalMode: 'auto' })
  t.deps.engineDrafts.make = () => GROUNDED
  const prospect = async () => {
    const id = formatId('prs', crypto.randomUUID()) as ProspectId
    t.deps.core.seed(org, { id, ownerId: owner.userId, values: { email: 'a@b.test' } })
    t.deps.guard.allow({ organizationId: org, prospectId: id }, 'email')
    t.deps.engineContacts.set(org, id, { email: 'a@b.test', verified: true, timeZone: null })
    const reply = await call('POST', `/v1/campaigns/${campaignId}/enrollments`, {
      prospectIds: [id],
    })
    const enrollmentId = ((reply.body.results as Body[])[0]?.enrollmentId ?? '') as EnrollmentId
    return { id, enrollmentId }
  }
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      if ((await t.deps.consumer.pollOnce()) === 0) {
        return
      }
    }
  }
  const tick = async () => {
    const queued = await sweep(t.deps.engine)
    await drain()
    return queued
  }
  const get = async (id: EnrollmentId) => {
    const found = await t.deps.engine.enrollments.find(org, id)
    if (found === null) {
      throw new Error('missing enrollment')
    }
    return found
  }
  const sent = () => t.deps.mail.accepted().length
  // Monday 10:00 UTC, inside the window.
  const monday = new Date('2026-11-02T10:00:00Z').getTime()
  t.deps.clock.advance(`${Math.max(0, monday - t.deps.clock.now().getTime())}ms`)
  return { t, org, call, campaignId, setCampaign, prospect, tick, get, sent, drain }
}

describe('engine', () => {
  test('a due Step sends once, and a repeated sweep or message does not send twice', async () => {
    const w = await world()
    const p = await w.prospect()
    expect(await w.tick()).toBe(1)
    expect(w.sent()).toBe(1)
    expect((await w.get(p.enrollmentId)).currentStepKey).toBe('pause')
    expect(await w.tick()).toBe(1) // the wait Step, not another send
    expect(await w.tick()).toBe(0)
    await runStep(w.t.deps.engine, w.org, {
      enrollmentId: p.enrollmentId,
      stepKey: 'intro',
      attemptEpoch: 0,
    })
    expect(w.sent()).toBe(1)
  })

  test("a Step with a test drafts and sends the Prospect's variant, and a promoted winner replaces the split", async () => {
    const variants = [
      { key: 'a', label: 'Story', angle: 'Lead with a story', weight: 50 },
      { key: 'b', label: 'Number', angle: 'Lead with a number', weight: 50 },
    ]
    const steps = STEPS.map((s) =>
      s.key === 'intro' && s.kind === 'email'
        ? { ...s, variants: { variants, promotion: { mode: 'manual' as const } } }
        : s
    )
    const w = await world(steps)
    const asked: unknown[] = []
    w.t.deps.engineDrafts.make = (request) => {
      asked.push(request.variant)
      return GROUNDED
    }
    for (let i = 0; i < 3; i++) {
      const p = await w.prospect()
      w.t.deps.clock.advance('24h')
      await w.tick()
      const log = await w.t.deps.engine.enrollments.activity(w.org, p.enrollmentId, null, 10)
      const sent = log.items.find((e) => e.kind === 'sent')
      const expected = assignVariant(
        { prospectId: p.id, campaignId: w.campaignId, stepKey: 'intro' },
        variants,
        null
      )
      expect(sent?.variantKey).toBe(expected.key)
      expect(asked.at(-1)).toEqual({ key: expected.key, angle: expected.angle })
    }
    const promoted = await w.call(
      'POST',
      `/v1/campaigns/${w.campaignId}/steps/intro/variants/b/promote`
    )
    expect(promoted.status).toBe(200)
    const later = await w.prospect()
    w.t.deps.clock.advance('24h')
    await w.tick()
    const log = await w.t.deps.engine.enrollments.activity(w.org, later.enrollmentId, null, 10)
    expect(log.items.find((e) => e.kind === 'sent')?.variantKey).toBe('b')
  })

  test('a wait holds until its time, then the branch completes the Enrollment', async () => {
    const w = await world()
    const p = await w.prospect()
    await w.tick()
    await w.tick()
    w.t.deps.clock.advance('47h')
    expect(await w.tick()).toBe(0)
    w.t.deps.clock.advance('2h')
    await w.tick()
    await w.tick()
    expect((await w.get(p.enrollmentId)).state).toBe('completed')
    expect(w.sent()).toBe(1)
  })

  test.each(['replied', 'hard_bounce', 'unsubscribed'] as const)(
    '%s stops the Enrollment before the next send',
    async (reason) => {
      const w = await world()
      const p = await w.prospect()
      await stopForProspect(w.t.deps.engine, w.org, p.id, reason)
      expect(await w.tick()).toBe(0)
      expect(w.sent()).toBe(0)
      expect(await w.get(p.enrollmentId)).toMatchObject({ state: 'stopped', stopReason: reason })
    }
  )

  test('a suppression added after enrolling stops the Enrollment at the Contact Check', async () => {
    const w = await world()
    const p = await w.prospect()
    w.t.deps.guard.deny({ organizationId: w.org, prospectId: p.id }, 'email', 'consent.suppressed')
    await w.tick()
    expect(w.sent()).toBe(0)
    expect((await w.get(p.enrollmentId)).state).toBe('stopped')
  })

  test('a send outside the window defers to the next window; a paused Campaign sends nothing', async () => {
    const w = await world()
    await w.setCampaign({
      sendWindow: { timeZone: 'UTC', days: ['tue'], startMinute: 540, endMinute: 1020 },
    })
    const p = await w.prospect()
    await w.tick()
    expect(w.sent()).toBe(0)
    const held = await w.get(p.enrollmentId)
    expect(held.currentStepKey).toBe('intro')
    expect(Date.parse(held.nextDueAt ?? '')).toBe(Date.parse('2026-11-03T09:00:00Z'))
    await w.setCampaign({ state: 'paused', sendWindow: OPEN })
    w.t.deps.clock.advance('24h')
    await w.tick()
    expect(w.sent()).toBe(0)
    expect(Date.parse((await w.get(p.enrollmentId)).nextDueAt ?? '')).toBe(
      w.t.deps.clock.now().getTime() + PAUSED_RECHECK_MS
    )
  })

  test('an ungrounded or failing Draft goes to approvals even in auto mode; review mode always does', async () => {
    const w = await world()
    const ungrounded = await w.prospect()
    w.t.deps.engineDrafts.make = () => ({ ungrounded: true, autoSendable: true })
    await w.tick()
    const failing = await w.prospect()
    w.t.deps.engineDrafts.make = () => ({ ungrounded: false, autoSendable: false })
    await w.tick()
    await w.setCampaign({ approvalMode: 'review' })
    const review = await w.prospect()
    w.t.deps.engineDrafts.make = () => GROUNDED
    await w.tick()
    expect(w.sent()).toBe(0)
    const reasons = w.t.deps.engineApprovals.requested.map((r) => [r.enrollmentId, r.reasons])
    expect(reasons).toContainEqual([ungrounded.enrollmentId, ['ungrounded']])
    expect(reasons).toContainEqual([failing.enrollmentId, ['check_failed']])
    expect(reasons).toContainEqual([review.enrollmentId, ['review_mode']])
  })

  test('a sweep for one Organization never touches another Organization', async () => {
    const w = await world()
    const p = await w.prospect()
    const other = newOrganizationId() as OrganizationId
    const page = await w.t.deps.engine.enrollments.claimDue(
      other,
      w.t.deps.clock.now().toISOString(),
      new Date(w.t.deps.clock.now().getTime() + 1000).toISOString(),
      10
    )
    expect(page).toEqual([])
    expect((await w.get(p.enrollmentId)).nextDueAt).not.toBeNull()
    expect(await w.tick()).toBe(1)
  })

  test('a Prospect with no known address is held and retried, never stopped', async () => {
    const w = await world()
    const p = await w.prospect()
    w.t.deps.engineContacts.clear(w.org, p.id)
    await w.tick()
    const held = await w.get(p.enrollmentId)
    expect(held).toMatchObject({ state: 'active', currentStepKey: 'intro' })
    expect(Date.parse(held.nextDueAt ?? '')).toBe(w.t.deps.clock.now().getTime() + RETRY_MS)
    expect(w.sent()).toBe(0)
  })

  test('a sweep starts at a random place and wraps, so a backlog cannot starve later Organizations', async () => {
    const w = await world()
    const ids = Array.from(
      { length: 12 },
      (_, i) => `org_${(i + 1).toString(16).padStart(8, '0')}${'0'.repeat(24)}`
    )
    const claimed: string[] = []
    const enrollments = {
      ...w.t.deps.engine.enrollments,
      dueOrganizations: async (after: string | null, batch: number) => {
        const rest = ids.filter((id) => after === null || id > after)
        const page = rest.slice(0, batch)
        return {
          organizationIds: page as OrganizationId[],
          next: rest.length > batch ? (page[page.length - 1] ?? null) : null,
        }
      },
      claimDue: async (organizationId: OrganizationId) => {
        claimed.push(organizationId)
        return []
      },
    }
    // Lands after the 8th Organization: 9..12 first, then the walk wraps to 1.. for the rest of the pages.
    const random = () => 8 / 2 ** 32
    await sweep({
      ...w.t.deps.engine,
      enrollments,
      random,
      limits: { orgBatch: 1, stepPage: 1, leaseSeconds: 600 },
    })
    expect(claimed).toContain(ids[11] as string)
    expect(claimed).toContain(ids[0] as string)
  })
})
