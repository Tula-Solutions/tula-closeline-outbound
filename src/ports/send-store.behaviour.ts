import { describe, expect, test } from 'bun:test'
import { formatId, type MailboxId, type OrganizationId } from 'tula-closeline-contract'
import type { NewSend, ReserveLimits, SendStore } from './send-store'

/** What a {@link SendStore} suite needs: the store and a way to make a Mailbox that exists. */
export type SendStoreHarness = {
  store: SendStore
  /** Makes a Mailbox in the Organization (a foreign key in Postgres) and returns its id. */
  mailbox: (organizationId: OrganizationId) => Promise<MailboxId>
}

const DAY = '2026-03-10T00:00:00.000Z'
const HOUR = '2026-03-10T12:00:00.000Z'
const NOW = '2026-03-10T12:30:00.000Z'

/** A send to reserve for a Mailbox; the key is `enrollmentId:step:attemptEpoch`. */
export function newSend(mailboxId: MailboxId | null, overrides: Partial<NewSend> = {}): NewSend {
  const enrollmentId = overrides.enrollmentId ?? formatId('enr', crypto.randomUUID())
  const step = overrides.step ?? 0
  const attemptEpoch = overrides.attemptEpoch ?? 0
  return {
    id: formatId('snd', crypto.randomUUID()),
    key: `${enrollmentId}:${step}:${attemptEpoch}`,
    campaignId: formatId('cpg', crypto.randomUUID()),
    enrollmentId,
    prospectId: formatId('prs', crypto.randomUUID()),
    draftId: null,
    step,
    attemptEpoch,
    mailboxId,
    state: 'sending',
    reason: null,
    checks: [{ check: 'campaign', passed: true }],
    retryAt: null,
    decidedAt: NOW,
    ...overrides,
  }
}

/** Limits that block nothing; override the one a test checks. */
export function openLimits(mailboxId: MailboxId, overrides: Partial<ReserveLimits> = {}) {
  return {
    mailboxId,
    perDay: 100,
    perHour: 100,
    minGapSeconds: 0,
    dayStart: DAY,
    hourStart: HOUR,
    now: NOW,
    organizationDailyCap: 1000,
    ...overrides,
  } satisfies ReserveLimits
}

/** The behaviour every {@link SendStore} must show. Each test uses a fresh Organization. */
export function describeSendStore(label: string, make: () => SendStoreHarness): void {
  const org = () => formatId('org', crypto.randomUUID()) as OrganizationId

  describe(`send store (${label})`, () => {
    test('reserve writes a sending row that find returns, and a repeat is exists', async () => {
      const { store, mailbox } = make()
      const o = org()
      const mbx = await mailbox(o)
      const send = newSend(mbx)
      const first = await store.reserve(o, send, openLimits(mbx))
      expect(first.kind).toBe('reserved')
      expect(await store.find(o, send.key)).toMatchObject({ id: send.id, state: 'sending' })
      const again = await store.reserve(
        o,
        newSend(mbx, { ...send, id: formatId('snd', crypto.randomUUID()) }),
        openLimits(mbx)
      )
      expect(again).toMatchObject({ kind: 'exists', send: { id: send.id } })
    })

    test('a refused or deferred decision is recorded once and a refused one is final', async () => {
      const { store } = make()
      const o = org()
      const refused = newSend(null, {
        state: 'refused',
        reason: 'suppressed',
        checks: [{ check: 'suppression', passed: false }],
      })
      expect((await store.record(o, refused)).kind).toBe('recorded')
      expect(
        (await store.record(o, { ...refused, id: formatId('snd', crypto.randomUUID()) })).kind
      ).toBe('exists')
    })

    test('a deferred row is replaced by the next decision and keeps its id', async () => {
      const { store, mailbox } = make()
      const o = org()
      const mbx = await mailbox(o)
      const deferred = newSend(null, {
        state: 'deferred',
        reason: 'outside_window',
        retryAt: '2026-03-11T14:00:00.000Z',
        checks: [{ check: 'window', passed: false }],
      })
      await store.record(o, deferred)
      const next = await store.reserve(
        o,
        newSend(mbx, {
          ...deferred,
          state: 'sending',
          reason: null,
          retryAt: null,
          mailboxId: mbx,
          id: formatId('snd', crypto.randomUUID()),
        }),
        openLimits(mbx)
      )
      expect(next).toMatchObject({
        kind: 'reserved',
        send: { id: deferred.id, state: 'sending', mailboxId: mbx },
      })
    })

    test('settle moves sending to sent once and then answers null', async () => {
      const { store, mailbox } = make()
      const o = org()
      const mbx = await mailbox(o)
      const send = newSend(mbx)
      await store.reserve(o, send, openLimits(mbx))
      const outcome = {
        state: 'sent' as const,
        at: NOW,
        providerMessageId: 'm1',
        providerThreadId: 't1',
      }
      expect(await store.settle(o, send.id, outcome)).toMatchObject({
        state: 'sent',
        sentAt: NOW,
        providerMessageId: 'm1',
        providerThreadId: 't1',
      })
      expect(await store.settle(o, send.id, { state: 'failed', at: NOW })).toBeNull()
      expect(await store.find(o, send.key)).toMatchObject({ state: 'sent' })
    })

    test('the limits block in order: min gap, per hour, per day, Organization cap', async () => {
      const { store, mailbox } = make()
      const o = org()
      const mbx = await mailbox(o)
      await store.reserve(
        o,
        newSend(mbx, { decidedAt: '2026-03-10T12:29:30.000Z' }),
        openLimits(mbx)
      )
      const blocked = async (limits: Partial<ReserveLimits>) =>
        store.reserve(o, newSend(mbx), openLimits(mbx, limits))
      expect(await blocked({ minGapSeconds: 60 })).toMatchObject({
        kind: 'blocked',
        limit: 'min_gap',
      })
      expect(await blocked({ perHour: 1 })).toMatchObject({ kind: 'blocked', limit: 'per_hour' })
      expect(await blocked({ perDay: 1 })).toMatchObject({ kind: 'blocked', limit: 'per_day' })
      expect(await blocked({ organizationDailyCap: 1 })).toMatchObject({
        kind: 'blocked',
        limit: 'organization_daily_cap',
      })
      expect((await blocked({})).kind).toBe('reserved')
    })

    test('a failed send does not count against a limit', async () => {
      const { store, mailbox } = make()
      const o = org()
      const mbx = await mailbox(o)
      const send = newSend(mbx)
      await store.reserve(o, send, openLimits(mbx, { perDay: 1 }))
      await store.settle(o, send.id, { state: 'failed', at: NOW })
      expect((await store.reserve(o, newSend(mbx), openLimits(mbx, { perDay: 1 }))).kind).toBe(
        'reserved'
      )
    })

    test('parallel reserves never exceed the cap', async () => {
      const { store, mailbox } = make()
      const o = org()
      const mbx = await mailbox(o)
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          store.reserve(o, newSend(mbx), openLimits(mbx, { perDay: 5 }))
        )
      )
      expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(5)
      expect(results.filter((r) => r.kind === 'blocked')).toHaveLength(7)
    })

    test('usage counts sending and sent rows since the day and hour started', async () => {
      const { store, mailbox } = make()
      const o = org()
      const [a, b] = [await mailbox(o), await mailbox(o)]
      await store.reserve(o, newSend(a, { decidedAt: '2026-03-09T23:00:00.000Z' }), openLimits(a))
      await store.reserve(o, newSend(a, { decidedAt: '2026-03-10T11:00:00.000Z' }), openLimits(a))
      await store.reserve(o, newSend(a, { decidedAt: '2026-03-10T12:10:00.000Z' }), openLimits(a))
      await store.reserve(o, newSend(b, { decidedAt: '2026-03-10T12:20:00.000Z' }), openLimits(b))
      const usage = await store.usage(o, [a, b], DAY, HOUR)
      expect(usage.mailboxes[a]).toEqual({
        today: 2,
        thisHour: 1,
        lastAt: '2026-03-10T12:10:00.000Z',
      })
      expect(usage.mailboxes[b]).toMatchObject({ today: 1, thisHour: 1 })
      expect(usage.organizationToday).toBe(3)
    })

    test('lastOfEnrollment is the Mailbox and thread of the latest sent message', async () => {
      const { store, mailbox } = make()
      const o = org()
      const [a, b] = [await mailbox(o), await mailbox(o)]
      const enrollmentId = formatId('enr', crypto.randomUUID())
      expect(await store.lastOfEnrollment(o, enrollmentId)).toBeNull()
      for (const [step, mbx, at] of [
        [0, a, '2026-03-10T12:00:00.000Z'],
        [1, b, '2026-03-10T12:10:00.000Z'],
      ] as const) {
        const send = newSend(mbx, { enrollmentId, step })
        await store.reserve(o, send, openLimits(mbx))
        await store.settle(o, send.id, {
          state: 'sent',
          at,
          providerMessageId: `m${step}`,
          providerThreadId: `t${step}`,
        })
      }
      expect(await store.lastOfEnrollment(o, enrollmentId)).toEqual({
        mailboxId: b,
        providerThreadId: 't1',
      })
    })

    test('findByThread finds the latest sent message of that Mailbox and thread only', async () => {
      const { store, mailbox } = make()
      const o = org()
      const [a, b] = [await mailbox(o), await mailbox(o)]
      const send = newSend(a)
      await store.reserve(o, send, openLimits(a))
      await store.settle(o, send.id, {
        state: 'sent',
        at: '2026-03-10T12:00:00.000Z',
        providerMessageId: 'm1',
        providerThreadId: 'thread-1',
      })
      expect((await store.findByThread(o, a, 'thread-1'))?.id).toBe(send.id)
      expect(await store.findByThread(o, b, 'thread-1')).toBeNull()
      expect(await store.findByThread(o, a, 'thread-2')).toBeNull()
      expect(await store.findByThread(org(), a, 'thread-1')).toBeNull()
    })

    test('listStale returns old sending rows, oldest first, bounded', async () => {
      const { store, mailbox } = make()
      const o = org()
      const mbx = await mailbox(o)
      for (const at of [
        '2026-03-10T10:00:00.000Z',
        '2026-03-10T09:00:00.000Z',
        '2026-03-10T12:25:00.000Z',
      ]) {
        await store.reserve(o, newSend(mbx, { decidedAt: at }), openLimits(mbx))
      }
      const stale = await store.listStale(o, '2026-03-10T12:00:00.000Z', 10)
      expect(stale.map((s) => s.decidedAt)).toEqual([
        '2026-03-10T09:00:00.000Z',
        '2026-03-10T10:00:00.000Z',
      ])
      expect(await store.listStale(o, '2026-03-10T12:00:00.000Z', 1)).toHaveLength(1)
    })

    test('another Organization sees nothing and shares no limit', async () => {
      const { store, mailbox } = make()
      const [o1, o2] = [org(), org()]
      const [m1, m2] = [await mailbox(o1), await mailbox(o2)]
      const send = newSend(m1)
      await store.reserve(o1, send, openLimits(m1))
      expect(await store.find(o2, send.key)).toBeNull()
      expect(await store.listStale(o2, '2027-01-01T00:00:00.000Z', 10)).toEqual([])
      expect((await store.usage(o2, [m2], DAY, HOUR)).organizationToday).toBe(0)
      expect(
        (await store.reserve(o2, newSend(m2), openLimits(m2, { organizationDailyCap: 1 }))).kind
      ).toBe('reserved')
    })
  })
}
