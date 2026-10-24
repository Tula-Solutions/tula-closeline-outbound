import { enrichmentRunIdSchema, prospectIdSchema } from 'tula-closeline-contract'
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

/** Every message type this service's queue carries. */
export type OutboundDefinition = typeof enrichmentRun

/** An envelope of any type this service's queue carries. */
export type OutboundEnvelope = EnvelopeOf<OutboundDefinition>

/** Validates and builds the envelopes of {@link OutboundDefinition}; shared by the queue and publishers. */
export const registry = createMessageRegistry([enrichmentRun])
