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
  })
}
