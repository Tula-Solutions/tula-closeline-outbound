import type {
  CampaignId,
  Enrollment,
  EnrollmentEvent,
  EnrollmentId,
  OrganizationId,
  ProspectId,
} from 'tula-closeline-contract'
import { formatId } from 'tula-closeline-contract'
import type { EnrollmentStore } from '~/ports/enrollment-store'

type Entry = { enrollment: Enrollment; events: EnrollmentEvent[] }

/** Newest first: later time, then larger id. */
function newestFirst(a: { at: string; id: string }, b: { at: string; id: string }): number {
  if (a.at !== b.at) {
    return a.at < b.at ? 1 : -1
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * Enrollments in process memory, for tests and local runs of one instance. Like the Postgres
 * adapter it holds one row per Prospect per Campaign, and a stop of an ended row writes nothing.
 */
export function createMemoryEnrollmentStore(): EnrollmentStore {
  const organizations = new Map<string, Map<string, Entry>>()
  const entries = (organizationId: OrganizationId) => {
    let found = organizations.get(organizationId)
    if (found === undefined) {
      found = new Map()
      organizations.set(organizationId, found)
    }
    return found
  }
  const byProspect = (organizationId: OrganizationId, campaignId: CampaignId, id: ProspectId) =>
    [...entries(organizationId).values()].find(
      (e) => e.enrollment.campaignId === campaignId && e.enrollment.prospectId === id
    )
  return {
    async insertIfAbsent(organizationId, enrollment, events) {
      const existing = byProspect(organizationId, enrollment.campaignId, enrollment.prospectId)
      if (existing !== undefined) {
        return { enrollment: structuredClone(existing.enrollment), created: false }
      }
      entries(organizationId).set(enrollment.id, {
        enrollment: structuredClone(enrollment),
        events: structuredClone([...events]),
      })
      return { enrollment: structuredClone(enrollment), created: true }
    },
    async find(organizationId, id) {
      const found = entries(organizationId).get(id)
      return found === undefined ? null : structuredClone(found.enrollment)
    },
    async findByProspect(organizationId, campaignId, prospectId) {
      const found = byProspect(organizationId, campaignId, prospectId)
      return found === undefined ? null : structuredClone(found.enrollment)
    },
    async list(organizationId, campaignId, filter, after, limit) {
      const sorted = [...entries(organizationId).values()]
        .map((e) => e.enrollment)
        .filter(
          (e) =>
            e.campaignId === campaignId &&
            (filter.state === undefined || e.state === filter.state) &&
            (filter.stopReason === undefined || e.stopReason === filter.stopReason) &&
            (filter.prospectId === undefined || e.prospectId === filter.prospectId)
        )
        .sort((a, b) => newestFirst({ at: a.enrolledAt, id: a.id }, { at: b.enrolledAt, id: b.id }))
      const rest =
        after === null
          ? sorted
          : sorted.filter(
              (e) =>
                newestFirst(
                  { at: after.enrolledAt, id: after.id },
                  { at: e.enrolledAt, id: e.id }
                ) < 0
            )
      const items = structuredClone(rest.slice(0, limit))
      const last = items[items.length - 1]
      return {
        items,
        next: rest.length > limit && last ? { enrolledAt: last.enrolledAt, id: last.id } : null,
      }
    },
    async activity(organizationId, enrollmentId, after, limit) {
      const sorted = [...(entries(organizationId).get(enrollmentId)?.events ?? [])].sort((a, b) =>
        newestFirst({ at: a.occurredAt, id: a.id }, { at: b.occurredAt, id: b.id })
      )
      const rest =
        after === null
          ? sorted
          : sorted.filter(
              (e) =>
                newestFirst(
                  { at: after.occurredAt, id: after.id },
                  { at: e.occurredAt, id: e.id }
                ) < 0
            )
      const items = structuredClone(rest.slice(0, limit))
      const last = items[items.length - 1]
      return {
        items,
        next: rest.length > limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
      }
    },
    async stop(organizationId, id, reason, at, actor) {
      const found = entries(organizationId).get(id)
      if (found === undefined) {
        return null
      }
      if (found.enrollment.state !== 'active') {
        return { enrollment: structuredClone(found.enrollment), stopped: false }
      }
      found.enrollment = {
        ...found.enrollment,
        state: 'stopped',
        stopReason: reason,
        stoppedAt: at,
        nextDueAt: null,
        currentStepKey: null,
        currentStep: null,
      }
      found.events.push({
        id: formatId('eev', Bun.randomUUIDv7()),
        enrollmentId: id as EnrollmentId,
        kind: 'stopped',
        stepKey: null,
        variantKey: null,
        sendId: null,
        stopReason: reason,
        actorMembershipId: actor,
        occurredAt: at,
      })
      return { enrollment: structuredClone(found.enrollment), stopped: true }
    },
    async activeElsewhere(organizationId, campaignId, prospectIds) {
      const wanted = new Set<string>(prospectIds)
      return new Set(
        [...entries(organizationId).values()]
          .map((e) => e.enrollment)
          .filter(
            (e) => e.state === 'active' && e.campaignId !== campaignId && wanted.has(e.prospectId)
          )
          .map((e) => e.prospectId)
      )
    },

    async dueOrganizations(after, batch, now) {
      const ids = [...organizations.entries()]
        .filter(
          ([id, rows]) =>
            (after === null || id > after) &&
            [...rows.values()].some(
              (e) =>
                e.enrollment.state === 'active' &&
                e.enrollment.nextDueAt !== null &&
                e.enrollment.nextDueAt <= now
            )
        )
        .map(([id]) => id as OrganizationId)
        .sort()
      const page = ids.slice(0, batch)
      return {
        organizationIds: page,
        next: ids.length > batch ? (page[page.length - 1] ?? null) : null,
      }
    },
    async claimDue(organizationId, now, leaseUntil, limit) {
      const due = [...entries(organizationId).values()]
        .filter(
          (e) =>
            e.enrollment.state === 'active' &&
            e.enrollment.nextDueAt !== null &&
            e.enrollment.nextDueAt <= now
        )
        .sort(
          (a, b) =>
            (a.enrollment.nextDueAt ?? '').localeCompare(b.enrollment.nextDueAt ?? '') ||
            a.enrollment.id.localeCompare(b.enrollment.id)
        )
        .slice(0, limit)
      for (const entry of due) {
        entry.enrollment = { ...entry.enrollment, nextDueAt: leaseUntil }
      }
      return structuredClone(due.map((e) => e.enrollment))
    },
    async advance(organizationId, id, expect, to, events) {
      const found = entries(organizationId).get(id)
      const current = found?.enrollment
      if (
        found === undefined ||
        current === undefined ||
        current.state !== 'active' ||
        current.currentStepKey !== expect.stepKey ||
        current.attemptEpoch !== expect.attemptEpoch
      ) {
        return null
      }
      found.enrollment =
        to.state === 'active'
          ? {
              ...current,
              currentStepKey: to.currentStepKey,
              currentStep: to.currentStep,
              attemptEpoch: to.attemptEpoch,
              nextDueAt: to.nextDueAt,
            }
          : {
              ...current,
              state: 'completed',
              completedAt: to.at,
              nextDueAt: null,
              currentStepKey: null,
              currentStep: null,
            }
      found.events.push(...structuredClone([...events]))
      return structuredClone(found.enrollment)
    },
    async activeOfProspect(organizationId, prospectId, limit) {
      return structuredClone(
        [...entries(organizationId).values()]
          .map((e) => e.enrollment)
          .filter((e) => e.state === 'active' && e.prospectId === prospectId)
          .slice(0, limit)
      )
    },
    async lastEventAt(organizationId, id, kind) {
      const times = (entries(organizationId).get(id)?.events ?? [])
        .filter((e) => e.kind === kind)
        .map((e) => e.occurredAt)
        .sort()
      return times[times.length - 1] ?? null
    },
  }
}
