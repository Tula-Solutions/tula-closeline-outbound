import { and, desc, eq, inArray, lt, ne, or } from 'drizzle-orm'
import {
  type Enrollment,
  type EnrollmentEvent,
  enrollmentEventSchema,
  enrollmentSchema,
  formatId,
} from 'tula-closeline-contract'
import { outboundEnrollmentEvents, outboundEnrollments } from 'tula-closeline-db/schema'
import type { EnrollmentStore } from '~/ports/enrollment-store'
import type { InOrganization } from './store'

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

/** The Enrollment store over Postgres; each call runs in one transaction scoped to the Organization. */
export function createPostgresEnrollmentStore(inOrganization: InOrganization): EnrollmentStore {
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
        await tx.insert(outboundEnrollmentEvents).values(
          eventRow(organizationId, {
            id: formatId('eev', Bun.randomUUIDv7()),
            enrollmentId: id,
            kind: 'stopped',
            stepKey: null,
            variantKey: null,
            sendId: null,
            stopReason: reason,
            actorMembershipId: actor,
            occurredAt: at,
          })
        )
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
  }
}
