import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { SendWindow } from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  mailboxConnectAttempts,
  mailboxes,
  mailboxLimits,
  mailboxTestSends,
} from 'tula-closeline-db/schema'
import type { MailboxRecord, MailboxStore, StoredTokens } from '~/ports/mailbox-store'
import type { InOrganization } from './store'

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

type MailboxRow = typeof mailboxes.$inferSelect
type LimitsRow = typeof mailboxLimits.$inferSelect

function daysOf(mask: number): SendWindow['days'] {
  return WEEKDAYS.filter((_, bit) => (mask & (1 << bit)) !== 0)
}

function maskOf(days: SendWindow['days']): number {
  return days.reduce((mask, day) => mask | (1 << WEEKDAYS.indexOf(day)), 0)
}

function recordOf(row: MailboxRow, limits: LimitsRow): MailboxRecord {
  return {
    id: row.id as MailboxRecord['id'],
    provider: row.provider,
    kind: row.kind,
    address: row.address,
    displayName: row.displayName,
    providerAccountId: row.providerAccountId,
    ownerMembershipId: row.ownerMembershipId as MailboxRecord['ownerMembershipId'],
    teamIds: row.teamIds as unknown as MailboxRecord['teamIds'],
    state: row.state,
    stateReason: row.stateReason,
    stateChangedAt: row.stateChangedAt.toISOString(),
    limits: {
      perDay: limits.perDay,
      perHour: limits.perHour,
      minGapSeconds: limits.minGapSeconds,
      window: {
        timeZone: limits.windowTimeZone,
        days: daysOf(limits.windowDays),
        startMinute: limits.windowStartMinute,
        endMinute: limits.windowEndMinute,
      },
    },
    health: {
      score: row.healthScore,
      effect: row.healthEffect,
      scoredAt: row.healthScoredAt?.toISOString() ?? null,
    },
    rampStartedAt: row.rampStartedAt.toISOString(),
    connectedAt: row.connectedAt.toISOString(),
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  }
}

function tokenColumns(tokens: StoredTokens) {
  return {
    accessTokenCiphertext: tokens.accessToken,
    accessTokenExpiresAt: new Date(tokens.accessTokenExpiresAt),
    refreshTokenCiphertext: tokens.refreshToken,
    tokenKeyId: tokens.keyId,
  }
}

async function loadRecord(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select({ mailbox: mailboxes, limits: mailboxLimits })
    .from(mailboxes)
    .innerJoin(
      mailboxLimits,
      and(
        eq(mailboxLimits.organizationId, mailboxes.organizationId),
        eq(mailboxLimits.mailboxId, mailboxes.id)
      )
    )
    .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)))
  return row === undefined ? null : recordOf(row.mailbox, row.limits)
}

async function findTestSend(tx: Transaction, organizationId: string, id: string, keyHash: string) {
  const [row] = await tx
    .select({
      providerMessageId: mailboxTestSends.providerMessageId,
      sentAt: mailboxTestSends.sentAt,
    })
    .from(mailboxTestSends)
    .where(
      and(
        eq(mailboxTestSends.organizationId, organizationId),
        eq(mailboxTestSends.mailboxId, id),
        eq(mailboxTestSends.keyHash, keyHash)
      )
    )
  return row === undefined
    ? null
    : { providerMessageId: row.providerMessageId, sentAt: row.sentAt.toISOString() }
}

function limitColumns(record: MailboxRecord) {
  return {
    perDay: record.limits.perDay,
    perHour: record.limits.perHour,
    minGapSeconds: record.limits.minGapSeconds,
    windowTimeZone: record.limits.window.timeZone,
    windowDays: maskOf(record.limits.window.days),
    windowStartMinute: record.limits.window.startMinute,
    windowEndMinute: record.limits.window.endMinute,
  }
}

/** The Postgres {@link MailboxStore}: every call runs inside the Organization's row-level security. */
export function createPostgresMailboxStore(inOrganization: InOrganization): MailboxStore {
  return {
    connect: (organizationId, record, tokens) =>
      inOrganization(organizationId, async (tx) => {
        const [existing] = await tx
          .select({ id: mailboxes.id, state: mailboxes.state })
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.organizationId, organizationId),
              eq(mailboxes.provider, record.provider),
              eq(mailboxes.address, record.address)
            )
          )
          .for('update')
        if (existing !== undefined && existing.state !== 'disconnected') {
          return { kind: 'already_connected' as const }
        }
        const values = {
          kind: record.kind,
          displayName: record.displayName,
          providerAccountId: record.providerAccountId,
          ownerMembershipId: record.ownerMembershipId,
          teamIds: [...record.teamIds],
          state: record.state,
          stateReason: record.stateReason,
          stateChangedAt: new Date(record.stateChangedAt),
          ...tokenColumns(tokens),
          healthScore: record.health.score,
          healthEffect: record.health.effect,
          healthScoredAt: record.health.scoredAt === null ? null : new Date(record.health.scoredAt),
          rampStartedAt: new Date(record.rampStartedAt),
          connectedAt: new Date(record.connectedAt),
          disconnectedAt: null,
          lastSyncedAt: null,
          syncCursor: null,
          nextPollAt: null,
          updatedAt: new Date(record.connectedAt),
        }
        const id = existing?.id ?? record.id
        if (existing === undefined) {
          await tx.insert(mailboxes).values({
            id,
            organizationId,
            provider: record.provider,
            address: record.address,
            ...values,
          })
          await tx
            .insert(mailboxLimits)
            .values({ organizationId, mailboxId: id, ...limitColumns(record) })
        } else {
          await tx
            .update(mailboxes)
            .set(values)
            .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)))
          await tx
            .update(mailboxLimits)
            .set({
              ...limitColumns(record),
              updatedByMembershipId: null,
              updatedAt: new Date(record.connectedAt),
            })
            .where(
              and(eq(mailboxLimits.organizationId, organizationId), eq(mailboxLimits.mailboxId, id))
            )
        }
        const stored = await loadRecord(tx, organizationId, id)
        if (stored === null) {
          throw new Error('mailbox vanished inside its own transaction')
        }
        return { kind: 'connected' as const, record: stored }
      }),

    find: (organizationId, id) =>
      inOrganization(organizationId, (tx) => loadRecord(tx, organizationId, id)),

    findByAddress: (organizationId, provider, address) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.organizationId, organizationId),
              eq(mailboxes.provider, provider),
              eq(mailboxes.address, address)
            )
          )
        return row === undefined ? null : loadRecord(tx, organizationId, row.id)
      }),

    list: (organizationId, filter, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select({ mailbox: mailboxes, limits: mailboxLimits })
          .from(mailboxes)
          .innerJoin(
            mailboxLimits,
            and(
              eq(mailboxLimits.organizationId, mailboxes.organizationId),
              eq(mailboxLimits.mailboxId, mailboxes.id)
            )
          )
          .where(
            and(
              eq(mailboxes.organizationId, organizationId),
              filter.visibleOwners === undefined
                ? undefined
                : and(
                    isNotNull(mailboxes.ownerMembershipId),
                    inArray(mailboxes.ownerMembershipId, [...filter.visibleOwners])
                  ),
              filter.state === undefined ? undefined : eq(mailboxes.state, filter.state),
              filter.provider === undefined ? undefined : eq(mailboxes.provider, filter.provider),
              filter.kind === undefined ? undefined : eq(mailboxes.kind, filter.kind),
              filter.ownerMembershipId === undefined
                ? undefined
                : eq(mailboxes.ownerMembershipId, filter.ownerMembershipId),
              after === null
                ? undefined
                : or(
                    gt(mailboxes.connectedAt, new Date(after.connectedAt)),
                    and(
                      eq(mailboxes.connectedAt, new Date(after.connectedAt)),
                      gt(mailboxes.id, after.id)
                    )
                  )
            )
          )
          .orderBy(asc(mailboxes.connectedAt), asc(mailboxes.id))
          .limit(limit + 1)
        const items = rows.slice(0, limit).map((row) => recordOf(row.mailbox, row.limits))
        const last = items[items.length - 1]
        return {
          items,
          next:
            rows.length > limit && last !== undefined
              ? { connectedAt: last.connectedAt, id: last.id }
              : null,
        }
      }),

    readTokens: (organizationId, id) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(mailboxes)
          .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)))
        if (
          row === undefined ||
          row.accessTokenCiphertext === null ||
          row.refreshTokenCiphertext === null ||
          row.accessTokenExpiresAt === null ||
          row.tokenKeyId === null
        ) {
          return null
        }
        return {
          keyId: row.tokenKeyId,
          accessToken: new Uint8Array(row.accessTokenCiphertext),
          accessTokenExpiresAt: row.accessTokenExpiresAt.toISOString(),
          refreshToken: new Uint8Array(row.refreshTokenCiphertext),
        }
      }),

    writeTokens: (organizationId, id, tokens) =>
      inOrganization(organizationId, async (tx) => {
        const updated = await tx
          .update(mailboxes)
          .set({ ...tokenColumns(tokens), updatedAt: sql`now()` })
          .where(
            and(
              eq(mailboxes.organizationId, organizationId),
              eq(mailboxes.id, id),
              sql`${mailboxes.state} <> 'disconnected'`
            )
          )
          .returning({ id: mailboxes.id })
        return updated.length > 0
      }),

    disconnect: (organizationId, id, reason, at) =>
      inOrganization(organizationId, async (tx) => {
        await tx
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)))
          .for('update')
        const current = await loadRecord(tx, organizationId, id)
        if (current === null) {
          return null
        }
        if (current.state === 'disconnected') {
          return { record: current, changed: false }
        }
        const when = new Date(at)
        await tx
          .update(mailboxes)
          .set({
            state: 'disconnected',
            stateReason: reason,
            stateChangedAt: when,
            disconnectedAt: when,
            accessTokenCiphertext: null,
            accessTokenExpiresAt: null,
            refreshTokenCiphertext: null,
            tokenKeyId: null,
            nextPollAt: null,
            updatedAt: when,
          })
          .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)))
        const record = await loadRecord(tx, organizationId, id)
        if (record === null) {
          throw new Error('mailbox vanished inside its own transaction')
        }
        return { record, changed: true }
      }),

    registerAttempt: (organizationId, attempt) =>
      inOrganization(organizationId, async (tx) => {
        await tx
          .insert(mailboxConnectAttempts)
          .values({
            id: attempt.id,
            organizationId,
            userId: attempt.userId,
            stateHash: attempt.stateHash,
            createdAt: new Date(attempt.createdAt),
            expiresAt: new Date(attempt.expiresAt),
          })
          .onConflictDoNothing()
      }),

    consumeAttempt: (organizationId, userId, stateHash, at) =>
      inOrganization(organizationId, async (tx) => {
        const when = new Date(at)
        const used = await tx
          .update(mailboxConnectAttempts)
          .set({ consumedAt: when })
          .where(
            and(
              eq(mailboxConnectAttempts.organizationId, organizationId),
              eq(mailboxConnectAttempts.stateHash, stateHash),
              eq(mailboxConnectAttempts.userId, userId),
              isNull(mailboxConnectAttempts.consumedAt),
              gt(mailboxConnectAttempts.expiresAt, when)
            )
          )
          .returning({ id: mailboxConnectAttempts.id })
        return used.length > 0
      }),

    findTestSend: (organizationId, id, keyHash) =>
      inOrganization(organizationId, (tx) => findTestSend(tx, organizationId, id, keyHash)),

    countTestSends: (organizationId, id, since) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(mailboxTestSends)
          .where(
            and(
              eq(mailboxTestSends.organizationId, organizationId),
              eq(mailboxTestSends.mailboxId, id),
              gte(mailboxTestSends.sentAt, new Date(since))
            )
          )
        return row?.n ?? 0
      }),

    recordTestSend: (organizationId, id, keyHash, send) =>
      inOrganization(organizationId, async (tx) => {
        await tx
          .insert(mailboxTestSends)
          .values({
            organizationId,
            mailboxId: id,
            keyHash,
            providerMessageId: send.providerMessageId,
            sentAt: new Date(send.sentAt),
          })
          .onConflictDoNothing()
        const kept = await findTestSend(tx, organizationId, id, keyHash)
        if (kept === null) {
          throw new Error('test send vanished inside its own transaction')
        }
        return kept
      }),
  }
}
