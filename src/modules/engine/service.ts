import {
  type Campaign,
  type Enrollment,
  type EnrollmentEvent,
  type EnrollmentId,
  formatId,
  MAX_ATTEMPT_EPOCH,
  type OrganizationId,
  organizationIdSchema,
  type ProspectId,
  type Sequence,
  type Step,
  type VariantGroup,
} from 'tula-closeline-contract'
import type { Handlers } from 'tula-closeline-kit/queue'
import { type OutboundEnvelope, registry } from '~/messages'
import { isOpen, nextOpen } from '~/modules/send/window'
import { assignVariant } from '~/modules/variant/assign'
import { measureStep } from '~/modules/variant/service'
import type { ApprovalReason } from '~/ports/engine'
import type { Transition } from '~/ports/enrollment-store'
import { send } from '../send/service'
import { branchTarget } from './branch'
import type { EngineDeps } from './deps'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** How long a non-running Campaign's Enrollment waits before it looks again. */
export const PAUSED_RECHECK_MS = 15 * MINUTE_MS
/** How long an Enrollment waits after a send that failed or had no usable Mailbox. */
export const RETRY_MS = HOUR_MS
/**
 * How long a Draft waits for a Rep before the Step looks again.
 * shortcut: approving a Draft does not move the Enrollment yet (M09); upgrade then.
 */
export const APPROVAL_RECHECK_MS = 24 * HOUR_MS

/** Organization pages one sweep walks at most, so a tick stays bounded. */
const MAX_ORG_PAGES = 10
const PUBLISH_CHUNK = 10
const MAILBOX_PAGE = 20
/** The share of sends after which an automatic test looks for a winner. */
const AUTO_PROMOTE_SAMPLE = 0.05

type StopReason = NonNullable<Enrollment['stopReason']>
type StepMessage = Extract<OutboundEnvelope, { type: 'enrollment.step' }>['payload']

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

/**
 * One sweep tick: asks which Organizations have Enrollments due, claims a page of each (their
 * due time moves to the end of the lease) and queues one message per Enrollment. The work is the
 * due rows in a page, never the size of an Organization. Returns how many messages were queued.
 */
export async function sweep(deps: EngineDeps): Promise<number> {
  const now = deps.clock.now()
  const lease = new Date(now.getTime() + deps.limits.leaseSeconds * 1000)
  let queued = 0
  // Starting at a random Organization and wrapping to the beginning gives every Organization a
  // turn over time; a fixed start would let a backlog in the first pages starve the rest.
  // shortcut: random, not a stored cursor, so some Organizations are visited twice in a tick
  // (the lease makes that harmless); a persisted cursor needs a db table, add it if skew shows.
  let after: string | null = `org_${Math.floor(deps.random() * 2 ** 32)
    .toString(16)
    .padStart(8, '0')}${'0'.repeat(24)}`
  let wrapped = false
  for (let page = 0; page < MAX_ORG_PAGES; page++) {
    const orgs = await deps.enrollments.dueOrganizations(
      after,
      deps.limits.orgBatch,
      now.toISOString()
    )
    for (const organizationId of orgs.organizationIds) {
      const due = await deps.enrollments.claimDue(
        organizationId,
        now.toISOString(),
        lease.toISOString(),
        deps.limits.stepPage
      )
      const envelopes = due.flatMap((e) =>
        e.currentStepKey === null
          ? []
          : [
              registry.create({
                // Names the lease too, so a later legitimate run of the same Step is not dropped.
                id: `enrollment.step:${e.id}:${e.currentStepKey}:${e.attemptEpoch}:${lease.getTime()}`,
                type: 'enrollment.step',
                payload: {
                  enrollmentId: e.id,
                  stepKey: e.currentStepKey,
                  attemptEpoch: e.attemptEpoch,
                },
                traceId: crypto.randomUUID(),
                organizationId,
              }),
            ]
      )
      for (let start = 0; start < envelopes.length; start += PUBLISH_CHUNK) {
        const result = await deps.queue.publishBatch(envelopes.slice(start, start + PUBLISH_CHUNK))
        queued += result.sent.length
        if (result.failed.length > 0) {
          deps.logger.warn('enrollment steps were not queued; the lease will release them', {
            failed: result.failed.length,
          })
        }
      }
    }
    after = orgs.next
    if (after === null) {
      if (wrapped) {
        break
      }
      wrapped = true
    }
  }
  return queued
}

/**
 * Stops every active Enrollment of a Prospect (a reply, a bounce, an unsubscribe, an erasure) so
 * no later Step sends. Logs by id only. Returns how many Enrollments it ended.
 */
export async function stopForProspect(
  deps: EngineDeps,
  organizationId: OrganizationId,
  prospectId: ProspectId,
  reason: StopReason
): Promise<number> {
  const at = deps.clock.now().toISOString()
  let stopped = 0
  for (;;) {
    const active = await deps.enrollments.activeOfProspect(organizationId, prospectId, 100)
    let progress = 0
    for (const enrollment of active) {
      const result = await deps.enrollments.stop(organizationId, enrollment.id, reason, at, null)
      if (result?.stopped) {
        progress++
        stopped++
        deps.logger.info('enrollment.stopped', { enrollmentId: enrollment.id, reason })
      }
    }
    if (active.length < 100 || progress === 0) {
      return stopped
    }
  }
}

type Run = {
  deps: EngineDeps
  organizationId: OrganizationId
  enrollment: Enrollment
  campaign: Campaign
  sequence: Sequence
  now: Date
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Leaves the Enrollment on its Step and looks again at `dueAt`, optionally as a new attempt. */
function hold(run: Run, dueAt: number, events: EnrollmentEvent[] = [], bump = false) {
  const { enrollment } = run
  if (enrollment.currentStepKey === null || enrollment.currentStep === null) {
    return Promise.resolve(null)
  }
  const epoch = enrollment.attemptEpoch + (bump ? 1 : 0)
  return run.deps.enrollments.advance(
    run.organizationId,
    enrollment.id,
    { stepKey: enrollment.currentStepKey, attemptEpoch: enrollment.attemptEpoch },
    {
      state: 'active',
      currentStepKey: enrollment.currentStepKey,
      currentStep: enrollment.currentStep,
      attemptEpoch: Math.min(epoch, MAX_ATTEMPT_EPOCH),
      nextDueAt: iso(dueAt),
    },
    events
  )
}

/** Moves the Enrollment to the Step `targetKey` (a new attempt, so a revisited Step never reuses a key). */
function moveTo(run: Run, targetKey: string, dueAt: number, events: EnrollmentEvent[]) {
  const { enrollment, deps, organizationId, sequence } = run
  const index = sequence.steps.findIndex((s) => s.key === targetKey)
  if (enrollment.currentStepKey === null || index === -1) {
    deps.logger.error('sequence step is missing', { enrollmentId: enrollment.id })
    return Promise.resolve(null)
  }
  if (enrollment.attemptEpoch >= MAX_ATTEMPT_EPOCH) {
    deps.logger.error('enrollment reached its last attempt', { enrollmentId: enrollment.id })
    return Promise.resolve(null)
  }
  const at = run.now.toISOString()
  const to: Transition = {
    state: 'active',
    currentStepKey: targetKey,
    currentStep: index,
    attemptEpoch: enrollment.attemptEpoch + 1,
    nextDueAt: iso(dueAt),
  }
  return deps.enrollments.advance(
    organizationId,
    enrollment.id,
    { stepKey: enrollment.currentStepKey, attemptEpoch: enrollment.attemptEpoch },
    to,
    [...events, eventOf(enrollment.id, 'step_entered', at, { stepKey: targetKey })]
  )
}

async function stop(run: Run, reason: StopReason) {
  const at = run.now.toISOString()
  const result = await run.deps.enrollments.stop(
    run.organizationId,
    run.enrollment.id,
    reason,
    at,
    null
  )
  if (result?.stopped) {
    run.deps.logger.info('enrollment.stopped', { enrollmentId: run.enrollment.id, reason })
  }
}

/** The variant of the Step's test this Prospect gets: the winner if one is promoted, else the hash's pick. */
async function variantOf(run: Run, group: VariantGroup, stepKey: string) {
  const { deps, organizationId, campaign, enrollment } = run
  const promotion = await deps.campaigns.promotionOf(
    organizationId,
    campaign.id,
    campaign.sequenceVersion,
    stepKey
  )
  return assignVariant(
    { prospectId: enrollment.prospectId, campaignId: campaign.id, stepKey },
    group.variants,
    promotion?.variantKey ?? null
  )
}

/**
 * Looks at the Step's results so a clear winner is promoted (automatic mode only).
 * shortcut: checked on a sample of sends, not each, because the counts scan the Campaign's log;
 * a promotion can lag by a few dozen sends, and a read of the results also promotes.
 */
async function settleTest(run: Run, group: VariantGroup, stepKey: string) {
  const { deps, organizationId, campaign } = run
  try {
    await measureStep(
      {
        store: deps.campaigns,
        enrollments: deps.enrollments,
        clock: deps.clock,
        logger: deps.logger,
      },
      organizationId,
      campaign,
      stepKey,
      group
    )
  } catch (error) {
    // The send is done; a failed look for a winner must not fail the Step.
    deps.logger.warn('variant check failed', {
      enrollmentId: run.enrollment.id,
      code: codeOf(error),
    })
  }
}

async function runEmail(run: Run, step: Extract<Step, { kind: 'email' }>) {
  const { deps, organizationId, enrollment, campaign, now } = run
  const at = now.toISOString()
  const stepKey = step.key
  const contact = await deps.contacts.resolve(organizationId, enrollment.prospectId)
  if (contact === null) {
    // An unknown address is not a bad one: hold and ask again (the contact source may be a stand-in).
    await hold(run, now.getTime() + RETRY_MS)
    return
  }
  const zone =
    campaign.windowZone === 'prospect' && contact.timeZone !== null
      ? contact.timeZone
      : campaign.sendWindow.timeZone
  const window = { ...campaign.sendWindow, timeZone: zone }
  if (!isOpen(window, now)) {
    await hold(run, nextOpen(window, now).getTime(), [
      eventOf(enrollment.id, 'deferred', at, { stepKey }),
    ])
    return
  }
  const verdict = await deps.send.guard.check({
    organizationId,
    prospectId: enrollment.prospectId,
    channel: 'email',
    purpose: 'agent_initiated',
  })
  const refusal = verdict.allowed
    ? null
    : verdict.code === 'consent.suppressed'
      ? 'suppressed'
      : 'no_consent'
  if (refusal !== null) {
    return stop(run, refusal)
  }
  const variant = step.variants === null ? null : await variantOf(run, step.variants, stepKey)
  const draft = await deps.drafts.obtain(organizationId, {
    prospectId: enrollment.prospectId,
    campaignId: campaign.id,
    stepKey,
    goal: step.goal,
    ...(variant === null ? {} : { variant: { key: variant.key, angle: variant.angle } }),
  })
  const reasons: ApprovalReason[] = []
  if (draft.ungrounded) {
    reasons.push('ungrounded')
  } else if (!draft.autoSendable) {
    reasons.push('check_failed')
  }
  if (campaign.approvalMode === 'review') {
    reasons.push('review_mode')
  }
  if (reasons.length > 0) {
    await deps.approvals.request(organizationId, {
      draftId: draft.id,
      enrollmentId: enrollment.id,
      prospectId: enrollment.prospectId,
      campaignId: campaign.id,
      stepKey,
      reasons,
    })
    await hold(run, now.getTime() + APPROVAL_RECHECK_MS, [
      eventOf(enrollment.id, 'deferred', at, { stepKey }),
    ])
    return
  }
  const key = {
    enrollmentId: enrollment.id,
    step: enrollment.currentStep ?? 0,
    attemptEpoch: enrollment.attemptEpoch,
  }
  const mailboxes = await deps.send.mailboxes.store.list(
    organizationId,
    campaign.ownerMembershipId === null ? {} : { visibleOwners: [campaign.ownerMembershipId] },
    null,
    MAILBOX_PAGE
  )
  let decision = await deps.send.store.find(
    organizationId,
    `${key.enrollmentId}:${key.step}:${key.attemptEpoch}`
  )
  if (decision === null || decision.state === 'deferred') {
    try {
      decision = await send(deps.send, organizationId, {
        campaignId: campaign.id,
        prospectId: enrollment.prospectId,
        key,
        draftId: draft.id,
        recipient: { email: contact.email, verified: contact.verified },
        acceptUnverified: false,
        ...(contact.timeZone === null ? {} : { prospectTimeZone: contact.timeZone }),
        mailboxIds: mailboxes.items.filter((m) => m.state !== 'disconnected').map((m) => m.id),
        message: { subject: draft.subject, text: draft.body },
      })
    } catch (error) {
      // A repeated run settles the same key first; the provider failure leaves its row for reconcile.
      deps.logger.warn('send did not complete', {
        enrollmentId: enrollment.id,
        code: codeOf(error),
      })
      decision = await deps.send.store.find(
        organizationId,
        `${key.enrollmentId}:${key.step}:${key.attemptEpoch}`
      )
      if (decision === null || decision.state === 'failed') {
        await hold(run, now.getTime() + RETRY_MS, [], true)
        return
      }
    }
  }
  switch (decision.state) {
    case 'sent': {
      await moveTo(run, step.next, now.getTime(), [
        eventOf(enrollment.id, 'sent', at, {
          stepKey,
          sendId: decision.id,
          variantKey: variant?.key ?? null,
        }),
      ])
      if (step.variants?.promotion.mode === 'auto' && deps.random() < AUTO_PROMOTE_SAMPLE) {
        await settleTest(run, step.variants, stepKey)
      }
      return
    }
    case 'deferred': {
      const retry =
        decision.retryAt === null ? now.getTime() + RETRY_MS : new Date(decision.retryAt).getTime()
      await hold(run, retry, [eventOf(enrollment.id, 'deferred', at, { stepKey })])
      return
    }
    case 'refused': {
      const reason = decision.reason
      if (reason === 'suppressed' || reason === 'no_consent' || reason === 'unverified_address') {
        return stop(run, reason)
      }
      if (reason === 'campaign_not_running') {
        await hold(run, now.getTime() + PAUSED_RECHECK_MS)
        return
      }
      await hold(
        run,
        now.getTime() + RETRY_MS,
        [eventOf(enrollment.id, 'refused', at, { stepKey })],
        true
      )
      return
    }
    case 'failed': {
      await hold(run, now.getTime() + RETRY_MS, [], true)
      return
    }
    default:
    // `sending`: another run owns it; reconcile settles it and the lease brings us back.
  }
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown'
}

/**
 * Runs the Step an Enrollment is on. Does nothing unless the Enrollment is still active at that
 * Step and attempt, so a repeated or late message is harmless; every move is a conditional write
 * and every send is keyed (Enrollment, Step, attempt epoch).
 */
export async function runStep(
  deps: EngineDeps,
  organizationId: OrganizationId,
  message: StepMessage
): Promise<void> {
  const enrollment = await deps.enrollments.find(organizationId, message.enrollmentId)
  if (
    enrollment === null ||
    enrollment.state !== 'active' ||
    enrollment.currentStepKey !== message.stepKey ||
    enrollment.attemptEpoch !== message.attemptEpoch
  ) {
    return
  }
  const campaign = await deps.campaigns.find(organizationId, enrollment.campaignId)
  if (campaign === null) {
    deps.logger.error('enrollment has no campaign', { enrollmentId: enrollment.id })
    return
  }
  const now = deps.clock.now()
  const base = { deps, organizationId, enrollment, campaign, now }
  const sequence = await deps.campaigns.readSequence(
    organizationId,
    campaign.id,
    campaign.sequenceVersion
  )
  const run = { ...base, sequence: sequence ?? { steps: [] } } as Run
  if (campaign.state === 'archived') {
    return stop(run, 'campaign_archived')
  }
  if (campaign.state !== 'running') {
    // shortcut: a paused Campaign's rows are re-leased every 15 minutes; a join in claimDue would avoid it.
    await hold(run, now.getTime() + PAUSED_RECHECK_MS)
    return
  }
  const step = sequence?.steps.find((s) => s.key === message.stepKey)
  if (step === undefined) {
    deps.logger.error('sequence step is missing', { enrollmentId: enrollment.id })
    return
  }
  const at = now.toISOString()
  switch (step.kind) {
    case 'email':
      return runEmail(run, step)
    case 'wait':
      await moveTo(run, step.next, now.getTime() + step.waitHours * HOUR_MS, [])
      return
    case 'branch': {
      const lastSentAt = await deps.enrollments.lastEventAt(organizationId, enrollment.id, 'sent')
      const target = branchTarget(step, { now, lastSentAt })
      await moveTo(run, target, now.getTime(), [
        eventOf(enrollment.id, 'branch_taken', at, { stepKey: target }),
      ])
      return
    }
    case 'rep_task':
      await moveTo(run, step.next, now.getTime() + step.dueInHours * HOUR_MS, [
        eventOf(enrollment.id, 'rep_task_created', at, { stepKey: step.key }),
      ])
      return
    case 'end':
      await deps.enrollments.advance(
        organizationId,
        enrollment.id,
        { stepKey: step.key, attemptEpoch: enrollment.attemptEpoch },
        { state: 'completed', at },
        [eventOf(enrollment.id, 'completed', at)]
      )
      return
  }
}

/** The queue handlers of the engine. */
export function engineHandlers(deps: EngineDeps): Handlers<OutboundEnvelope> {
  return {
    'enrollment.step': async (message, context) => {
      await runStep(deps, organizationIdSchema.parse(context.organizationId), message.payload)
    },
  }
}
