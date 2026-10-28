import {
  campaignIdSchema,
  enrichmentRunIdSchema,
  enrollmentIdSchema,
  MAX_ATTEMPT_EPOCH,
  prospectIdSchema,
  roleSchema,
  stepKeySchema,
  timestampSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import { createMessageRegistry, defineMessage, type EnvelopeOf } from 'tula-closeline-kit'
import { z } from 'zod'

/**
 * Asks the consumer to run one enrichment run. Local to this service because the contract has no
 * such message: only this service publishes and consumes it. The run row is the source of truth,
 * so a lost or repeated message changes nothing.
 */
export const enrichmentRun = defineMessage({
  type: 'enrichment.run',
  version: 1,
  scope: 'organization',
  payload: z.object({ runId: enrichmentRunIdSchema, prospectId: prospectIdSchema }),
})

const countSoFar = z.number().int().min(0)

/**
 * Asks the consumer to check one page of a Campaign's audience: it carries the running counts and
 * the cursor, and the handler publishes the next page, so no step holds the whole audience.
 * `requestedAt` names the check; a page of a superseded check is dropped.
 */
export const audienceCheckPage = defineMessage({
  type: 'audience.check_page',
  version: 1,
  scope: 'organization',
  payload: z.object({
    campaignId: campaignIdSchema,
    audienceVersion: z.number().int().min(0),
    requestedAt: timestampSchema,
    cursor: z.string().max(200).nullable(),
    viewer: z.object({ userId: userIdSchema, role: roleSchema }),
    counts: z.object({
      total: countSoFar,
      verified: countSoFar,
      suppressed: countSoFar,
      noConsent: countSoFar,
      activeInOtherCampaign: countSoFar,
      eligible: countSoFar,
    }),
  }),
})

/**
 * Asks the consumer to run one Step of one Enrollment at one attempt epoch. The Enrollment row is
 * the source of truth: the handler does nothing unless the Enrollment is still active at that
 * Step and epoch, so a repeated or late message changes nothing.
 */
export const enrollmentStep = defineMessage({
  type: 'enrollment.step',
  version: 1,
  scope: 'organization',
  payload: z.object({
    enrollmentId: enrollmentIdSchema,
    stepKey: stepKeySchema,
    attemptEpoch: z.number().int().min(0).max(MAX_ATTEMPT_EPOCH),
  }),
})

/** Every message type this service's queue carries. */
export type OutboundDefinition =
  | typeof enrichmentRun
  | typeof audienceCheckPage
  | typeof enrollmentStep

/** An envelope of any type this service's queue carries. */
export type OutboundEnvelope = EnvelopeOf<OutboundDefinition>

/** Validates and builds the envelopes of {@link OutboundDefinition}; shared by the queue and publishers. */
export const registry = createMessageRegistry([enrichmentRun, audienceCheckPage, enrollmentStep])
