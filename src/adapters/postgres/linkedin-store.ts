import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type {
  LinkedinAccountId,
  LinkedinRiskAcceptanceId,
  MembershipId,
} from 'tula-closeline-contract'
import {
  linkedinAccounts,
  linkedinChannelSettings,
  linkedinRiskAcceptances,
} from 'tula-closeline-db/schema'
import type {
  LinkedinAccountRecord,
  LinkedinStore,
  RiskAcceptanceRecord,
} from '~/ports/linkedin-store'
import type { InOrganization } from './store'

type Row = typeof linkedinAccounts.$inferSelect

function recordOf(row: Row): LinkedinAccountRecord {
  return {
    id: row.id as LinkedinAccountId,
    membershipId: row.membershipId as MembershipId,
    providerAccountId: row.providerAccountId,
    status: row.status as LinkedinAccountRecord['status'],
    pauseReason: row.pauseReason as LinkedinAccountRecord['pauseReason'],
    limits: {
      dailyConnections: row.dailyConnectionLimit,
      dailyMessages: row.dailyMessageLimit,
      weeklyConnections: row.weeklyConnectionLimit,
    },
    connectedAt: row.connectedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

type AcceptanceRow = typeof linkedinRiskAcceptances.$inferSelect

function acceptanceOf(row: AcceptanceRow): RiskAcceptanceRecord {
  return {
    id: row.id as LinkedinRiskAcceptanceId,
    wordingVersion: row.wordingVersion,
    acceptedByMembershipId: row.acceptedByMembershipId as MembershipId,
    typedFullName: row.typedFullName,
    acceptedAt: row.acceptedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}

/** The Postgres {@link LinkedinStore}: every call runs inside the Organization's row-level security. */
export function createPostgresLinkedinStore(inOrganization: InOrganization): LinkedinStore {
  return {
    // The unique (organization, membership) key makes a reconnect reuse the row, keeping its id and limits.
    connect: (organizationId, record) =>
      inOrganization(organizationId, async (tx) => {
        const connectedAt = new Date(record.connectedAt)
        const [row] = await tx
          .insert(linkedinAccounts)
          .values({
            id: record.id,
            organizationId,
            membershipId: record.membershipId,
            providerAccountId: record.providerAccountId,
            status: record.status,
            pauseReason: record.pauseReason,
            dailyConnectionLimit: record.limits.dailyConnections,
            dailyMessageLimit: record.limits.dailyMessages,
            weeklyConnectionLimit: record.limits.weeklyConnections,
            connectedAt,
            updatedAt: connectedAt,
          })
          .onConflictDoUpdate({
            target: [linkedinAccounts.organizationId, linkedinAccounts.membershipId],
            set: {
              providerAccountId: record.providerAccountId,
              status: record.status,
              pauseReason: record.pauseReason,
              connectedAt,
              updatedAt: connectedAt,
            },
          })
          .returning()
        if (row === undefined) {
          throw new Error('linkedin account vanished inside its own transaction')
        }
        return recordOf(row)
      }),

    find: (organizationId, id) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(linkedinAccounts)
          .where(
            and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.id, id))
          )
        return row === undefined ? null : recordOf(row)
      }),

    list: (organizationId, visibleOwners, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        if (visibleOwners !== undefined && visibleOwners.length === 0) {
          return { items: [], next: null }
        }
        const at = after === null ? undefined : new Date(after.connectedAt)
        const rows = await tx
          .select()
          .from(linkedinAccounts)
          .where(
            and(
              eq(linkedinAccounts.organizationId, organizationId),
              visibleOwners === undefined
                ? undefined
                : inArray(linkedinAccounts.membershipId, [...visibleOwners]),
              after === null || at === undefined
                ? undefined
                : or(
                    lt(linkedinAccounts.connectedAt, at),
                    and(eq(linkedinAccounts.connectedAt, at), lt(linkedinAccounts.id, after.id))
                  )
            )
          )
          .orderBy(desc(linkedinAccounts.connectedAt), desc(linkedinAccounts.id))
          .limit(limit + 1)
        const items = rows.slice(0, limit).map(recordOf)
        const last = items[items.length - 1]
        return {
          items,
          next:
            rows.length > limit && last !== undefined
              ? { connectedAt: last.connectedAt, id: last.id }
              : null,
        }
      }),

    disconnect: (organizationId, id, at) =>
      inOrganization(organizationId, async (tx) => {
        const [updated] = await tx
          .update(linkedinAccounts)
          .set({ status: 'disconnected', pauseReason: null, updatedAt: new Date(at) })
          .where(
            and(
              eq(linkedinAccounts.organizationId, organizationId),
              eq(linkedinAccounts.id, id),
              sql`${linkedinAccounts.status} <> 'disconnected'`
            )
          )
          .returning()
        if (updated !== undefined) {
          return { record: recordOf(updated), changed: true }
        }
        const [row] = await tx
          .select()
          .from(linkedinAccounts)
          .where(
            and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.id, id))
          )
        return row === undefined ? null : { record: recordOf(row), changed: false }
      }),

    channelState: (organizationId, wordingVersion) =>
      inOrganization(organizationId, async (tx) => {
        const [settings] = await tx
          .select({ enabled: linkedinChannelSettings.enabled })
          .from(linkedinChannelSettings)
          .where(eq(linkedinChannelSettings.organizationId, organizationId))
        const [acceptance] = await tx
          .select({ id: linkedinRiskAcceptances.id })
          .from(linkedinRiskAcceptances)
          .where(
            and(
              eq(linkedinRiskAcceptances.organizationId, organizationId),
              eq(linkedinRiskAcceptances.wordingVersion, wordingVersion),
              isNull(linkedinRiskAcceptances.revokedAt)
            )
          )
          .limit(1)
        return { enabled: settings?.enabled ?? false, accepted: acceptance !== undefined }
      }),

    // The lock serialises concurrent accepts of one Organization, so exactly one row is recorded.
    acceptRisk: (organizationId, record) =>
      inOrganization(organizationId, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`linkedin-risk:${organizationId}`}))`
        )
        const [existing] = await tx
          .select()
          .from(linkedinRiskAcceptances)
          .where(
            and(
              eq(linkedinRiskAcceptances.organizationId, organizationId),
              eq(linkedinRiskAcceptances.wordingVersion, record.wordingVersion),
              isNull(linkedinRiskAcceptances.revokedAt)
            )
          )
          .limit(1)
        if (existing !== undefined) {
          return { record: acceptanceOf(existing), created: false }
        }
        const [row] = await tx
          .insert(linkedinRiskAcceptances)
          .values({
            id: record.id,
            organizationId,
            wordingVersion: record.wordingVersion,
            acceptedByMembershipId: record.acceptedByMembershipId,
            typedFullName: record.typedFullName,
            acceptedAt: new Date(record.acceptedAt),
          })
          .returning()
        if (row === undefined) {
          throw new Error('the acceptance was not stored')
        }
        return { record: acceptanceOf(row), created: true }
      }),

    revokeRisk: (organizationId, at) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .update(linkedinRiskAcceptances)
          .set({ revokedAt: new Date(at) })
          .where(
            and(
              eq(linkedinRiskAcceptances.organizationId, organizationId),
              isNull(linkedinRiskAcceptances.revokedAt)
            )
          )
          .returning({ id: linkedinRiskAcceptances.id })
        return rows.length
      }),

    activeAcceptance: (organizationId, wordingVersion) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(linkedinRiskAcceptances)
          .where(
            and(
              eq(linkedinRiskAcceptances.organizationId, organizationId),
              eq(linkedinRiskAcceptances.wordingVersion, wordingVersion),
              isNull(linkedinRiskAcceptances.revokedAt)
            )
          )
          .limit(1)
        return row === undefined ? null : acceptanceOf(row)
      }),

    listAcceptances: (organizationId, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(linkedinRiskAcceptances)
          .where(
            and(
              eq(linkedinRiskAcceptances.organizationId, organizationId),
              after === null
                ? undefined
                : or(
                    lt(linkedinRiskAcceptances.acceptedAt, new Date(after.acceptedAt)),
                    and(
                      eq(linkedinRiskAcceptances.acceptedAt, new Date(after.acceptedAt)),
                      lt(linkedinRiskAcceptances.id, after.id)
                    )
                  )
            )
          )
          .orderBy(desc(linkedinRiskAcceptances.acceptedAt), desc(linkedinRiskAcceptances.id))
          .limit(limit + 1)
        const items = rows.slice(0, limit).map(acceptanceOf)
        const last = items[items.length - 1]
        return {
          items,
          next:
            rows.length > limit && last !== undefined
              ? { acceptedAt: last.acceptedAt, id: last.id }
              : null,
        }
      }),

    setEnabled: (organizationId, enabled, byMembershipId, at) =>
      inOrganization(organizationId, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`linkedin-switch:${organizationId}`}))`
        )
        const [before] = await tx
          .select({ enabled: linkedinChannelSettings.enabled })
          .from(linkedinChannelSettings)
          .where(eq(linkedinChannelSettings.organizationId, organizationId))
        await tx
          .insert(linkedinChannelSettings)
          .values({
            organizationId,
            enabled,
            updatedByMembershipId: byMembershipId,
            updatedAt: new Date(at),
          })
          .onConflictDoUpdate({
            target: linkedinChannelSettings.organizationId,
            set: { enabled, updatedByMembershipId: byMembershipId, updatedAt: new Date(at) },
          })
        return { previous: before?.enabled ?? false }
      }),
  }
}
