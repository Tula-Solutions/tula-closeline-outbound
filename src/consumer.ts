import type { ErrorReporter, Logger, ProcessedStore, Queue, Sleep } from 'tula-closeline-kit'
import { type Consumer, createConsumer, type Handlers } from 'tula-closeline-kit/queue'
import type { OutboundEnvelope } from '~/messages'

/** The consumer's name: part of every idempotency key of the processed store. */
export const CONSUMER_NAME = 'outbound.enrichment'

/** What {@link createOutboundConsumer} wires together. */
export type OutboundConsumerOptions = {
  queue: Queue<OutboundEnvelope>
  store: ProcessedStore
  logger: Logger
  errorReporter: ErrorReporter
  handlers: Handlers<OutboundEnvelope>
  /** Messages handled at once. */
  concurrency: number
  /** Waits for timers; tests pass virtual time. */
  sleep?: Sleep
}

/** The queue consumer of this service: idempotent through the processed store, stopped by `stop`. */
export function createOutboundConsumer(options: OutboundConsumerOptions): Consumer {
  return createConsumer({
    name: CONSUMER_NAME,
    queue: options.queue,
    store: options.store,
    logger: options.logger,
    errorReporter: options.errorReporter,
    handlers: options.handlers,
    concurrency: options.concurrency,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  })
}
