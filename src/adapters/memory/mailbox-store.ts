import type { MailboxId, OrganizationId } from 'tula-closeline-contract'
import type {
  MailboxFilter,
  MailboxRecord,
  MailboxStore,
  StoredAttempt,
  StoredTestSend,
  StoredTokens,
} from '~/ports/mailbox-store'

type Entry = { record: MailboxRecord; tokens: StoredTokens | null }

function oldestFirst(a: MailboxRecord, b: MailboxRecord): number {
  if (a.connectedAt !== b.connectedAt) {
    return a.connectedAt < b.connectedAt ? -1 : 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function matches(record: MailboxRecord, filter: MailboxFilter): boolean {
  return (
    (filter.visibleOwners === undefined ||
      (record.ownerMembershipId !== null &&
        filter.visibleOwners.includes(record.ownerMembershipId))) &&
    (filter.state === undefined || record.state === filter.state) &&
    (filter.provider === undefined || record.provider === filter.provider) &&
    (filter.kind === undefined || record.kind === filter.kind) &&
    (filter.ownerMembershipId === undefined ||
      record.ownerMembershipId === filter.ownerMembershipId)
  )
}

/** An in-process {@link MailboxStore} for tests and local runs without Postgres. */
export function createMemoryMailboxStore(): MailboxStore {
  const entries = new Map<string, Entry>()
  const attempts = new Map<string, StoredAttempt & { consumedAt: string | null }>()
  const testSends = new Map<string, StoredTestSend>()
  const key = (organizationId: OrganizationId, id: MailboxId) => `${organizationId}/${id}`
  const inOrg = (organizationId: OrganizationId) =>
    [...entries.entries()]
      .filter(([k]) => k.startsWith(`${organizationId}/`))
      .map(([, entry]) => entry)

  return {
    async connect(organizationId, record, tokens) {
      const existing = inOrg(organizationId).find(
        (e) => e.record.provider === record.provider && e.record.address === record.address
      )
      if (existing !== undefined && existing.record.state !== 'disconnected') {
        return { kind: 'already_connected' }
      }
      const stored = { ...record, id: existing?.record.id ?? record.id }
      entries.set(key(organizationId, stored.id), { record: stored, tokens: { ...tokens } })
      return { kind: 'connected', record: stored }
    },

    async find(organizationId, id) {
      return entries.get(key(organizationId, id))?.record ?? null
    },

    async findByAddress(organizationId, provider, address) {
      return (
        inOrg(organizationId).find(
          (e) => e.record.provider === provider && e.record.address === address
        )?.record ?? null
      )
    },

    async list(organizationId, filter, after, limit) {
      const sorted = inOrg(organizationId)
        .map((e) => e.record)
        .filter((r) => matches(r, filter))
        .sort(oldestFirst)
        .filter(
          (r) =>
            after === null ||
            r.connectedAt > after.connectedAt ||
            (r.connectedAt === after.connectedAt && r.id > after.id)
        )
      const items = sorted.slice(0, limit)
      const last = items[items.length - 1]
      return {
        items,
        next:
          sorted.length > limit && last !== undefined
            ? { connectedAt: last.connectedAt, id: last.id }
            : null,
      }
    },

    async readTokens(organizationId, id) {
      return entries.get(key(organizationId, id))?.tokens ?? null
    },

    async writeTokens(organizationId, id, tokens) {
      const entry = entries.get(key(organizationId, id))
      if (entry === undefined || entry.record.state === 'disconnected') {
        return false
      }
      entry.tokens = { ...tokens }
      return true
    },

    async disconnect(organizationId, id, reason, at) {
      const entry = entries.get(key(organizationId, id))
      if (entry === undefined) {
        return null
      }
      if (entry.record.state === 'disconnected') {
        return { record: entry.record, changed: false }
      }
      entry.tokens = null
      entry.record = {
        ...entry.record,
        state: 'disconnected',
        stateReason: reason,
        stateChangedAt: at,
      }
      return { record: entry.record, changed: true }
    },

    async pause(organizationId, id, reason, at) {
      const entry = entries.get(key(organizationId, id))
      if (entry === undefined) {
        return null
      }
      const before = entry.record.state
      if (before === 'paused' || before === 'disconnected') {
        return { record: entry.record, before, changed: false }
      }
      entry.record = { ...entry.record, state: 'paused', stateReason: reason, stateChangedAt: at }
      return { record: entry.record, before, changed: true }
    },

    async markSynced(organizationId, id, at) {
      const entry = entries.get(key(organizationId, id))
      if (entry !== undefined) {
        entry.record = { ...entry.record, lastSyncedAt: at }
      }
    },

    async registerAttempt(organizationId, attempt) {
      const k = `${organizationId}/${attempt.stateHash}`
      if (!attempts.has(k)) {
        attempts.set(k, { ...attempt, consumedAt: null })
      }
    },

    async consumeAttempt(organizationId, userId, stateHash, at) {
      const attempt = attempts.get(`${organizationId}/${stateHash}`)
      if (
        attempt === undefined ||
        attempt.userId !== userId ||
        attempt.consumedAt !== null ||
        attempt.expiresAt <= at
      ) {
        return false
      }
      attempt.consumedAt = at
      return true
    },

    async countTestSends(organizationId, id, since) {
      return [...testSends.entries()].filter(
        ([k, v]) => k.startsWith(`${organizationId}/${id}/`) && v.sentAt >= since
      ).length
    },

    async claimTestSend(organizationId, id, keyHash, claim) {
      const k = `${organizationId}/${id}/${keyHash}`
      const existing = testSends.get(k)
      if (existing !== undefined) {
        return { claimed: false, existing }
      }
      testSends.set(k, claim)
      return { claimed: true }
    },

    async finishTestSend(organizationId, id, keyHash, marker) {
      const k = `${organizationId}/${id}/${keyHash}`
      const row = testSends.get(k)
      if (row !== undefined) {
        testSends.set(k, { ...row, marker })
      }
    },

    async releaseTestSend(organizationId, id, keyHash) {
      testSends.delete(`${organizationId}/${id}/${keyHash}`)
    },
  }
}
