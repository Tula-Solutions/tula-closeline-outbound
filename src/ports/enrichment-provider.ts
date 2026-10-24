import type { EnrichedFieldName, FieldGroup, ProviderKey } from 'tula-closeline-contract'

/** The values a Prospect already has, by field; a field that is missing or empty is absent. */
export type ProspectValues = Partial<Record<EnrichedFieldName, string>>

/** Why one provider call failed, in the contract's words (`ATTEMPT_FAILURES`). */
export type ProviderFailure =
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_response'
  | 'key_rejected'

/** What a provider adapter throws when its call fails; any other error counts as `provider_error`. */
export class ProviderError extends Error {
  readonly failure: ProviderFailure

  constructor(failure: ProviderFailure) {
    super(`provider call failed: ${failure}`)
    this.name = 'ProviderError'
    this.failure = failure
  }
}

/** One field a provider found. `value` is untrusted text: the waterfall bounds and cleans it. */
export type FoundField = {
  field: EnrichedFieldName
  value: string
  /** 0 to 100: how sure the provider is. */
  confidence: number
}

/** What a lookup is asked. */
export type LookupRequest = {
  /** The fields still missing for the group being filled; the provider fills none other. */
  wanted: readonly EnrichedFieldName[]
  /** What is already known about the Prospect, to search by. */
  known: ProspectValues
  /** The Organization's own key for this provider. Never logged. */
  apiKey: string
  /** Aborts when the call has run out of time. */
  signal: AbortSignal
}

/** A source of person or company data. An empty result means the provider found nothing. */
export type EnrichmentProvider = {
  key: ProviderKey
  /** The groups this provider can fill: `person` and/or `company`. */
  groups: readonly FieldGroup[]
  /** What one call costs the Organization, in micro-dollars, whether or not it finds anything. */
  priceMicros: number
  /** Looks one Prospect up; throws {@link ProviderError} on failure. */
  lookup: (request: LookupRequest) => Promise<readonly FoundField[]>
}

/** The verdict of an email verifier, in the contract's words. */
export type Verdict = {
  status: 'valid' | 'risky' | 'invalid'
  reason:
    | 'accepted'
    | 'catch_all'
    | 'role_based'
    | 'disposable'
    | 'mailbox_full'
    | 'mailbox_not_found'
    | 'domain_invalid'
    | 'unknown'
}

/** A source of email verification. */
export type EmailVerifier = {
  key: ProviderKey
  /** What one call costs the Organization, in micro-dollars. */
  priceMicros: number
  /** Checks one address; throws {@link ProviderError} on failure. */
  verify: (request: { email: string; apiKey: string; signal: AbortSignal }) => Promise<Verdict>
}
