import { organizationIdSchema } from 'tula-closeline-contract'
import type { Handlers } from 'tula-closeline-kit/queue'
import type { OutboundEnvelope } from '~/messages'
import type { EnrichmentDeps } from '~/modules/enrichment/deps'
import * as Waterfall from '~/modules/enrichment/waterfall'

/**
 * The queue handler of each enrichment message. A run held by another worker throws, so the queue
 * delivers the message again later. Nothing is published when a run ends: no consumer handles such
 * an event yet, and a type with no handler would end in the dead-letter queue.
 */
export function enrichmentHandlers(deps: EnrichmentDeps): Handlers<OutboundEnvelope> {
  return {
    'enrichment.run': async (message, context) => {
      const organizationId = organizationIdSchema.parse(context.organizationId)
      await Waterfall.execute(deps, organizationId, message.payload.runId)
    },
  }
}
