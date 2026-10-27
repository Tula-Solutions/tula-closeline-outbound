import {
  branchStepSchema,
  emailStepSchema,
  endStepSchema,
  MAX_SEQUENCE_STEPS,
  promotionPolicySchema,
  repTaskStepSchema,
  variantSchema,
  waitStepSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

/**
 * An email Step as the request body carries it: each field checked, but not the cross-field rules
 * of a variant test (weights adding to 100, unique keys, 2 to 4 variants). Those the service
 * answers as `variant.invalid_weights`, not as `request.invalid`.
 */
const looseEmailStepSchema = emailStepSchema.extend({
  variants: z
    .strictObject({ variants: z.array(variantSchema).max(20), promotion: promotionPolicySchema })
    .nullable(),
})

/**
 * The Steps of a `PUT .../sequence` body: 1 to 50, each well-formed, but not yet checked as a
 * graph. The service runs the graph and variant checks so it can name the offending Step in
 * `campaign.invalid_sequence` (the contract's own `sequenceStepsSchema` would answer
 * `request.invalid`).
 */
export const looseStepsSchema = z
  .array(
    z.discriminatedUnion('kind', [
      looseEmailStepSchema,
      waitStepSchema,
      branchStepSchema,
      repTaskStepSchema,
      endStepSchema,
    ])
  )
  .min(1)
  .max(MAX_SEQUENCE_STEPS)

/** The body of `PUT /v1/campaigns/{campaignId}/sequence`, with the loose Steps. */
export const setSequenceBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
  steps: looseStepsSchema,
})
