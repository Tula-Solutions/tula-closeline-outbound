import { describe, expect, test } from 'bun:test'
import {
  formatId,
  type MailboxId,
  type MembershipId,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { MailboxRecord, MailboxStore, StoredTokens } from './mailbox-store'

/** A Mailbox record for tests; override any field. */
export function newMailboxRecord(overrides: Partial<MailboxRecord> = {}): MailboxRecord {
  const owner =
    overrides.ownerMembershipId ?? (formatId('mem', crypto.randomUUID()) as MembershipId)
  const at = overrides.connectedAt ?? '2026-01-01T00:00:00.000Z'
  return {
    id: formatId('mbx', crypto.randomUUID()) as MailboxId,
    provider: 'gmail',
    kind: 'personal',
    address: `rep-${crypto.randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Riley Rep',
    providerAccountId: 'sub-1',
    ownerMembershipId: owner,
    teamIds: [],
    state: 'warming',
    stateReason: null,
    stateChangedAt: at,
    limits: {
      perDay: 10,
      perHour: 5,
      minGapSeconds: 60,
      window: {
        timeZone: 'UTC',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        startMinute: 540,
        endMinute: 1020,
      },
    },
    health: { score: null, effect: 'none', scoredAt: null },
    rampStartedAt: at,
    connectedAt: at,
    lastSyncedAt: null,
    ...overrides,
  }
}

/** Sealed tokens for tests. */
export function newStoredTokens(tag = 'a'): StoredTokens {
  return {
    keyId: 'key-1',
    accessToken: new TextEncoder().encode(`access-${tag}`),
    accessTokenExpiresAt: '2026-01-01T01:00:00.000Z',
    refreshToken: new TextEncoder().encode(`refresh-${tag}`),
  }
}

/** The behaviour every {@link MailboxStore} must show. Each test uses a fresh Organization. */
export function describeMailboxStore(label: string, make: () => MailboxStore): void {
  const org = () => formatId('org', crypto.randomUUID()) as OrganizationId

  describe(`MailboxStore: ${label}`, () => {
    test('connect stores the Mailbox and its tokens', async () => {
      const store = make()
      const o = org()
      const record = newMailboxRecord()
      const result = await store.connect(o, record, newStoredTokens())
      expect(result.kind).toBe('connected')
      expect(await store.find(o, record.id)).toEqual(record)
      expect(await store.readTokens(o, record.id)).toEqual(newStoredTokens())
    })

    test('the same address connected twice is already connected', async () => {
      const store = make()
      const o = org()
      const record = newMailboxRecord()
      await store.connect(o, record, newStoredTokens())
      const again = await store.connect(
        o,
        { ...record, id: formatId('mbx', crypto.randomUUID()) as MailboxId },
        newStoredTokens('b')
      )
      expect(again.kind).toBe('already_connected')
      expect(await store.readTokens(o, record.id)).toEqual(newStoredTokens())
    })

    test('finds a Mailbox by its address, in its own Organization only', async () => {
      const store = make()
      const o = org()
      const record = newMailboxRecord()
      await store.connect(o, record, newStoredTokens())
      expect((await store.findByAddress(o, 'gmail', record.address))?.id).toBe(record.id)
      expect(await store.findByAddress(o, 'outlook', record.address)).toBeNull()
      expect(await store.findByAddress(org(), 'gmail', record.address)).toBeNull()
    })

    test('disconnect deletes the tokens, sets the reason, and repeats as a no-op', async () => {
      const store = make()
      const o = org()
      const record = newMailboxRecord()
      await store.connect(o, record, newStoredTokens())
      const first = await store.disconnect(
        o,
        record.id,
        'disconnected_by_owner',
        '2026-01-02T00:00:00.000Z'
      )
      expect(first?.changed).toBe(true)
      expect(first?.record.state).toBe('disconnected')
      expect(first?.record.stateReason).toBe('disconnected_by_owner')
      expect(await store.readTokens(o, record.id)).toBeNull()
      const second = await store.disconnect(
        o,
        record.id,
        'auth_revoked',
        '2026-01-03T00:00:00.000Z'
      )
      expect(second?.changed).toBe(false)
      expect(second?.record.stateReason).toBe('disconnected_by_owner')
      expect(
        await store.disconnect(
          o,
          formatId('mbx', crypto.randomUUID()) as MailboxId,
          'auth_revoked',
          '2026-01-03T00:00:00.000Z'
        )
      ).toBeNull()
    })

    test('tokens are never written back to a disconnected Mailbox', async () => {
      const store = make()
      const o = org()
      const record = newMailboxRecord()
      await store.connect(o, record, newStoredTokens())
      await store.disconnect(o, record.id, 'auth_revoked', '2026-01-02T00:00:00.000Z')
      expect(await store.writeTokens(o, record.id, newStoredTokens('late'))).toBe(false)
      expect(await store.readTokens(o, record.id)).toBeNull()
    })

    test('reconnecting a disconnected address reuses its row and starts fresh', async () => {
      const store = make()
      const o = org()
      const record = newMailboxRecord()
      await store.connect(o, record, newStoredTokens())
      await store.disconnect(o, record.id, 'disconnected_by_owner', '2026-01-02T00:00:00.000Z')
      const again = await store.connect(
        o,
        newMailboxRecord({ address: record.address, connectedAt: '2026-02-01T00:00:00.000Z' }),
        newStoredTokens('b')
      )
      expect(again.kind).toBe('connected')
      if (again.kind === 'connected') {
        expect(again.record.id).toBe(record.id)
        expect(again.record.state).toBe('warming')
        expect(again.record.stateReason).toBeNull()
        expect(again.record.connectedAt).toBe('2026-02-01T00:00:00.000Z')
      }
      expect(await store.readTokens(o, record.id)).toEqual(newStoredTokens('b'))
    })

    test('lists oldest connection first in pages, narrowed by filter and visibility', async () => {
      const store = make()
      const o = org()
      const alice = formatId('mem', crypto.randomUUID()) as MembershipId
      const bob = formatId('mem', crypto.randomUUID()) as MembershipId
      const records = [
        newMailboxRecord({ ownerMembershipId: alice, connectedAt: '2026-01-01T00:00:00.000Z' }),
        newMailboxRecord({ ownerMembershipId: bob, connectedAt: '2026-01-02T00:00:00.000Z' }),
        newMailboxRecord({ ownerMembershipId: alice, connectedAt: '2026-01-03T00:00:00.000Z' }),
        newMailboxRecord({
          kind: 'shared',
          ownerMembershipId: null,
          connectedAt: '2026-01-04T00:00:00.000Z',
        }),
      ]
      for (const record of records) {
        await store.connect(
          o,
          {
            ...record,
            ownerMembershipId: record.kind === 'shared' ? null : record.ownerMembershipId,
          },
          newStoredTokens()
        )
      }
      const page1 = await store.list(o, {}, null, 3)
      expect(page1.items.map((r) => r.id)).toEqual(records.slice(0, 3).map((r) => r.id))
      expect(page1.next).not.toBeNull()
      const page2 = await store.list(o, {}, page1.next, 3)
      expect(page2.items.map((r) => r.id)).toEqual(records.slice(3).map((r) => r.id))
      expect(page2.next).toBeNull()
      const mine = await store.list(o, { visibleOwners: [alice] }, null, 10)
      expect(mine.items.map((r) => r.id)).toEqual(
        records.filter((_, i) => i === 0 || i === 2).map((r) => r.id)
      )
      expect((await store.list(o, { kind: 'shared' }, null, 10)).items).toHaveLength(1)
      expect((await store.list(o, { visibleOwners: [] }, null, 10)).items).toHaveLength(0)
    })

    test('another Organization sees and changes nothing', async () => {
      const store = make()
      const a = org()
      const b = org()
      const record = newMailboxRecord()
      await store.connect(a, record, newStoredTokens())
      expect(await store.find(b, record.id)).toBeNull()
      expect((await store.list(b, {}, null, 10)).items).toEqual([])
      expect(await store.readTokens(b, record.id)).toBeNull()
      expect(await store.writeTokens(b, record.id, newStoredTokens('x'))).toBe(false)
      expect(
        await store.disconnect(b, record.id, 'auth_revoked', '2026-01-02T00:00:00.000Z')
      ).toBeNull()
      expect((await store.find(a, record.id))?.state).toBe('warming')
      // The same address in the other Organization is its own Mailbox.
      const other = await store.connect(
        b,
        newMailboxRecord({ address: record.address }),
        newStoredTokens()
      )
      expect(other.kind).toBe('connected')
    })
  })
}
