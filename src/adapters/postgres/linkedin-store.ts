import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { LinkedinAccountId, MembershipId } from 'tula-closeline-contract'
import {
  linkedinAccounts,
  linkedinChannelSettings,
  linkedinRiskAcceptances,
} from 'tula-closeline-db/schema'
import type { LinkedinAccountRecord, LinkedinStore } from '~/ports/linkedin-store'
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
  }
}
