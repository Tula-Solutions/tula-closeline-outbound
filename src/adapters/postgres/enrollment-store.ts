import { and, asc, desc, eq, inArray, isNotNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { OrganizationId } from 'tula-closeline-contract'
import {
  type Enrollment,
  type EnrollmentEvent,
  enrollmentEventSchema,
  enrollmentSchema,
  formatId,
} from 'tula-closeline-contract'
import type { Database, Transaction } from 'tula-closeline-db'
import {
  outboundEnrollmentEvents,
  outboundEnrollments,
  outboundVariantStats,
} from 'tula-closeline-db/schema'
import type { EnrollmentStore } from '~/ports/enrollment-store'
import type { InOrganization } from './store'

/** A Step has at most 4 variants. */
const MAX_VARIANTS = 4

type Row = typeof outboundEnrollments.$inferSelect
type EventRow = typeof outboundEnrollmentEvents.$inferSelect

const iso = (value: Date | null) => value?.toISOString() ?? null
const dateOrNull = (value: string | null) => (value === null ? null : new Date(value))

/** The contract's Enrollment from its row; the stored values are parsed, not trusted. */
function enrollmentOf(row: Row): Enrollment {
  return enrollmentSchema.parse({
    id: row.id,
    campaignId: row.campaignId,
    prospectId: row.prospectId,
    state: row.state,
    stopReason: row.stopReason,
    currentStepKey: row.currentStepKey,
    currentStep: row.currentStep,
    attemptEpoch: row.attemptEpoch,
    nextDueAt: iso(row.nextDueAt),
    enrolledAt: row.enrolledAt.toISOString(),
    stoppedAt: iso(row.stoppedAt),
    completedAt: iso(row.completedAt),
  })
}

function eventOf(row: EventRow): EnrollmentEvent {
  return enrollmentEventSchema.parse({
    id: row.id,
    enrollmentId: row.enrollmentId,
    kind: row.kind,
    stepKey: row.stepKey,
    variantKey: row.variantKey,
    sendId: row.sendId,
    stopReason: row.stopReason,
    actorMembershipId: row.actorMembershipId,
    occurredAt: row.occurredAt.toISOString(),
  })
}

function eventRow(organizationId: string, event: EnrollmentEvent) {
  return {
    id: event.id,
    organizationId,
    enrollmentId: event.enrollmentId,
    kind: event.kind,
    stepKey: event.stepKey,
    variantKey: event.variantKey,
    sendId: event.sendId,
    stopReason: event.stopReason,
    actorMembershipId: event.actorMembershipId,
    occurredAt: new Date(event.occurredAt),
  }
}

type Tally = 'sent' | 'replied' | 'bounced' | 'unsubscribed'

const TALLY_OF_STOP: Partial<Record<NonNullable<EnrollmentEvent['stopReason']>, Tally>> = {
  replied: 'replied',
  hard_bounce: 'bounced',
  unsubscribed: 'unsubscribed',
}

async function addToTally(
  tx: Transaction,
  organizationId: OrganizationId,
  campaignId: string,
  stepKey: string,
  variantKey: string,
  column: Tally
) {
  const col = sql.raw(`"${column}"`)
  await tx.execute(sql`
    insert into outbound.variant_stats
      (organization_id, campaign_id, version, step_key, variant_key, ${col})
    select ${organizationId}, c.id, c.sequence_version, ${stepKey}, ${variantKey}, 1
    from outbound.campaigns c where c.organization_id = ${organizationId} and c.id = ${campaignId}
    on conflict (organization_id, campaign_id, version, step_key, variant_key)
    do update set ${col} = outbound.variant_stats.${col} + 1`)
}

/**
 * Adds the events just written to the variant tallies, in the same transaction: a `sent` that names
 * a variant counts a send, and a stop that replies, bounces or unsubscribes counts for the variant
 * of the Enrollment's latest send (so a reader never scans the log).
 */
async function tally(
  tx: Transaction,
  organizationId: OrganizationId,
  campaignId: string,
  enrollmentId: string,
  events: readonly EnrollmentEvent[]
) {
  for (const e of events) {
    if (e.kind === 'sent' && e.variantKey !== null && e.stepKey !== null) {
      await addToTally(tx, organizationId, campaignId, e.stepKey, e.variantKey, 'sent')
    }
  }
  for (const e of events) {
    const column =
      e.kind === 'stopped' && e.stopReason !== null ? TALLY_OF_STOP[e.stopReason] : undefined
    if (column === undefined) {
      continue
    }
    const t = outboundEnrollmentEvents
    const [last] = await tx
      .select({ stepKey: t.stepKey, variantKey: t.variantKey })
      .from(t)
      .where(
        and(
          eq(t.organizationId, organizationId),
          eq(t.enrollmentId, enrollmentId),
          eq(t.kind, 'sent'),
          isNotNull(t.variantKey)
        )
      )
      .orderBy(desc(t.occurredAt), desc(t.id))
      .limit(1)
    if (last?.stepKey != null && last.variantKey !== null) {
      await addToTally(tx, organizationId, campaignId, last.stepKey, last.variantKey, column)
    }
  }
}

/**
 * The Enrollment store over Postgres; each call runs in one transaction scoped to the Organization.
 * `db` is the unscoped handle, used only to ask which Organizations have work due.
 */
export function createPostgresEnrollmentStore(
  inOrganization: InOrganization,
  db: Pick<Database, 'execute'>
): EnrollmentStore {
  return {
    insertIfAbsent: (organizationId, enrollment, events) =>
      inOrganization(organizationId, async (tx) => {
        const inserted = await tx
          .insert(outboundEnrollments)
          .values({
            id: enrollment.id,
            organizationId,
            campaignId: enrollment.campaignId,
            prospectId: enrollment.prospectId,
            state: enrollment.state,
            stopReason: enrollment.stopReason,
            currentStepKey: enrollment.currentStepKey,
            currentStep: enrollment.currentStep,
            attemptEpoch: enrollment.attemptEpoch,
            nextDueAt: dateOrNull(enrollment.nextDueAt),
            enrolledAt: new Date(enrollment.enrolledAt),
            stoppedAt: dateOrNull(enrollment.stoppedAt),
            completedAt: dateOrNull(enrollment.completedAt),
            updatedAt: new Date(enrollment.enrolledAt),
          })
          .onConflictDoNothing()
          .returning()
        const [row] = inserted
        if (row !== undefined) {
          if (events.length > 0) {
            await tx
              .insert(outboundEnrollmentEvents)
              .values(events.map((event) => eventRow(organizationId, event)))
            await tally(tx, organizationId, enrollment.campaignId, enrollment.id, events)
          }
          return { enrollment: enrollmentOf(row), created: true }
        }
        const [existing] = await tx
          .select()
          .from(outboundEnrollments)
          .where(
            and(
              eq(outboundEnrollments.organizationId, organizationId),
              eq(outboundEnrollments.campaignId, enrollment.campaignId),
              eq(outboundEnrollments.prospectId, enrollment.prospectId)
            )
          )
        if (existing === undefined) {
          throw new Error('enrollment conflict without a stored row')
        }
        return { enrollment: enrollmentOf(existing), created: false }
      }),

    find: (organizationId, id) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(outboundEnrollments)
          .where(
            and(
              eq(outboundEnrollments.organizationId, organizationId),
              eq(outboundEnrollments.id, id)
            )
          )
        return row === undefined ? null : enrollmentOf(row)
      }),

    findByProspect: (organizationId, campaignId, prospectId) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(outboundEnrollments)
          .where(
            and(
              eq(outboundEnrollments.organizationId, organizationId),
              eq(outboundEnrollments.campaignId, campaignId),
              eq(outboundEnrollments.prospectId, prospectId)
            )
          )
        return row === undefined ? null : enrollmentOf(row)
      }),

    list: (organizationId, campaignId, filter, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        const t = outboundEnrollments
        const rows = await tx
          .select()
          .from(t)
          .where(
            and(
              eq(t.organizationId, organizationId),
              eq(t.campaignId, campaignId),
              filter.state === undefined ? undefined : eq(t.state, filter.state),
              filter.stopReason === undefined ? undefined : eq(t.stopReason, filter.stopReason),
              filter.prospectId === undefined ? undefined : eq(t.prospectId, filter.prospectId),
              after === null
                ? undefined
                : or(
                    lt(t.enrolledAt, new Date(after.enrolledAt)),
                    and(eq(t.enrolledAt, new Date(after.enrolledAt)), lt(t.id, after.id))
                  )
            )
          )
          .orderBy(desc(t.enrolledAt), desc(t.id))
          .limit(limit + 1)
        const items = rows.slice(0, limit).map(enrollmentOf)
        const last = items[items.length - 1]
        return {
          items,
          next: rows.length > limit && last ? { enrolledAt: last.enrolledAt, id: last.id } : null,
        }
      }),

    activity: (organizationId, enrollmentId, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        const t = outboundEnrollmentEvents
        const rows = await tx
          .select()
          .from(t)
          .where(
            and(
              eq(t.organizationId, organizationId),
              eq(t.enrollmentId, enrollmentId),
              after === null
                ? undefined
                : or(
                    lt(t.occurredAt, new Date(after.occurredAt)),
                    and(eq(t.occurredAt, new Date(after.occurredAt)), lt(t.id, after.id))
                  )
            )
          )
          .orderBy(desc(t.occurredAt), desc(t.id))
          .limit(limit + 1)
        const items = rows.slice(0, limit).map(eventOf)
        const last = items[items.length - 1]
        return {
          items,
          next: rows.length > limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
        }
      }),

    stop: (organizationId, id, reason, at, actor) =>
      inOrganization(organizationId, async (tx) => {
        const t = outboundEnrollments
        const [row] = await tx
          .select()
          .from(t)
          .where(and(eq(t.organizationId, organizationId), eq(t.id, id)))
          .for('update')
        if (row === undefined) {
          return null
        }
        if (row.state !== 'active') {
          return { enrollment: enrollmentOf(row), stopped: false }
        }
        const [updated] = await tx
          .update(t)
          .set({
            state: 'stopped',
            stopReason: reason,
            stoppedAt: new Date(at),
            nextDueAt: null,
            currentStepKey: null,
            currentStep: null,
            updatedAt: new Date(at),
          })
          .where(and(eq(t.organizationId, organizationId), eq(t.id, id)))
          .returning()
        if (updated === undefined) {
          throw new Error('enrollment vanished while locked')
        }
        const stopped: EnrollmentEvent = {
          id: formatId('eev', Bun.randomUUIDv7()),
          enrollmentId: id,
          kind: 'stopped',
          stepKey: null,
          variantKey: null,
          sendId: null,
          stopReason: reason,
          actorMembershipId: actor,
          occurredAt: at,
        }
        await tx.insert(outboundEnrollmentEvents).values(eventRow(organizationId, stopped))
        await tally(tx, organizationId, updated.campaignId, id, [stopped])
        return { enrollment: enrollmentOf(updated), stopped: true }
      }),

    activeElsewhere: (organizationId, campaignId, prospectIds) =>
      inOrganization(organizationId, async (tx) => {
        if (prospectIds.length === 0) {
          return new Set()
        }
        const t = outboundEnrollments
        const rows = await tx
          .selectDistinct({ prospectId: t.prospectId })
          .from(t)
          .where(
            and(
              eq(t.organizationId, organizationId),
              eq(t.state, 'active'),
              ne(t.campaignId, campaignId),
              inArray(t.prospectId, [...prospectIds])
            )
          )
        return new Set(rows.map((row) => row.prospectId as (typeof prospectIds)[number]))
      }),

    dueOrganizations: async (after, batch) => {
      const result = await db.execute(
        sql`select organization_id, resume_after from outbound.organizations_with_work('step_due', ${after}, ${batch})`
      )
      const rows = result.rows as { organization_id: string | null; resume_after: string | null }[]
      return {
        organizationIds: rows.flatMap((r) =>
          r.organization_id === null ? [] : [r.organization_id as OrganizationId]
        ),
        next: rows[rows.length - 1]?.resume_after ?? null,
      }
    },

    claimDue: (organizationId, now, leaseUntil, limit) =>
      inOrganization(organizationId, async (tx) => {
        const t = outboundEnrollments
        const rows = await tx
          .select()
          .from(t)
          .where(
            and(
              eq(t.organizationId, organizationId),
              eq(t.state, 'active'),
              isNotNull(t.nextDueAt),
              lte(t.nextDueAt, new Date(now))
            )
          )
          .orderBy(asc(t.nextDueAt), asc(t.id))
          .limit(limit)
          .for('update', { skipLocked: true })
        if (rows.length === 0) {
          return []
        }
        const claimed = await tx
          .update(t)
          .set({ nextDueAt: new Date(leaseUntil), updatedAt: new Date(now) })
          .where(
            and(
              eq(t.organizationId, organizationId),
              inArray(
                t.id,
                rows.map((r) => r.id)
              )
            )
          )
          .returning()
        return claimed.map(enrollmentOf)
      }),

    advance: (organizationId, id, expect, to, events) =>
      inOrganization(organizationId, async (tx) => {
        const t = outboundEnrollments
        const [row] = await tx
          .select()
          .from(t)
          .where(and(eq(t.organizationId, organizationId), eq(t.id, id)))
          .for('update')
        if (
          row === undefined ||
          row.state !== 'active' ||
          row.currentStepKey !== expect.stepKey ||
          row.attemptEpoch !== expect.attemptEpoch
        ) {
          return null
        }
        const [updated] = await tx
          .update(t)
          .set(
            to.state === 'active'
              ? {
                  currentStepKey: to.currentStepKey,
                  currentStep: to.currentStep,
                  attemptEpoch: to.attemptEpoch,
                  nextDueAt: new Date(to.nextDueAt),
                  updatedAt: new Date(),
                }
              : {
                  state: 'completed' as const,
                  completedAt: new Date(to.at),
                  nextDueAt: null,
                  currentStepKey: null,
                  currentStep: null,
                  updatedAt: new Date(to.at),
                }
          )
          .where(and(eq(t.organizationId, organizationId), eq(t.id, id)))
          .returning()
        if (updated === undefined) {
          throw new Error('enrollment vanished while locked')
        }
        if (events.length > 0) {
          await tx
            .insert(outboundEnrollmentEvents)
            .values(events.map((event) => eventRow(organizationId, event)))
          await tally(tx, organizationId, updated.campaignId, id, events)
        }
        return enrollmentOf(updated)
      }),

    activeOfProspect: (organizationId, prospectId, limit) =>
      inOrganization(organizationId, async (tx) => {
        const t = outboundEnrollments
        const rows = await tx
          .select()
          .from(t)
          .where(
            and(
              eq(t.organizationId, organizationId),
              eq(t.state, 'active'),
              eq(t.prospectId, prospectId)
            )
          )
          .orderBy(asc(t.id))
          .limit(limit)
        return rows.map(enrollmentOf)
      }),

    lastEventAt: (organizationId, id, kind) =>
      inOrganization(organizationId, async (tx) => {
        const t = outboundEnrollmentEvents
        const [row] = await tx
          .select({ at: t.occurredAt })
          .from(t)
          .where(
            and(eq(t.organizationId, organizationId), eq(t.enrollmentId, id), eq(t.kind, kind))
          )
          .orderBy(desc(t.occurredAt))
          .limit(1)
        return row?.at.toISOString() ?? null
      }),

    variantCounts: (organizationId, campaignId, version, stepKey) =>
      inOrganization(organizationId, async (tx) => {
        const t = outboundVariantStats
        return tx
          .select({
            variantKey: t.variantKey,
            sent: t.sent,
            replied: t.replied,
            bounced: t.bounced,
            unsubscribed: t.unsubscribed,
          })
          .from(t)
          .where(
            and(
              eq(t.organizationId, organizationId),
              eq(t.campaignId, campaignId),
              eq(t.version, version),
              eq(t.stepKey, stepKey)
            )
          )
          .orderBy(asc(t.variantKey))
          .limit(MAX_VARIANTS)
      }),
  }
}
