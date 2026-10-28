import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { MailboxId, SendCheck } from 'tula-closeline-contract'
import { mailMessages } from 'tula-closeline-db/schema'
import type {
  NewSend,
  RecordResult,
  ReserveLimits,
  ReserveResult,
  SendStore,
  StoredSend,
} from '~/ports/send-store'
import type { InOrganization } from './store'

type Row = typeof mailMessages.$inferSelect
type Tx = Parameters<Parameters<InOrganization>[1]>[0]

const iso = (value: Date | null) => value?.toISOString() ?? null
const dateOrNull = (value: string | null) => (value === null ? null : new Date(value))
const stamp = sql`coalesce(${mailMessages.sentAt}, ${mailMessages.decidedAt})`

function storedOf(row: Row): StoredSend {
  return {
    id: row.id as StoredSend['id'],
    key: row.sendKey,
    campaignId: row.campaignId as StoredSend['campaignId'],
    enrollmentId: row.enrollmentId as StoredSend['enrollmentId'],
    prospectId: row.prospectId as StoredSend['prospectId'],
    draftId: row.draftId as StoredSend['draftId'],
    step: row.step,
    attemptEpoch: row.attemptEpoch,
    mailboxId: row.mailboxId as StoredSend['mailboxId'],
    state: row.state,
    reason: row.reason,
    checks: row.checks as { check: SendCheck; passed: boolean }[],
    retryAt: iso(row.retryAt),
    decidedAt: row.decidedAt.toISOString(),
    sentAt: iso(row.sentAt),
    providerMessageId: row.providerMessageId,
    providerThreadId: row.providerThreadId,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function valuesOf(organizationId: string, send: NewSend) {
  return {
    id: send.id,
    organizationId,
    campaignId: send.campaignId,
    enrollmentId: send.enrollmentId,
    prospectId: send.prospectId,
    draftId: send.draftId,
    step: send.step,
    attemptEpoch: send.attemptEpoch,
    sendKey: send.key,
    mailboxId: send.mailboxId,
    state: send.state,
    reason: send.reason,
    checks: send.checks,
    retryAt: dateOrNull(send.retryAt),
    decidedAt: new Date(send.decidedAt),
    updatedAt: new Date(send.decidedAt),
  }
}

/** One writer per Organization at a time, so a limit is checked and the row written as one step. */
async function lock(tx: Tx, organizationId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`outbound-send:${organizationId}`}, 0))`
  )
}

async function byKey(tx: Tx, organizationId: string, key: string) {
  const [row] = await tx
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.organizationId, organizationId), eq(mailMessages.sendKey, key)))
  return row
}

/** Writes the decision unless the key already has a settled one; a deferred row is replaced in place. */
async function write(tx: Tx, organizationId: string, send: NewSend) {
  const existing = await byKey(tx, organizationId, send.key)
  if (existing !== undefined && existing.state !== 'deferred') {
    return { written: false as const, row: existing }
  }
  const values = valuesOf(organizationId, send)
  if (existing === undefined) {
    const [row] = await tx.insert(mailMessages).values(values).returning()
    return { written: true as const, row: row as Row }
  }
  const { id: _id, organizationId: _org, ...changes } = values
  const [row] = await tx
    .update(mailMessages)
    .set(changes)
    .where(and(eq(mailMessages.organizationId, organizationId), eq(mailMessages.id, existing.id)))
    .returning()
  return { written: true as const, row: row as Row }
}

/** The send log in Postgres (`outbound.mail_messages`); every call runs in the Organization's transaction. */
export function createPostgresSendStore(inOrganization: InOrganization): SendStore {
  return {
    async find(organizationId, key) {
      const row = await inOrganization(organizationId, (tx) => byKey(tx, organizationId, key))
      return row === undefined ? null : storedOf(row)
    },

    async reserve(organizationId, send, limits: ReserveLimits): Promise<ReserveResult> {
      return inOrganization(organizationId, async (tx) => {
        await lock(tx, organizationId)
        const existing = await byKey(tx, organizationId, send.key)
        if (existing !== undefined && existing.state !== 'deferred') {
          return { kind: 'exists', send: storedOf(existing) }
        }
        const counted = inArray(mailMessages.state, ['sending', 'sent'])
        const [own] = await tx
          .select({
            today: sql<number>`count(*) filter (where ${stamp} >= ${limits.dayStart}::timestamptz)::int`,
            thisHour: sql<number>`count(*) filter (where ${stamp} >= ${limits.hourStart}::timestamptz)::int`,
            lastAt: sql<Date | null>`max(${stamp})`,
          })
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.organizationId, organizationId),
              eq(mailMessages.mailboxId, limits.mailboxId),
              counted
            )
          )
        const [org] = await tx
          .select({
            today: sql<number>`count(*) filter (where ${stamp} >= ${limits.dayStart}::timestamptz)::int`,
          })
          .from(mailMessages)
          .where(and(eq(mailMessages.organizationId, organizationId), counted))
        const lastAt = own?.lastAt == null ? null : new Date(own.lastAt).toISOString()
        const gapMs =
          lastAt === null ? Infinity : new Date(limits.now).getTime() - Date.parse(lastAt)
        const limit =
          gapMs < limits.minGapSeconds * 1000
            ? 'min_gap'
            : (own?.thisHour ?? 0) >= limits.perHour
              ? 'per_hour'
              : (own?.today ?? 0) >= limits.perDay
                ? 'per_day'
                : (org?.today ?? 0) >= limits.organizationDailyCap
                  ? 'organization_daily_cap'
                  : null
        if (limit !== null) {
          return { kind: 'blocked', limit, lastAt }
        }
        const { row } = await write(tx, organizationId, send)
        return { kind: 'reserved', send: storedOf(row) }
      })
    },

    async record(organizationId, send): Promise<RecordResult> {
      return inOrganization(organizationId, async (tx) => {
        await lock(tx, organizationId)
        const { written, row } = await write(tx, organizationId, send)
        return { kind: written ? 'recorded' : 'exists', send: storedOf(row) }
      })
    },

    async settle(organizationId, id, outcome) {
      const [row] = await inOrganization(organizationId, (tx) =>
        tx
          .update(mailMessages)
          .set(
            outcome.state === 'sent'
              ? {
                  state: 'sent',
                  sentAt: new Date(outcome.at),
                  providerMessageId: outcome.providerMessageId,
                  providerThreadId: outcome.providerThreadId,
                  updatedAt: new Date(outcome.at),
                }
              : { state: 'failed', updatedAt: new Date(outcome.at) }
          )
          .where(
            and(
              eq(mailMessages.organizationId, organizationId),
              eq(mailMessages.id, id),
              eq(mailMessages.state, 'sending')
            )
          )
          .returning()
      )
      return row === undefined ? null : storedOf(row)
    },

    async usage(organizationId, mailboxIds, dayStart, hourStart) {
      return inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select({
            mailboxId: mailMessages.mailboxId,
            today: sql<number>`count(*) filter (where ${stamp} >= ${dayStart}::timestamptz)::int`,
            thisHour: sql<number>`count(*) filter (where ${stamp} >= ${hourStart}::timestamptz)::int`,
            lastAt: sql<Date | null>`max(${stamp})`,
          })
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.organizationId, organizationId),
              inArray(mailMessages.state, ['sending', 'sent'])
            )
          )
          .groupBy(mailMessages.mailboxId)
        const mailboxes: Record<
          string,
          { today: number; thisHour: number; lastAt: string | null }
        > = {}
        for (const id of mailboxIds) {
          mailboxes[id] = { today: 0, thisHour: 0, lastAt: null }
        }
        let organizationToday = 0
        for (const row of rows) {
          organizationToday += row.today
          if (row.mailboxId !== null && row.mailboxId in mailboxes) {
            mailboxes[row.mailboxId] = {
              today: row.today,
              thisHour: row.thisHour,
              lastAt: row.lastAt === null ? null : new Date(row.lastAt).toISOString(),
            }
          }
        }
        return { mailboxes, organizationToday }
      })
    },

    async lastOfEnrollment(organizationId, enrollmentId) {
      const [row] = await inOrganization(organizationId, (tx) =>
        tx
          .select()
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.organizationId, organizationId),
              eq(mailMessages.enrollmentId, enrollmentId),
              eq(mailMessages.state, 'sent')
            )
          )
          .orderBy(desc(mailMessages.sentAt))
          .limit(1)
      )
      return row?.mailboxId
        ? { mailboxId: row.mailboxId as MailboxId, providerThreadId: row.providerThreadId }
        : null
    },

    async listStale(organizationId, before, limit) {
      const rows = await inOrganization(organizationId, (tx) =>
        tx
          .select()
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.organizationId, organizationId),
              eq(mailMessages.state, 'sending'),
              lt(mailMessages.decidedAt, new Date(before))
            )
          )
          .orderBy(asc(mailMessages.decidedAt))
          .limit(limit)
      )
      return rows.map(storedOf)
    },
  }
}
