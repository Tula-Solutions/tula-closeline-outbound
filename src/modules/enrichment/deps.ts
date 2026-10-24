import type { Clock, Logger, Queue, Sleep } from 'tula-closeline-kit'
import type { OutboundEnvelope } from '~/messages'
import type { CoreAccess, CoreProspects } from '~/ports/core'
import type { EmailVerifier, EnrichmentProvider } from '~/ports/enrichment-provider'
import type { ProviderConfig } from '~/ports/provider-config'
import type { EnrichmentStore } from '~/ports/store'

/** The numbers that bound enrichment work, from the environment. */
export type EnrichmentLimits = {
  /** What an Organization may spend on providers in a calendar month, in micro-dollars. */
  monthlyBudgetMicros: number
  /** What one run may spend, in micro-dollars. */
  runCeilingMicros: number
  /** How long one provider call may take. */
  providerTimeoutMs: number
  /** How many times one provider call is tried, the first included. */
  providerMaxTries: number
  /** The first wait before a retry; it doubles, with jitter. */
  retryBaseMs: number
  /** How long a worker holds a run before another may take it. */
  runLeaseSeconds: number
}

/** What the enrichment module needs from outside the process; a service function takes this first. */
export type EnrichmentDeps = {
  store: EnrichmentStore
  core: CoreProspects
  access: CoreAccess
  config: ProviderConfig
  providers: readonly EnrichmentProvider[]
  verifiers: readonly EmailVerifier[]
  /** The queue the runs are sent through. */
  queue: Queue<OutboundEnvelope>
  clock: Clock
  /** Waits between retries; virtual in tests. */
  sleep: Sleep
  /** A number in [0, 1) for jitter. */
  random: () => number
  logger: Logger
  limits: EnrichmentLimits
}
