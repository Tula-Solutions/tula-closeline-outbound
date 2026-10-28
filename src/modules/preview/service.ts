import {
  type CampaignId,
  ERRORS,
  MAX_PREVIEW_PROSPECTS,
  MESSAGING_ERRORS,
  PREVIEW_FAILURE_CODES,
  type PreviewRequest,
  type PreviewResult,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import { domainError } from '~/http/domain-error'
import type { CampaignDeps } from '~/modules/campaign/deps'
import * as Campaigns from '~/modules/campaign/service'
import type { DraftDeps } from '~/modules/draft/deps'
import * as Drafts from '~/modules/draft/service'

/** What the preview needs: the Campaign module to read the Sequence and the Draft module to write. */
export type PreviewDeps = { campaigns: CampaignDeps; drafts: DraftDeps }

/** Who is calling: a Campaign caller that also carries their own bearer for core's view rules. */
export type PreviewCaller = Campaigns.CampaignCaller & Drafts.DraftCaller

const failureCodes: readonly string[] = PREVIEW_FAILURE_CODES

/**
 * Shows what an email Step would send to up to five Prospects, as a Brief and Draft each, or the
 * failure code that stopped that Prospect. It stores no Draft, sends nothing and touches no Prospect,
 * consent or suppression state. A Prospect outside the caller's view fails the whole call.
 */
export async function previewCampaign(
  deps: PreviewDeps,
  caller: PreviewCaller,
  campaignId: CampaignId,
  body: PreviewRequest,
  idempotencyKey: string
): Promise<PreviewResult> {
  if (body.prospectIds.length > MAX_PREVIEW_PROSPECTS) {
    throw domainError(MESSAGING_ERRORS['preview.too_many_prospects'])
  }
  const sequence = await Campaigns.getSequence(deps.campaigns, caller, campaignId)
  if (sequence.version !== body.sequenceVersion) {
    throw domainError(Campaigns.errorOf('campaign.sequence_version_conflict'))
  }
  const step = sequence.steps.find((s) =>
    body.stepKey === undefined ? s.kind === 'email' : s.key === body.stepKey
  )
  if (step?.kind !== 'email') {
    throw domainError(ERRORS['request.invalid'])
  }
  await Promise.all(body.prospectIds.map((id) => Drafts.assertVisible(deps.drafts, caller, id)))
  const items = await Promise.all(
    body.prospectIds.map(async (prospectId) => {
      try {
        const { draft, brief } = await Drafts.previewDraft(
          deps.drafts,
          caller.organizationId,
          { prospectId, campaignId, stepKey: step.key, goal: step.goal },
          `preview:${campaignId}:${idempotencyKey}:${prospectId}`
        )
        return { prospectId, brief, draft, failureCode: null }
      } catch (error) {
        if (error instanceof AppError && failureCodes.includes(error.code)) {
          return { prospectId, brief: null, draft: null, failureCode: error.code }
        }
        throw error
      }
    })
  )
  return { sequenceVersion: sequence.version, stepKey: step.key, items } as PreviewResult
}
