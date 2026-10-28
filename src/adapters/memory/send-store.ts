import type { OrganizationId } from 'tula-closeline-contract'
import type { NewSend, ReserveLimits, SendStore, StoredSend } from '~/ports/send-store'

const at = (send: StoredSend) => send.sentAt ?? send.decidedAt

function fresh(send: NewSend, now: string): StoredSend {
  return { ...send, sentAt: null, providerMessageId: null, providerThreadId: null, updatedAt: now }
}

/** The send log in process memory, for tests; it keeps the Postgres adapter's rules. */
export function createMemorySendStore(
  now: () => string = () => new Date().toISOString()
): SendStore {
  const rows = new Map<string, StoredSend>()
  const inOrg = (organizationId: OrganizationId) =>
    [...rows.entries()].filter(([k]) => k.startsWith(`${organizationId}/`)).map(([, v]) => v)
  const slot = (organizationId: OrganizationId, key: string) => `${organizationId}/${key}`
  const counted = (send: StoredSend) => send.state === 'sending' || send.state === 'sent'

  function blockedBy(organizationId: OrganizationId, limits: ReserveLimits) {
    const mine = inOrg(organizationId).filter(counted)
    const own = mine.filter((s) => s.mailboxId === limits.mailboxId)
    const lastAt = own.reduce<string | null>((l, s) => (l === null || at(s) > l ? at(s) : l), null)
    if (
      lastAt !== null &&
      new Date(limits.now).getTime() - new Date(lastAt).getTime() < limits.minGapSeconds * 1000
    ) {
      return { limit: 'min_gap' as const, lastAt }
    }
    if (own.filter((s) => at(s) >= limits.hourStart).length >= limits.perHour) {
      return { limit: 'per_hour' as const, lastAt }
    }
    if (own.filter((s) => at(s) >= limits.dayStart).length >= limits.perDay) {
      return { limit: 'per_day' as const, lastAt }
    }
    if (mine.filter((s) => at(s) >= limits.dayStart).length >= limits.organizationDailyCap) {
      return { limit: 'organization_daily_cap' as const, lastAt }
    }
    return null
  }

  function write(organizationId: OrganizationId, send: NewSend) {
    const existing = rows.get(slot(organizationId, send.key))
    if (existing !== undefined && existing.state !== 'deferred') {
      return { kind: 'exists' as const, send: existing }
    }
    const stored = fresh({ ...send, id: existing?.id ?? send.id }, now())
    rows.set(slot(organizationId, send.key), stored)
    return { kind: 'written' as const, send: stored }
  }

  return {
    async find(organizationId, key) {
      return rows.get(slot(organizationId, key)) ?? null
    },
    async reserve(organizationId, send, limits) {
      const existing = rows.get(slot(organizationId, send.key))
      if (existing !== undefined && existing.state !== 'deferred') {
        return { kind: 'exists', send: existing }
      }
      const blocked = blockedBy(organizationId, limits)
      if (blocked !== null) {
        return { kind: 'blocked', ...blocked }
      }
      return { kind: 'reserved', send: write(organizationId, send).send }
    },
    async record(organizationId, send) {
      const written = write(organizationId, send)
      return { kind: written.kind === 'exists' ? 'exists' : 'recorded', send: written.send }
    },
    async settle(organizationId, id, outcome) {
      const entry = inOrg(organizationId).find((s) => s.id === id)
      if (entry === undefined || entry.state !== 'sending') {
        return null
      }
      const settled: StoredSend =
        outcome.state === 'sent'
          ? {
              ...entry,
              state: 'sent',
              sentAt: outcome.at,
              providerMessageId: outcome.providerMessageId,
              providerThreadId: outcome.providerThreadId,
              updatedAt: outcome.at,
            }
          : { ...entry, state: 'failed', updatedAt: outcome.at }
      rows.set(slot(organizationId, entry.key), settled)
      return settled
    },
    async usage(organizationId, mailboxIds, dayStart, hourStart) {
      const mine = inOrg(organizationId).filter(counted)
      const mailboxes: ReturnType<typeof emptyUsage> = {}
      for (const id of mailboxIds) {
        const own = mine.filter((s) => s.mailboxId === id)
        mailboxes[id] = {
          today: own.filter((s) => at(s) >= dayStart).length,
          thisHour: own.filter((s) => at(s) >= hourStart).length,
          lastAt: own.reduce<string | null>((l, s) => (l === null || at(s) > l ? at(s) : l), null),
        }
      }
      return { mailboxes, organizationToday: mine.filter((s) => at(s) >= dayStart).length }
    },
    async lastOfEnrollment(organizationId, enrollmentId) {
      const last = inOrg(organizationId)
        .filter(
          (s) => s.enrollmentId === enrollmentId && s.state === 'sent' && s.mailboxId !== null
        )
        .sort((a, b) => (at(a) < at(b) ? 1 : -1))[0]
      return last?.mailboxId
        ? { mailboxId: last.mailboxId, providerThreadId: last.providerThreadId }
        : null
    },
    async listStale(organizationId, before, limit) {
      return inOrg(organizationId)
        .filter((s) => s.state === 'sending' && s.decidedAt < before)
        .sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : 1))
        .slice(0, limit)
    },
  }
}

function emptyUsage() {
  return {} as Record<string, { today: number; thisHour: number; lastAt: string | null }>
}
