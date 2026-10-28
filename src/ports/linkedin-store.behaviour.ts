import { describe, expect, test } from 'bun:test'
import {
  formatId,
  LINKEDIN_RISK_WORDING_VERSION,
  type LinkedinAccountId,
  type LinkedinRiskAcceptanceId,
  type MembershipId,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { LinkedinAccountRecord, LinkedinStore } from './linkedin-store'

/** A store under test plus the way an implementation sets the channel up (the risk tickets own it in production). */
export type LinkedinStoreHarness = {
  store: LinkedinStore
  seedChannel: (
    organizationId: OrganizationId,
    state: { enabled: boolean; acceptedVersion: string | null }
  ) => Promise<void>
}

const org = () => formatId('org', crypto.randomUUID()) as OrganizationId

/** A LinkedIn account record for tests; override any field. */
export function newLinkedinRecord(
  overrides: Partial<LinkedinAccountRecord> = {}
): LinkedinAccountRecord {
  return {
    id: formatId('lia', crypto.randomUUID()) as LinkedinAccountId,
    membershipId: formatId('mem', crypto.randomUUID()) as MembershipId,
    providerAccountId: `ref-${crypto.randomUUID()}`,
    status: 'connected',
    pauseReason: null,
    limits: { dailyConnections: 20, dailyMessages: 40, weeklyConnections: 80 },
    connectedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** The behaviour every {@link LinkedinStore} has, run against each implementation. */
export function describeLinkedinStore(label: string, make: () => LinkedinStoreHarness) {
  describe(`linkedin store (${label})`, () => {
    test('connects, finds and keeps another Organization out', async () => {
      const { store } = make()
      const a = org()
      const record = await store.connect(a, newLinkedinRecord())
      expect((await store.find(a, record.id))?.providerAccountId).toBe(record.providerAccountId)
      expect(await store.find(org(), record.id)).toBeNull()
    })

    test('a reconnect reuses the row, its id and its limits', async () => {
      const { store } = make()
      const a = org()
      const first = await store.connect(
        a,
        newLinkedinRecord({
          limits: { dailyConnections: 5, dailyMessages: 6, weeklyConnections: 7 },
        })
      )
      await store.disconnect(a, first.id, '2026-02-01T00:00:00.000Z')
      const again = await store.connect(
        a,
        newLinkedinRecord({ membershipId: first.membershipId, providerAccountId: 'ref-new' })
      )
      expect(again.id).toBe(first.id)
      expect(again.status).toBe('connected')
      expect(again.providerAccountId).toBe('ref-new')
      expect(again.limits.dailyConnections).toBe(5)
    })

    test('disconnect changes once and is a no-op after', async () => {
      const { store } = make()
      const a = org()
      const record = await store.connect(a, newLinkedinRecord())
      const first = await store.disconnect(a, record.id, '2026-02-01T00:00:00.000Z')
      expect(first?.changed).toBe(true)
      expect(first?.record.status).toBe('disconnected')
      const second = await store.disconnect(a, record.id, '2026-03-01T00:00:00.000Z')
      expect(second?.changed).toBe(false)
      expect(await store.disconnect(org(), record.id, '2026-03-01T00:00:00.000Z')).toBeNull()
    })

    test('lists newest first by cursor and only the visible owners', async () => {
      const { store } = make()
      const a = org()
      const records: LinkedinAccountRecord[] = []
      for (let i = 0; i < 5; i++) {
        records.push(
          await store.connect(
            a,
            newLinkedinRecord({ connectedAt: `2026-01-0${i + 1}T00:00:00.000Z` })
          )
        )
      }
      const first = await store.list(a, undefined, null, 2)
      expect(first.items.map((r) => r.id)).toEqual([records[4]?.id, records[3]?.id] as never)
      expect(first.next).not.toBeNull()
      const second = await store.list(a, undefined, first.next, 2)
      expect(second.items.map((r) => r.id)).toEqual([records[2]?.id, records[1]?.id] as never)
      const last = await store.list(a, undefined, second.next, 2)
      expect(last.items.map((r) => r.id)).toEqual([records[0]?.id] as never)
      expect(last.next).toBeNull()
      const mine = await store.list(a, [records[1]?.membershipId as MembershipId], null, 10)
      expect(mine.items.map((r) => r.id)).toEqual([records[1]?.id] as never)
      expect((await store.list(a, [], null, 10)).items).toEqual([])
      expect((await store.list(org(), undefined, null, 10)).items).toEqual([])
    })

    test('the channel is off and unaccepted until set, per Organization', async () => {
      const { store, seedChannel } = make()
      const a = org()
      expect(await store.channelState(a, LINKEDIN_RISK_WORDING_VERSION)).toEqual({
        enabled: false,
        accepted: false,
      })
      await seedChannel(a, { enabled: true, acceptedVersion: LINKEDIN_RISK_WORDING_VERSION })
      expect(await store.channelState(a, LINKEDIN_RISK_WORDING_VERSION)).toEqual({
        enabled: true,
        accepted: true,
      })
      await seedChannel(a, { enabled: true, acceptedVersion: 'older' })
      expect((await store.channelState(a, LINKEDIN_RISK_WORDING_VERSION)).accepted).toBe(false)
      expect(await store.channelState(org(), LINKEDIN_RISK_WORDING_VERSION)).toEqual({
        enabled: false,
        accepted: false,
      })
    })

    const acceptance = (at: string) => ({
      id: formatId('lra', crypto.randomUUID()) as LinkedinRiskAcceptanceId,
      wordingVersion: LINKEDIN_RISK_WORDING_VERSION,
      acceptedByMembershipId: formatId('mem', crypto.randomUUID()) as MembershipId,
      typedFullName: 'Ada Admin',
      acceptedAt: at,
      revokedAt: null,
    })

    test('acceptances: one active per version, revoke keeps history, per Organization', async () => {
      const { store } = make()
      const a = org()
      const first = await store.acceptRisk(a, acceptance('2026-01-01T00:00:00.000Z'))
      expect(first.created).toBe(true)
      const repeat = await store.acceptRisk(a, acceptance('2026-01-02T00:00:00.000Z'))
      expect(repeat).toEqual({ record: first.record, created: false })
      expect(await store.activeAcceptance(org(), LINKEDIN_RISK_WORDING_VERSION)).toBeNull()
      expect(await store.revokeRisk(org(), '2026-01-03T00:00:00.000Z')).toBe(0)
      expect(await store.revokeRisk(a, '2026-01-03T00:00:00.000Z')).toBe(1)
      expect(await store.revokeRisk(a, '2026-01-04T00:00:00.000Z')).toBe(0)
      expect(await store.activeAcceptance(a, LINKEDIN_RISK_WORDING_VERSION)).toBeNull()
      const again = await store.acceptRisk(a, acceptance('2026-01-05T00:00:00.000Z'))
      expect(again.created).toBe(true)
      const page = await store.listAcceptances(a, null, 1)
      expect(page.items[0]?.id).toBe(again.record.id)
      const rest = await store.listAcceptances(a, page.next, 5)
      expect(rest.items.map((r) => r.id)).toEqual([first.record.id])
      expect(rest.items[0]?.revokedAt).toBe('2026-01-03T00:00:00.000Z')
      expect(rest.next).toBeNull()
      expect((await store.listAcceptances(org(), null, 5)).items).toEqual([])
    })

    test('concurrent accepts record one', async () => {
      const { store } = make()
      const a = org()
      const results = await Promise.all(
        [0, 1, 2, 3].map(() => store.acceptRisk(a, acceptance('2026-01-01T00:00:00.000Z')))
      )
      expect(results.filter((r) => r.created).length).toBe(1)
      expect((await store.listAcceptances(a, null, 10)).items.length).toBe(1)
    })

    test('the switch answers what it was', async () => {
      const { store } = make()
      const a = org()
      const by = formatId('mem', crypto.randomUUID()) as MembershipId
      const at = '2026-01-01T00:00:00.000Z'
      expect(await store.setEnabled(a, true, by, at)).toEqual({ previous: false })
      expect(await store.setEnabled(a, false, by, at)).toEqual({ previous: true })
      expect((await store.channelState(a, LINKEDIN_RISK_WORDING_VERSION)).enabled).toBe(false)
      expect((await store.channelState(org(), LINKEDIN_RISK_WORDING_VERSION)).enabled).toBe(false)
    })
    describe('quota', () => {
      const at = '2026-03-10T10:00:00.000Z'
      const day = '2026-03-10'
      const weekStart = '2026-03-09'
      const reserve = (
        store: LinkedinStore,
        organizationId: OrganizationId,
        accountId: LinkedinAccountId,
        sendKey: string,
        kind: 'connection' | 'message' = 'connection'
      ) => store.reserve(organizationId, { accountId, sendKey, kind, day, weekStart, at })

      test('parallel reserves never exceed the daily limit', async () => {
        const { store } = make()
        const a = org()
        const account = await store.connect(a, newLinkedinRecord())
        const results = await Promise.all(
          Array.from({ length: 30 }, (_, i) => reserve(store, a, account.id, `k${i}`))
        )
        expect(results.filter((r) => r.status === 'reserved').length).toBe(20)
        expect(results.filter((r) => r.status === 'over_limit').length).toBe(10)
        expect((await store.usageOf(a, account.id, day, weekStart)).connections).toBe(20)
      })

      test('the same key counts once and answers duplicate', async () => {
        const { store } = make()
        const a = org()
        const account = await store.connect(a, newLinkedinRecord())
        expect(await reserve(store, a, account.id, 'same')).toEqual({ status: 'reserved' })
        expect(await reserve(store, a, account.id, 'same')).toEqual({
          status: 'duplicate',
          state: 'sending',
        })
        await store.markSent(a, 'same', at)
        expect(await reserve(store, a, account.id, 'same')).toEqual({
          status: 'duplicate',
          state: 'sent',
        })
        expect((await store.usageOf(a, account.id, day, weekStart)).connections).toBe(1)
      })

      test('an over-limit reserve leaves no record behind', async () => {
        const { store } = make()
        const a = org()
        const account = await store.connect(
          a,
          newLinkedinRecord({
            limits: { dailyConnections: 1, dailyMessages: 1, weeklyConnections: 5 },
          })
        )
        await reserve(store, a, account.id, 'one')
        expect(await reserve(store, a, account.id, 'two')).toEqual({
          status: 'over_limit',
          limit: 'daily',
        })
        await store.release(a, 'one')
        expect(await reserve(store, a, account.id, 'two')).toEqual({ status: 'reserved' })
      })

      test('the weekly limit counts the days since Monday; messages ignore it', async () => {
        const { store } = make()
        const a = org()
        const account = await store.connect(
          a,
          newLinkedinRecord({
            limits: { dailyConnections: 10, dailyMessages: 10, weeklyConnections: 2 },
          })
        )
        const on = (sendKey: string, d: string) =>
          store.reserve(a, {
            accountId: account.id,
            sendKey,
            kind: 'connection',
            day: d,
            weekStart,
            at,
          })
        expect((await on('m', '2026-03-09')).status).toBe('reserved')
        expect((await on('t', day)).status).toBe('reserved')
        expect(await on('w', day)).toEqual({ status: 'over_limit', limit: 'weekly' })
        expect((await reserve(store, a, account.id, 'msg', 'message')).status).toBe('reserved')
      })

      test('a limit of zero always refuses', async () => {
        const { store } = make()
        const a = org()
        const account = await store.connect(a, newLinkedinRecord())
        await store.setLimits(
          a,
          account.id,
          { dailyConnections: 0, dailyMessages: 0, weeklyConnections: 0 },
          at
        )
        expect((await reserve(store, a, account.id, 'x')).status).toBe('over_limit')
        expect((await reserve(store, a, account.id, 'y', 'message')).status).toBe('over_limit')
      })

      test('another Organization has its own quota and usage', async () => {
        const { store } = make()
        const a = org()
        const b = org()
        const one = { dailyConnections: 1, dailyMessages: 1, weeklyConnections: 1 }
        const accountA = await store.connect(a, newLinkedinRecord({ limits: one }))
        const accountB = await store.connect(b, newLinkedinRecord({ limits: one }))
        expect((await reserve(store, a, accountA.id, 'k')).status).toBe('reserved')
        expect((await reserve(store, b, accountB.id, 'k')).status).toBe('reserved')
        expect((await store.usageOf(b, accountA.id, day, weekStart)).connections).toBe(0)
        expect(await store.lastSendAt(b, accountA.id)).toBeNull()
      })

      test('lastSendAt answers the latest reservation', async () => {
        const { store } = make()
        const a = org()
        const account = await store.connect(a, newLinkedinRecord())
        expect(await store.lastSendAt(a, account.id)).toBeNull()
        await reserve(store, a, account.id, 'k')
        expect(await store.lastSendAt(a, account.id)).toBe(at)
      })

      test('a paused account reserves nothing', async () => {
        const { store } = make()
        const a = org()
        const account = await store.connect(a, newLinkedinRecord())
        await store.pause(a, account.id, 'paused', 'checkpoint', at)
        expect(await reserve(store, a, account.id, 'k1')).toEqual({ status: 'not_connected' })
        expect((await store.usageOf(a, account.id, day, weekStart)).connections).toBe(0)
      })

      test('a sent record is not released', async () => {
        const { store } = make()
        const a = org()
        const account = await store.connect(a, newLinkedinRecord())
        await reserve(store, a, account.id, 'k')
        await store.markSent(a, 'k', at)
        expect(await store.release(a, 'k')).toBe(false)
        expect((await store.usageOf(a, account.id, day, weekStart)).connections).toBe(1)
      })
    })

    test('pause changes a connected account once, and only that account', async () => {
      const { store } = make()
      const a = org()
      const account = await store.connect(a, newLinkedinRecord())
      const other = await store.connect(a, newLinkedinRecord())
      const at = '2026-03-10T10:00:00.000Z'
      const [first, second] = await Promise.all([
        store.pause(a, account.id, 'restricted', 'restricted', at),
        store.pause(a, account.id, 'restricted', 'restricted', at),
      ])
      expect([first, second].filter((r) => r !== null).length).toBe(1)
      expect((await store.find(a, account.id))?.status).toBe('restricted')
      expect((await store.find(a, other.id))?.status).toBe('connected')
      expect(await store.pause(org(), other.id, 'paused', 'checkpoint', at)).toBeNull()
    })

    test('setLimits changes one account in one Organization', async () => {
      const { store } = make()
      const a = org()
      const account = await store.connect(a, newLinkedinRecord())
      const limits = { dailyConnections: 5, dailyMessages: 6, weeklyConnections: 7 }
      expect(
        (await store.setLimits(a, account.id, limits, '2026-03-10T10:00:00.000Z'))?.limits
      ).toEqual(limits)
      expect(
        await store.setLimits(org(), account.id, limits, '2026-03-10T10:00:00.000Z')
      ).toBeNull()
    })
  })
}
