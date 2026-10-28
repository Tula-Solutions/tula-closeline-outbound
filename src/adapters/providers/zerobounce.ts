import type { ProviderKey } from 'tula-closeline-contract'
import { type EmailVerifier, ProviderError, type Verdict } from '~/ports/enrichment-provider'
import { type FetchLike, text, vendorJson } from './vendor-call'

/** Options for {@link createZeroBounceVerifier}. */
export type ZeroBounceOptions = {
  /** ZeroBounce's origin, e.g. `https://api.zerobounce.net`. */
  baseUrl: string
  /** One call costs this much, in micro-dollars. */
  priceMicros?: number
  fetch?: FetchLike
  /** Wraps each vendor call, for the circuit. */
  guard?: <T>(call: () => Promise<T>) => Promise<T>
}

/** ZeroBounce's sub-status words and the contract's reason for each. */
const REASONS: Record<string, Verdict['reason']> = {
  role_based: 'role_based',
  role_based_catch_all: 'role_based',
  disposable: 'disposable',
  toxic: 'disposable',
  mailbox_quota_exceeded: 'mailbox_full',
  mailbox_not_found: 'mailbox_not_found',
  no_dns_entries: 'domain_invalid',
  failed_syntax_check: 'domain_invalid',
  possible_typo: 'domain_invalid',
  does_not_accept_mail: 'mailbox_not_found',
}

/** Maps ZeroBounce's status and sub-status to the contract's verdict, or null for a word it does not know. */
function verdictOf(status: string, sub: string): Verdict | null {
  const reason = REASONS[sub]
  switch (status) {
    case 'valid':
      return { status: 'valid', reason: 'accepted' }
    case 'catch-all':
      return { status: 'risky', reason: 'catch_all' }
    case 'unknown':
      return { status: 'risky', reason: reason ?? 'unknown' }
    case 'invalid':
      return { status: 'invalid', reason: reason ?? 'mailbox_not_found' }
    case 'spamtrap':
    case 'abuse':
    case 'do_not_mail':
      return { status: 'invalid', reason: reason ?? 'unknown' }
    default:
      return null
  }
}

/**
 * ZeroBounce as the email verifier (`GET /v2/validate`). ZeroBounce takes the key as a query
 * parameter, so no URL is ever logged or put in an error. It answers 200 with an `error` text for a
 * bad key or no credit; an API-key error is `key_rejected`, no credit `rate_limited` (an account limit), anything else `provider_error`. Retries come from
 * the waterfall.
 */
export function createZeroBounceVerifier(options: ZeroBounceOptions): EmailVerifier {
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const guard = options.guard ?? (<T>(call: () => Promise<T>) => call())
  const base = options.baseUrl.replace(/\/+$/, '')
  return {
    key: 'zerobounce' as ProviderKey,
    priceMicros: options.priceMicros ?? 8_000,
    async verify({ email, apiKey, signal }) {
      const query = new URLSearchParams({ api_key: apiKey, email, ip_address: '' })
      return guard(async () => {
        const answer = await vendorJson(
          fetchFn,
          `${base}/v2/validate?${query}`,
          { method: 'GET' },
          signal
        )
        const status = text(answer, 'status')
        if (status === undefined) {
          throw new ProviderError(
            /api.?key/i.test(text(answer, 'error') ?? '')
              ? 'key_rejected'
              : /credit/i.test(text(answer, 'error') ?? '')
                ? 'rate_limited'
                : 'provider_error'
          )
        }
        const verdict = verdictOf(
          status.toLowerCase(),
          (text(answer, 'sub_status') ?? '').toLowerCase()
        )
        if (verdict === null) {
          throw new ProviderError('invalid_response')
        }
        return verdict
      })
    },
  }
}
