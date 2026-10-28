import type {
  Campaign,
  CampaignId,
  OrganizationId,
  StepVariantResults,
  VariantGroup,
} from 'tula-closeline-contract'
import type { Clock, Logger } from 'tula-closeline-kit'
import { domainError } from '~/http/domain-error'
import type { CampaignDeps } from '~/modules/campaign/deps'
import { type CampaignCaller, errorOf, loadVisible } from '~/modules/campaign/service'
import type { CampaignStore, Promotion } from '~/ports/campaign-store'
import type { EnrollmentStore } from '~/ports/enrollment-store'
import { clearWinner, measure } from './stats'

/** What the variant functions need; a `CampaignDeps` and the engine's deps both provide it. */
export type VariantDeps = {
  store: CampaignStore
  enrollments: EnrollmentStore
  clock: Clock
  logger: Logger
}

/** The test on a Step of the Campaign's current Sequence, or `variant.not_found` when it has none. */
async function testOf(
  deps: VariantDeps,
  organizationId: OrganizationId,
  campaign: Campaign,
  stepKey: string
): Promise<VariantGroup> {
  const sequence = await deps.store.readSequence(
    organizationId,
    campaign.id,
    campaign.sequenceVersion
  )
  const step = sequence?.steps.find((s) => s.key === stepKey)
  if (step === undefined || step.kind !== 'email' || step.variants === null) {
    throw domainError(errorOf('variant.not_found'))
  }
  return step.variants
}

/** Writes the winner (the first one stays if two race) and logs the change by ids only. */
async function record(
  deps: VariantDeps,
  organizationId: OrganizationId,
  campaign: Campaign,
  stepKey: string,
  promotion: Promotion
) {
  const stored = await deps.store.promote(
    organizationId,
    campaign.id,
    campaign.sequenceVersion,
    stepKey,
    promotion
  )
  if (stored.created) {
    // The audit entry: no event bus carries `variant.promoted` yet, so it is logged.
    deps.logger.info('variant.promoted', {
      organizationId,
      campaignId: campaign.id,
      stepKey,
      variantKey: promotion.variantKey,
      mode: promotion.source,
      promotedByMembershipId: promotion.promotedByMembershipId,
      promotedAt: promotion.promotedAt,
    })
  }
  return stored
}

/**
 * The results of a Step's test. With automatic promotion on and no winner yet, a clear winner
 * (every variant at the sample, the leader ahead by the margin) is promoted here. The counts are
 * per-variant tallies, so this costs the number of variants.
 */
export async function measureStep(
  deps: VariantDeps,
  organizationId: OrganizationId,
  campaign: Campaign,
  stepKey: string,
  group: VariantGroup
): Promise<StepVariantResults> {
  let promotion = await deps.store.promotionOf(
    organizationId,
    campaign.id,
    campaign.sequenceVersion,
    stepKey
  )
  const counts = await deps.enrollments.variantCounts(
    organizationId,
    campaign.id,
    campaign.sequenceVersion,
    stepKey
  )
  const measured = measure(group, counts)
  if (promotion === null && group.promotion.mode === 'auto') {
    const winner = clearWinner(measured.variants, group.promotion.marginPercentagePoints)
    if (measured.status === 'measured' && winner !== null) {
      const now = deps.clock.now().toISOString()
      promotion = (
        await record(deps, organizationId, campaign, stepKey, {
          variantKey: winner,
          source: 'auto',
          promotedByMembershipId: null,
          promotedAt: now,
        })
      ).promotion
    }
  }
  return {
    campaignId: campaign.id,
    stepKey,
    ...measured,
    promotion,
    computedAt: deps.clock.now().toISOString(),
  }
}

/** The results of one email Step's variants, for any role that can see the Campaign. */
export async function results(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId,
  stepKey: string
): Promise<StepVariantResults> {
  const { campaign } = await loadVisible(deps, caller, id)
  const group = await testOf(deps, caller.organizationId, campaign, stepKey)
  return measureStep(deps, caller.organizationId, campaign, stepKey, group)
}

/** Promotes a variant by hand; the same variant again answers the winner, another is refused. */
export async function promote(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId,
  stepKey: string,
  variantKey: string
): Promise<Promotion> {
  const { campaign, view } = await loadVisible(deps, caller, id)
  const group = await testOf(deps, caller.organizationId, campaign, stepKey)
  if (!group.variants.some((variant) => variant.key === variantKey)) {
    throw domainError(errorOf('variant.not_found'))
  }
  const { promotion } = await record(deps, caller.organizationId, campaign, stepKey, {
    variantKey,
    source: 'manual',
    promotedByMembershipId: view.me,
    promotedAt: deps.clock.now().toISOString(),
  })
  if (promotion.variantKey !== variantKey) {
    throw domainError(errorOf('variant.already_promoted'))
  }
  return promotion
}
