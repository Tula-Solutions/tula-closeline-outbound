import { describe, expect, test } from 'bun:test'
import { formatId, LINKEDIN_RISK_WORDING_VERSION, type ProspectId } from 'tula-closeline-contract'
import { newLinkedinRecord } from '~/ports/linkedin-store.behaviour'
import { createTestApp, newOrganizationId } from '~/testing'
import { defaultSendSettings, type LinkedinDeps } from './deps'
import { type LinkedinSendInput, sendJob } from './send'

async function world(open = true) {
  const t = await createTestApp()
  const org = newOrganizationId()
  if (open) {
    t.deps.linkedinStore.setChannel(org, {
      enabled: true,
      acceptedVersions: [LINKEDIN_RISK_WORDING_VERSION],
    })
  }
  // The virtual clock starts at 00:00 UTC; the window opens at 09:00.
  t.deps.time.clock.advance('10h')
  const deps = t.deps.linkedin
  const account = await deps.store.connect(org, newLinkedinRecord())
  const prospect = formatId('prs', crypto.randomUUID()) as ProspectId
  t.deps.guard.allow({ organizationId: org, prospectId: prospect }, 'linkedin')
  const job = (overrides: Partial<LinkedinSendInput> = {}, using: LinkedinDeps = deps) =>
    sendJob(using, {
      organizationId: org,
      accountId: account.id,
      prospectId: prospect,
      kind: 'connection',
      sendKey: crypto.randomUUID(),
      recipient: 'person-ref',
      text: 'hello',
      ...overrides,
    })
  return { t, org, deps, account, prospect, job }
}

describe('linkedin send job', () => {
  test('a send goes out once and is recorded as sent', async () => {
    const w = await world()
    expect(await w.job({ sendKey: 'k1' })).toEqual({ outcome: 'sent' })
    expect(w.t.deps.linkedinProvider.delivered().length).toBe(1)
    expect(
      (await w.deps.store.usageOf(w.org, w.account.id, '2026-01-01', '2025-12-29')).connections
    ).toBe(1)
  })

  test('a retried job sends once', async () => {
    const w = await world()
    await w.job({ sendKey: 'same' })
    expect(await w.job({ sendKey: 'same' })).toEqual({ outcome: 'duplicate', state: 'sent' })
    expect(w.t.deps.linkedinProvider.delivered().length).toBe(1)
    expect(w.t.deps.linkedinProvider.sendCalls()).toBe(1)
  })

  test('the 21st request in a day is deferred to tomorrow, not dropped', async () => {
    const w = await world()
    for (let i = 0; i < 20; i++) {
      expect((await w.job({ sendKey: `k${i}` })).outcome).toBe('sent')
    }
    const late = await w.job({ sendKey: 'k20' })
    expect(late).toEqual({
      outcome: 'deferred',
      reason: 'daily_limit',
      retryAt: '2026-01-02T09:00:00.000Z',
    })
    expect(w.t.deps.linkedinProvider.delivered().length).toBe(20)
    // The deferred job is run again tomorrow with the same key and goes out then.
    w.t.deps.time.clock.advance('24h')
    expect(await w.job({ sendKey: 'k20' })).toEqual({ outcome: 'sent' })
  })

  test('concurrent workers cannot exceed the daily quota', async () => {
    const w = await world()
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => w.job({ sendKey: `p${i}` }))
    )
    expect(results.filter((r) => r.outcome === 'sent').length).toBe(20)
    expect(results.filter((r) => r.outcome === 'deferred').length).toBe(30)
    expect(w.t.deps.linkedinProvider.delivered().length).toBe(20)
  })

  test('messages have their own daily limit', async () => {
    const w = await world()
    for (let i = 0; i < 20; i++) {
      await w.job({ sendKey: `c${i}` })
    }
    expect((await w.job({ kind: 'message', sendKey: 'm1' })).outcome).toBe('sent')
  })

  test('a suppressed Prospect is skipped and uses no quota', async () => {
    const w = await world()
    const target = { organizationId: w.org, prospectId: w.prospect }
    w.t.deps.guard.deny(target, 'linkedin', 'consent.suppressed', 'unsubscribe')
    expect(await w.job()).toEqual({ outcome: 'skipped', reason: 'suppressed' })
    w.t.deps.guard.deny(target, 'linkedin', 'consent.missing')
    expect(await w.job()).toEqual({ outcome: 'skipped', reason: 'no_consent' })
    expect(w.t.deps.linkedinProvider.sendCalls()).toBe(0)
    expect(await w.deps.store.lastSendAt(w.org, w.account.id)).toBeNull()
  })

  test('an unreachable Contact Check skips the send (fails closed)', async () => {
    const w = await world()
    w.t.deps.guard.setUnavailable()
    expect((await w.job()).outcome).toBe('skipped')
    expect(w.t.deps.linkedinProvider.sendCalls()).toBe(0)
  })

  test('a closed channel stops the job; a disconnected account is refused', async () => {
    const closed = await world(false)
    await expect(closed.job()).rejects.toMatchObject({ code: 'linkedin.channel_disabled' })
    const w = await world()
    await w.deps.store.disconnect(w.org, w.account.id, '2026-01-01T10:00:00.000Z')
    await expect(w.job()).rejects.toMatchObject({ code: 'linkedin.account_not_connected' })
  })

  test('outside the window the job waits for the opening', async () => {
    const w = await world()
    w.t.deps.time.clock.advance('8h')
    expect(await w.job()).toEqual({
      outcome: 'deferred',
      reason: 'outside_window',
      retryAt: '2026-01-02T09:00:00.000Z',
    })
    expect(w.t.deps.linkedinProvider.sendCalls()).toBe(0)
  })

  test('two sends of one account keep the minimum gap', async () => {
    const w = await world()
    const spaced = { ...w.deps, send: { ...w.deps.send, minGapMs: 60_000, random: () => 0.5 } }
    expect((await w.job({ sendKey: 'a' }, spaced)).outcome).toBe('sent')
    const next = await w.job({ sendKey: 'b' }, spaced)
    expect(next).toEqual({
      outcome: 'deferred',
      reason: 'min_gap',
      retryAt: '2026-01-01T10:01:00.000Z',
    })
    w.t.deps.time.clock.advance('2m')
    expect((await w.job({ sendKey: 'b' }, spaced)).outcome).toBe('sent')
  })

  test('a restricted result pauses that account only and publishes once', async () => {
    const w = await world()
    const other = await w.deps.store.connect(w.org, newLinkedinRecord())
    w.t.deps.linkedinProvider.script('restricted', 'restricted')
    const results = await Promise.all([w.job({ sendKey: 'r1' }), w.job({ sendKey: 'r2' })])
    expect(results).toEqual([
      { outcome: 'paused', reason: 'restricted' },
      { outcome: 'paused', reason: 'restricted' },
    ])
    expect((await w.deps.store.find(w.org, w.account.id))?.status).toBe('restricted')
    expect((await w.deps.store.find(w.org, other.id))?.status).toBe('connected')
    expect(w.t.deps.linkedinPaused).toEqual([
      {
        organizationId: w.org,
        event: {
          accountId: w.account.id,
          membershipId: w.account.membershipId,
          status: 'restricted',
          reason: 'restricted',
        },
      },
    ])
    // The paused account sends nothing more, and the failed sends gave their quota back.
    await expect(w.job()).rejects.toMatchObject({ code: 'linkedin.account_not_connected' })
    expect(
      (await w.deps.store.usageOf(w.org, w.account.id, '2026-01-01', '2025-12-29')).connections
    ).toBe(0)
  })

  test('a checkpoint or a rate limit pauses the account with its reason', async () => {
    const w = await world()
    w.t.deps.linkedinProvider.script('checkpoint')
    expect(await w.job()).toEqual({ outcome: 'paused', reason: 'checkpoint' })
    expect((await w.deps.store.find(w.org, w.account.id))?.status).toBe('paused')
    const v = await world()
    v.t.deps.linkedinProvider.script('rate_limited')
    expect(await v.job()).toEqual({ outcome: 'paused', reason: 'rate_limited' })
    expect(v.t.deps.linkedinPaused[0]?.event.reason).toBe('rate_limited')
  })

  test('a provider that was not reached is retried a bounded number of times', async () => {
    const w = await world()
    w.t.deps.linkedinProvider.script('unavailable', 'unavailable')
    expect((await w.job({ sendKey: 'x' })).outcome).toBe('sent')
    expect(w.t.deps.linkedinProvider.sendCalls()).toBe(3)

    w.t.deps.linkedinProvider.script('unavailable', 'unavailable', 'unavailable')
    await expect(w.job({ sendKey: 'y' })).rejects.toMatchObject({ code: 'server.unavailable' })
    expect(w.t.deps.linkedinProvider.sendCalls()).toBe(6)
    // The quota was given back and the retried job goes out once the provider is back.
    expect((await w.job({ sendKey: 'y' })).outcome).toBe('sent')
  })

  test('a call that times out is not resent and keeps its quota', async () => {
    const w = await world()
    let calls = 0
    const hanging = {
      ...w.deps,
      provider: {
        ...w.t.deps.linkedinProvider,
        send: () => {
          calls++
          return new Promise<never>(() => {})
        },
      },
      send: { ...w.deps.send, providerTimeoutMs: 10 },
    }
    expect(await w.job({ sendKey: 'slow' }, hanging)).toEqual({ outcome: 'unknown' })
    expect(await w.job({ sendKey: 'slow' }, hanging)).toEqual({
      outcome: 'duplicate',
      state: 'sending',
    })
    expect(calls).toBe(1)
  })

  test('another Organization has its own quota and usage', async () => {
    const a = await world()
    const b = await world()
    for (let i = 0; i < 20; i++) {
      await a.job({ sendKey: `k${i}` })
    }
    expect((await a.job({ sendKey: 'over' })).outcome).toBe('deferred')
    expect((await b.job({ sendKey: 'over' })).outcome).toBe('sent')
    const day = ['2026-01-01', '2025-12-29'] as const
    expect((await b.deps.store.usageOf(b.org, b.account.id, ...day)).connections).toBe(1)
    expect((await b.deps.store.usageOf(a.org, b.account.id, ...day)).connections).toBe(0)
  })

  test('a limit lowered by an Admin is respected', async () => {
    const w = await world()
    await w.deps.store.setLimits(
      w.org,
      w.account.id,
      { dailyConnections: 2, dailyMessages: 10, weeklyConnections: 10 },
      '2026-01-01T10:00:00.000Z'
    )
    await w.job({ sendKey: 'a' })
    await w.job({ sendKey: 'b' })
    expect((await w.job({ sendKey: 'c' })).outcome).toBe('deferred')
  })

  test('a send that passed the checks before a pause does not go out', async () => {
    const w = await world()
    const paused = await w.deps.store.pause(w.org, w.account.id, 'paused', 'checkpoint', 'now')
    expect(paused).not.toBeNull()
    const racing = { ...w.deps, store: { ...w.deps.store, find: async () => w.account } }
    await expect(w.job({ sendKey: 'late' }, racing)).rejects.toMatchObject({
      code: 'linkedin.account_not_connected',
    })
    expect(w.t.deps.linkedinProvider.sendCalls()).toBe(0)
  })

  test('the defaults window sends in daytime UTC', () => {
    expect(defaultSendSettings().window).toEqual({ startHour: 9, endHour: 17 })
  })
})
