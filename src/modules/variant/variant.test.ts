import { describe, expect, test } from 'bun:test'
import {
  type CampaignId,
  type Enrollment,
  type EnrollmentEvent,
  type EnrollmentStopReason,
  formatId,
  type OrganizationId,
  type ProspectId,
  type Step,
  type Variant,
} from 'tula-closeline-contract'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'
import { assignVariant } from './assign'
import { clearWinner, measure, wilson } from './stats'

type Body = Record<string, unknown>

const VARIANTS: Variant[] = [
  { key: 'a', label: 'Story', angle: 'Lead with a customer story', weight: 50 },
  { key: 'b', label: 'Number', angle: 'Lead with a number', weight: 30 },
  { key: 'c', label: 'Question', angle: 'Lead with a question', weight: 20 },
]

const PAIR: Variant[] = [
  { key: 'a', label: 'Story', angle: 'Lead with a customer story', weight: 50 },
  { key: 'b', label: 'Number', angle: 'Lead with a number', weight: 50 },
]

const prospectId = (): ProspectId => formatId('prs', crypto.randomUUID()) as ProspectId
const campaignId = formatId('cpg', crypto.randomUUID()) as CampaignId

describe('assignVariant', () => {
  test('the same Prospect always gets the same variant', () => {
    const key = { prospectId: prospectId(), campaignId, stepKey: 'intro' }
    const first = assignVariant(key, VARIANTS, null)
    for (let i = 0; i < 50; i++) {
      expect(assignVariant({ ...key }, VARIANTS, null).key).toBe(first.key)
    }
  })

  test('the observed split follows the weights on a large audience', () => {
    const seen = new Map<string, number>()
    const total = 20_000
    for (let i = 0; i < total; i++) {
      const v = assignVariant(
        { prospectId: prospectId(), campaignId, stepKey: 'intro' },
        VARIANTS,
        null
      )
      seen.set(v.key, (seen.get(v.key) ?? 0) + 1)
    }
    for (const variant of VARIANTS) {
      const share = ((seen.get(variant.key) ?? 0) / total) * 100
      expect(Math.abs(share - variant.weight)).toBeLessThan(1.5)
    }
  })

  test('a promoted variant goes to everyone; an unknown promoted key is ignored', () => {
    for (let i = 0; i < 100; i++) {
      const key = { prospectId: prospectId(), campaignId, stepKey: 'intro' }
      expect(assignVariant(key, VARIANTS, 'c').key).toBe('c')
    }
    const key = { prospectId: prospectId(), campaignId, stepKey: 'intro' }
    expect(assignVariant(key, VARIANTS, 'gone').key).toBe(assignVariant(key, VARIANTS, null).key)
  })
})

describe('stats', () => {
  test('the Wilson interval brackets the estimate and stays inside 0..1', () => {
    for (const [hits, n] of [
      [0, 100],
      [100, 100],
      [7, 100],
      [1, 1],
    ] as const) {
      const r = wilson(hits, n)
      expect(r.lower).toBeGreaterThanOrEqual(0)
      expect(r.upper).toBeLessThanOrEqual(1)
      expect(r.lower).toBeLessThanOrEqual(r.estimate)
      expect(r.upper).toBeGreaterThanOrEqual(r.estimate)
    }
    expect(wilson(10, 100).estimate).toBeCloseTo(0.1)
  })

  const group = (min?: number) => ({
    variants: PAIR,
    promotion:
      min === undefined
        ? ({ mode: 'manual' } as const)
        : ({ mode: 'auto', minSamplePerVariant: min, marginPercentagePoints: 5 } as const),
  })
  const count = (variantKey: string, sent: number, replied: number) => ({
    variantKey,
    sent,
    replied,
    bounced: 0,
    unsubscribed: 0,
  })

  test('below the minimum sample the status is not_enough_data and there are no rates', () => {
    const m = measure(group(), [count('a', 99, 50), count('b', 500, 10)])
    expect(m.status).toBe('not_enough_data')
    expect(m.minimumSample).toBe(100)
    expect(m.variants.every((v) => v.replyRate === null)).toBe(true)
  })

  test('at the minimum sample every variant has a rate with an interval', () => {
    const m = measure(group(200), [count('a', 200, 40), count('b', 250, 10)])
    expect(m.status).toBe('measured')
    expect(m.variants[0]?.replyRate?.estimate).toBeCloseTo(0.2)
  })

  test('a winner needs the margin over every other variant', () => {
    const rows = (a: number, b: number) =>
      measure(group(100), [count('a', 100, a), count('b', 100, b)]).variants
    expect(clearWinner(rows(20, 15), 5)).toBe('a')
    expect(clearWinner(rows(19, 15), 5)).toBeNull()
    expect(
      clearWinner(measure(group(100), [count('a', 99, 99), count('b', 100, 0)]).variants, 5)
    ).toBeNull()
  })
})

const SEQUENCE = (promotion: Record<string, unknown>): Step[] => [
  {
    kind: 'email',
    key: 'intro',
    goal: 'Introduce us',
    variants: { variants: PAIR, promotion },
    next: 'bye',
  } as Step,
  { kind: 'end', key: 'bye' },
]

async function world(promotion: Record<string, unknown> = { mode: 'manual' }) {
  const t = await createTestApp()
  const org = newOrganizationId()
  const as = (role: TestIdentity['role'], organizationId: OrganizationId = org): TestIdentity => ({
    userId: newUserId(),
    organizationId,
    role,
  })
  const owner = as('owner')
  const call = async (who: TestIdentity, method: string, path: string, body?: unknown) => {
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(who)),
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Body }
  }
  const made = await call(owner, 'POST', '/v1/campaigns', {
    name: 'Q3',
    goal: 'Book calls',
    audience: { kind: 'filter', status: 'active' },
    sendWindow: { timeZone: 'UTC', days: ['mon'], startMinute: 540, endMinute: 1020 },
    dailyCap: 50,
  })
  const id = made.body.id as CampaignId
  const saved = await call(owner, 'PUT', `/v1/campaigns/${id}/sequence`, {
    expectedVersion: 0,
    steps: SEQUENCE(promotion),
  })
  expect(saved.status).toBe(200)
  const results = (who = owner) => call(who, 'GET', `/v1/campaigns/${id}/steps/intro/variants`)
  const promote = (variantKey: string, who = owner, step = 'intro') =>
    call(who, 'POST', `/v1/campaigns/${id}/steps/${step}/variants/${variantKey}/promote`)
  /** Records `n` sends of a variant; the first `replied` of them ended in a reply. */
  const seed = async (
    variantKey: string,
    n: number,
    replied: number,
    stop?: EnrollmentStopReason
  ) => {
    for (let i = 0; i < n; i++) {
      const enrollmentId = formatId('enr', crypto.randomUUID()) as Enrollment['id']
      const at = t.deps.clock.now().toISOString()
      const reason = i < replied ? 'replied' : (stop ?? null)
      const enrollment: Enrollment = {
        id: enrollmentId,
        campaignId: id,
        prospectId: prospectId(),
        state: reason === null ? 'completed' : 'stopped',
        stopReason: reason,
        currentStepKey: null,
        currentStep: null,
        attemptEpoch: 0,
        nextDueAt: null,
        enrolledAt: at,
        stoppedAt: reason === null ? null : at,
        completedAt: reason === null ? at : null,
      }
      const sent: EnrollmentEvent = {
        id: formatId('eev', crypto.randomUUID()) as EnrollmentEvent['id'],
        enrollmentId,
        kind: 'sent',
        stepKey: 'intro',
        variantKey,
        sendId: null,
        stopReason: null,
        actorMembershipId: null,
        occurredAt: at,
      }
      await t.deps.engine.enrollments.insertIfAbsent(org, enrollment, [sent])
    }
  }
  return { t, org, owner, as, call, id, results, promote, seed }
}

const code = (b: Body) => (b.error as { code: string }).code

describe('variant routes', () => {
  test('results say not_enough_data below the sample, then the rates with an interval', async () => {
    const w = await world()
    await w.seed('a', 99, 30)
    await w.seed('b', 100, 5)
    const early = await w.results()
    expect(early.status).toBe(200)
    expect(early.body.status).toBe('not_enough_data')
    expect(early.body.minimumSample).toBe(100)
    await w.seed('a', 1, 0)
    const done = await w.results()
    expect(done.body.status).toBe('measured')
    const rows = done.body.variants as {
      key: string
      sent: number
      replyRate: { lower: number; upper: number }
    }[]
    expect(rows.map((r) => [r.key, r.sent])).toEqual([
      ['a', 100],
      ['b', 100],
    ])
    expect(rows[0]?.replyRate.lower).toBeLessThan(0.3)
    expect(rows[0]?.replyRate.upper).toBeGreaterThan(0.3)
  })

  test('a Step without a test is variant.not_found', async () => {
    const w = await world()
    const none = await w.call(w.owner, 'GET', `/v1/campaigns/${w.id}/steps/bye/variants`)
    expect(none.status).toBe(404)
    expect(code(none.body)).toBe('variant.not_found')
    expect(code((await w.promote('a', w.owner, 'bye')).body)).toBe('variant.not_found')
    expect(code((await w.promote('zzz')).body)).toBe('variant.not_found')
  })

  test('a manual promotion is audited once; the same variant again changes nothing', async () => {
    const w = await world()
    const first = await w.promote('b')
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ variantKey: 'b', source: 'manual' })
    const again = await w.promote('b')
    expect(again.status).toBe(200)
    expect(again.body.promotedAt).toBe(first.body.promotedAt)
    expect(w.t.deps.logLines.filter((l) => l.includes('variant.promoted'))).toHaveLength(1)
    const other = await w.promote('a')
    expect(other.status).toBe(409)
    expect(code(other.body)).toBe('variant.already_promoted')
    expect((await w.results()).body.promotion).toMatchObject({ variantKey: 'b' })
  })

  test('only an Owner or Admin promotes; a Rep reads results but cannot promote', async () => {
    const w = await world()
    const rep = w.as('rep')
    expect(code((await w.promote('a', rep)).body)).toBe('auth.forbidden')
    expect(w.t.deps.logLines.filter((l) => l.includes('variant.promoted'))).toHaveLength(0)
    expect((await w.promote('a', w.as('admin'))).status).toBe(200)
  })

  test('another Organization sees neither the results nor a promotion', async () => {
    const w = await world()
    const stranger = w.as('owner', newOrganizationId())
    expect((await w.results(stranger)).status).toBe(404)
    expect((await w.promote('a', stranger)).status).toBe(404)
    expect((await w.results()).body.promotion).toBeNull()
  })
})

describe('automatic promotion', () => {
  const auto = { mode: 'auto', minSamplePerVariant: 100, marginPercentagePoints: 5 }

  test('nothing is promoted below the sample, even with a huge gap', async () => {
    const w = await world(auto)
    await w.seed('a', 99, 90)
    await w.seed('b', 100, 0)
    expect((await w.results()).body.promotion).toBeNull()
  })

  test('nothing is promoted when the lead is inside the margin', async () => {
    const w = await world(auto)
    await w.seed('a', 100, 19)
    await w.seed('b', 100, 15)
    const r = await w.results()
    expect(r.body.status).toBe('measured')
    expect(r.body.promotion).toBeNull()
  })

  test('a clear winner at the sample is promoted once and logged', async () => {
    const w = await world(auto)
    await w.seed('a', 100, 10)
    await w.seed('b', 100, 25)
    const r = await w.results()
    expect(r.body.promotion).toMatchObject({ variantKey: 'b', source: 'auto' })
    await w.results()
    const lines = w.t.deps.logLines.filter((l) => l.includes('variant.promoted'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"mode":"auto"')
    expect(code((await w.promote('a')).body)).toBe('variant.already_promoted')
  })
})
