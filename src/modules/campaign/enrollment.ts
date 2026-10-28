import {
  type CampaignId,
  decodeCursor,
  type Enrollment,
  type EnrollmentEvent,
  type EnrollmentId,
  type EnrollResult,
  ERRORS,
  encodeCursor,
  enrollmentActivityCursorSchema,
  enrollmentCursorSchema,
  formatId,
  type ListEnrollmentsQuery,
  type ProspectId,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import { domainError } from '~/http/domain-error'
import { refusalOf } from './audience'
import type { CampaignDeps } from './deps'
import { type CampaignCaller, errorOf, loadVisible, MAX_PAGE } from './service'

/** A caller with the bearer token core needs to judge which Prospects they may see. */
export type EnrollCaller = CampaignCaller & { bearer: string }

function pageSize(limit: number | undefined): number {
  return Math.min(limit ?? MAX_PAGE, MAX_PAGE)
}

function cursorOf<T extends z.ZodType>(raw: string | undefined, schema: T): z.output<T> | null {
  if (raw === undefined) {
    return null
  }
  const position = decodeCursor(raw, schema)
  if (position === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return position
}

const eventOf = (
  enrollmentId: EnrollmentId,
  kind: EnrollmentEvent['kind'],
  at: string,
  extra: Partial<EnrollmentEvent> = {}
): EnrollmentEvent => ({
  id: formatId('eev', Bun.randomUUIDv7()),
  enrollmentId,
  kind,
  stepKey: null,
  variantKey: null,
  sendId: null,
  stopReason: null,
  actorMembershipId: null,
  occurredAt: at,
  ...extra,
})

const refused = (
  prospectId: ProspectId,
  refusal: NonNullable<EnrollResult['refusal']>,
  enrollmentId: EnrollmentId | null = null
): EnrollResult => ({ prospectId, outcome: 'refused', refusal, enrollmentId })

/**
 * Enrolls up to 100 Prospects into a running or paused Campaign, one result each. Each Prospect is
 * judged alone: out of view or unknown, already in this Campaign, without Contact Consent or
 * suppressed (the Enrollment is then recorded as stopped, so the log shows why), or in another
 * active Campaign. Asking again changes nothing, so no key is needed beyond the Prospect itself.
 */
export async function enroll(
  deps: CampaignDeps,
  caller: EnrollCaller,
  campaignId: CampaignId,
  prospectIds: readonly ProspectId[]
): Promise<{ results: EnrollResult[] }> {
  const { campaign } = await loadVisible(deps, caller, campaignId)
  if (campaign.state !== 'running' && campaign.state !== 'paused') {
    throw domainError(errorOf('campaign.invalid_state'))
  }
  const first = (
    await deps.store.readSequence(caller.organizationId, campaignId, campaign.sequenceVersion)
  )?.steps[0]
  if (first === undefined) {
    throw domainError(errorOf('campaign.invalid_state'))
  }
  const { notVisible } = await deps.access.inspect(caller, prospectIds)
  const hidden = new Set<ProspectId>(notVisible)
  const elsewhere = await deps.enrollments.activeElsewhere(
    caller.organizationId,
    campaignId,
    prospectIds.filter((id) => !hidden.has(id))
  )
  const results: EnrollResult[] = []
  for (const prospectId of prospectIds) {
    if (hidden.has(prospectId)) {
      results.push(refused(prospectId, 'not_found'))
      continue
    }
    const existing = await deps.enrollments.findByProspect(
      caller.organizationId,
      campaignId,
      prospectId
    )
    if (existing !== null) {
      results.push(
        existing.stopReason === 'suppressed' || existing.stopReason === 'no_consent'
          ? refused(prospectId, existing.stopReason)
          : refused(prospectId, 'already_active', existing.id)
      )
      continue
    }
    if (elsewhere.has(prospectId)) {
      results.push(refused(prospectId, 'already_active'))
      continue
    }
    // shortcut: the active-elsewhere check and the insert are not atomic, so two parallel calls can
    // double-enroll a Prospect; upgrade with a db partial unique index on active rows.
    const now = deps.clock.now().toISOString()
    const id: EnrollmentId = formatId('enr', Bun.randomUUIDv7())
    const denial = await refusalOf(deps, caller.organizationId, prospectId)
    const base = {
      id,
      campaignId,
      prospectId,
      attemptEpoch: 0,
      enrolledAt: now,
      completedAt: null,
    }
    // shortcut: a refused Prospect keeps a stopped row, so later consent does not re-enroll them
    // on a repeat of this call; upgrade when the launch ticket defines re-enrollment.
    const enrollment: Enrollment =
      denial === null
        ? {
            ...base,
            state: 'active',
            stopReason: null,
            currentStepKey: first.key,
            currentStep: 0,
            nextDueAt: now,
            stoppedAt: null,
          }
        : {
            ...base,
            state: 'stopped',
            stopReason: denial,
            currentStepKey: null,
            currentStep: null,
            nextDueAt: null,
            stoppedAt: now,
          }
    const events =
      denial === null
        ? [eventOf(id, 'enrolled', now), eventOf(id, 'step_entered', now, { stepKey: first.key })]
        : [eventOf(id, 'enrolled', now), eventOf(id, 'stopped', now, { stopReason: denial })]
    const written = await deps.enrollments.insertIfAbsent(caller.organizationId, enrollment, events)
    if (!written.created) {
      results.push(refused(prospectId, 'already_active', written.enrollment.id))
    } else if (denial !== null) {
      results.push(refused(prospectId, denial))
    } else {
      results.push({ prospectId, outcome: 'enrolled', refusal: null, enrollmentId: id })
    }
  }
  return { results }
}

/** The Enrollment and its Campaign's view, or `enrollment.not_found` when the caller may not see it. */
async function loadEnrollment(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: EnrollmentId
): Promise<Enrollment> {
  const found = await deps.enrollments.find(caller.organizationId, id)
  if (found === null) {
    throw domainError(errorOf('enrollment.not_found'))
  }
  try {
    await loadVisible(deps, caller, found.campaignId)
  } catch {
    throw domainError(errorOf('enrollment.not_found'))
  }
  return found
}

/** One Enrollment of a Campaign the caller may see. */
export async function get(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: EnrollmentId
): Promise<Enrollment> {
  return loadEnrollment(deps, caller, id)
}

/** A newest-first page of the Enrollments of a visible Campaign. */
export async function list(
  deps: CampaignDeps,
  caller: CampaignCaller,
  campaignId: CampaignId,
  query: ListEnrollmentsQuery
) {
  await loadVisible(deps, caller, campaignId)
  const after = cursorOf(query.cursor, enrollmentCursorSchema)
  const page = await deps.enrollments.list(
    caller.organizationId,
    campaignId,
    { state: query.state, stopReason: query.stopReason, prospectId: query.prospectId },
    after,
    pageSize(query.limit)
  )
  return { items: page.items, nextCursor: page.next === null ? null : encodeCursor(page.next) }
}

/** A newest-first page of an Enrollment's log. */
export async function activity(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: EnrollmentId,
  query: { cursor?: string | undefined; limit?: number | undefined }
) {
  await loadEnrollment(deps, caller, id)
  const after = cursorOf(query.cursor, enrollmentActivityCursorSchema)
  const page = await deps.enrollments.activity(
    caller.organizationId,
    id,
    after,
    pageSize(query.limit)
  )
  return { items: page.items, nextCursor: page.next === null ? null : encodeCursor(page.next) }
}

/** Takes an Enrollment out of its Campaign; an Enrollment already ended answers as it is. */
export async function remove(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: EnrollmentId
): Promise<Enrollment> {
  const found = await loadEnrollment(deps, caller, id)
  const me = await deps.access.membershipIdOf(caller.organizationId, caller.userId)
  const result = await deps.enrollments.stop(
    caller.organizationId,
    id,
    'removed_by_rep',
    deps.clock.now().toISOString(),
    me
  )
  if (result === null) {
    throw domainError(errorOf('enrollment.not_found'))
  }
  if (result.stopped) {
    // There is no event bus yet; the stop is logged by id until one exists.
    deps.logger.info('enrollment.stopped', {
      organizationId: caller.organizationId,
      campaignId: found.campaignId,
      enrollmentId: id,
      prospectId: found.prospectId,
      stopReason: 'removed_by_rep',
    })
  }
  return result.enrollment
}
