import {
  type AudienceCheck,
  CAMPAIGN_ERRORS,
  type CampaignId,
  type OrganizationId,
  organizationIdSchema,
  type ProspectId,
} from 'tula-closeline-contract'
import type { Handlers } from 'tula-closeline-kit/queue'
import { domainError } from '~/http/domain-error'
import { type OutboundEnvelope, registry } from '~/messages'
import type { AudienceMember } from '~/ports/audience'
import type { CampaignDeps } from './deps'
import { type CampaignCaller, loadVisible } from './service'

/** How many members one page of an audience check reads. */
export const AUDIENCE_PAGE = 100

/** How many Contact Checks one page runs at once. */
const CHECK_CONCURRENCY = 10

type Counts = Extract<OutboundEnvelope, { type: 'audience.check_page' }>['payload']['counts']

/** Contact-checks the members with a bounded number of calls in flight. */
async function guardAll(
  deps: CampaignDeps,
  organizationId: OrganizationId,
  members: readonly AudienceMember[]
): Promise<Map<ProspectId, 'suppressed' | 'no_consent' | null>> {
  const verdicts = new Map<ProspectId, 'suppressed' | 'no_consent' | null>()
  for (let start = 0; start < members.length; start += CHECK_CONCURRENCY) {
    await Promise.all(
      members.slice(start, start + CHECK_CONCURRENCY).map(async (member) => {
        verdicts.set(member.prospectId, await refusalOf(deps, organizationId, member.prospectId))
      })
    )
  }
  return verdicts
}

/** Asks the Contact Check whether the Prospect may be emailed by an Agent; null means yes. */
export async function refusalOf(
  deps: CampaignDeps,
  organizationId: OrganizationId,
  prospectId: ProspectId
): Promise<'suppressed' | 'no_consent' | null> {
  const result = await deps.guard.check({
    organizationId,
    prospectId,
    channel: 'email',
    purpose: 'agent_initiated',
  })
  if (result.allowed) {
    return null
  }
  return result.code === 'consent.suppressed' ? 'suppressed' : 'no_consent'
}

/** Starts (or returns) the audience check of a visible Campaign and queues its first page. */
export async function start(
  deps: CampaignDeps,
  caller: CampaignCaller,
  campaignId: CampaignId,
  idempotencyKey: string,
  traceId: string
): Promise<AudienceCheck> {
  const { campaign } = await loadVisible(deps, caller, campaignId)
  if (campaign.state === 'archived') {
    throw domainError(CAMPAIGN_ERRORS['campaign.invalid_state'])
  }
  const requestedAt = deps.clock.now().toISOString()
  const { check, started } = await deps.checks.start(
    caller.organizationId,
    campaignId,
    campaign.audienceVersion,
    requestedAt,
    `${caller.userId}:${idempotencyKey}`
  )
  if (started) {
    const message = registry.create({
      type: 'audience.check_page',
      payload: {
        campaignId,
        audienceVersion: campaign.audienceVersion,
        requestedAt,
        cursor: null,
        viewer: { userId: caller.userId, role: caller.role },
        counts: {
          total: 0,
          verified: 0,
          suppressed: 0,
          noConsent: 0,
          activeInOtherCampaign: 0,
          eligible: 0,
        },
      },
      traceId,
      organizationId: caller.organizationId,
    })
    try {
      await deps.queue.publish(message)
    } catch (error) {
      // A check nobody works on must not stay pending and block a fresh one.
      await deps.checks.finish(
        caller.organizationId,
        campaignId,
        requestedAt,
        { state: 'failed' },
        deps.clock.now().toISOString()
      )
      throw error
    }
  }
  return check
}

/** The latest check of a visible Campaign, or null when none was started. */
export async function latest(
  deps: CampaignDeps,
  caller: CampaignCaller,
  campaignId: CampaignId
): Promise<AudienceCheck | null> {
  await loadVisible(deps, caller, campaignId)
  return deps.checks.get(caller.organizationId, campaignId)
}

/** Checks one page of members and queues the next, or records the counts when the audience ends. */
async function runPage(
  deps: CampaignDeps,
  organizationId: OrganizationId,
  message: Extract<OutboundEnvelope, { type: 'audience.check_page' }>
): Promise<void> {
  const { payload } = message
  const current = await deps.checks.get(organizationId, payload.campaignId)
  if (
    current === null ||
    current.state !== 'pending' ||
    current.requestedAt !== payload.requestedAt
  ) {
    return
  }
  const fail = () =>
    deps.checks.finish(
      organizationId,
      payload.campaignId,
      payload.requestedAt,
      { state: 'failed' },
      deps.clock.now().toISOString()
    )
  const campaign = await deps.store.find(organizationId, payload.campaignId)
  if (campaign === null || campaign.audienceVersion !== payload.audienceVersion) {
    await fail()
    return
  }
  const page = await deps.audience.list(
    { organizationId, ...payload.viewer },
    campaign.audience,
    payload.cursor,
    AUDIENCE_PAGE
  )
  const elsewhere = await deps.enrollments.activeElsewhere(
    organizationId,
    payload.campaignId,
    page.items.map((member) => member.prospectId)
  )
  const free = page.items.filter((member) => !elsewhere.has(member.prospectId))
  const verdicts = await guardAll(deps, organizationId, free)
  const counts: Counts = { ...payload.counts }
  for (const member of page.items) {
    counts.total += 1
    counts.verified += member.emailVerified ? 1 : 0
    if (elsewhere.has(member.prospectId)) {
      counts.activeInOtherCampaign += 1
      continue
    }
    const verdict = verdicts.get(member.prospectId)
    if (verdict === 'suppressed') {
      counts.suppressed += 1
    } else if (verdict === 'no_consent') {
      counts.noConsent += 1
    } else {
      counts.eligible += 1
    }
  }
  if (page.next === null) {
    await deps.checks.finish(
      organizationId,
      payload.campaignId,
      payload.requestedAt,
      {
        state: 'ready',
        counts: { ...counts, unverified: counts.total - counts.verified },
      },
      deps.clock.now().toISOString()
    )
    return
  }
  // A refused publish throws, so the queue delivers this page again with the same counts.
  await deps.queue.publish(
    registry.create({
      type: 'audience.check_page',
      payload: { ...payload, cursor: page.next, counts },
      traceId: message.traceId,
      organizationId,
    })
  )
}

/** The queue handlers of the campaign module. */
export function campaignHandlers(deps: CampaignDeps): Handlers<OutboundEnvelope> {
  return {
    'audience.check_page': async (message, context) => {
      await runPage(deps, organizationIdSchema.parse(context.organizationId), message)
    },
  }
}
