import { MailTransportError } from '~/ports/mail-transport'

/** What a provider answered: the status and its JSON body (null when empty, not JSON or too large). */
export type Outcome = { status: number; body: unknown }

/** Bounds shared by every Mailbox provider adapter. */
export type ProviderCallOptions = {
  /** Bound for one HTTP call, in ms. */
  timeoutMs: number
  /** Most tries for a call that may be repeated (at least 1). */
  maxTries: number
  /** First retry delay, in ms; doubles each try, with jitter. */
  retryBaseMs: number
  fetch: (input: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  /** Returns a number in [0, 1); used for jitter. */
  random: () => number
}

const MAX_RESPONSE_BYTES = 1_000_000

/**
 * One bounded HTTP call to a Mailbox provider: a timeout per try, jittered backoff, retry on a
 * network error, 429 or 5xx while `retryOn` agrees. Any other status is returned for the caller to read.
 */
export function createProviderCall(options: ProviderCallOptions) {
  return async function call(
    url: string,
    init: RequestInit,
    retryOn: (outcome: Outcome | 'network' | 'timeout') => boolean
  ): Promise<Outcome> {
    let last: MailTransportError = new MailTransportError('unavailable')
    for (let attempt = 1; attempt <= Math.max(1, options.maxTries); attempt += 1) {
      if (attempt > 1) {
        await options.sleep(options.retryBaseMs * 2 ** (attempt - 2) * (0.5 + options.random()))
      }
      let outcome: Outcome | 'network' | 'timeout'
      try {
        const response = await options.fetch(url, {
          ...init,
          signal: AbortSignal.timeout(options.timeoutMs),
        })
        const text = await response.text()
        let body: unknown = null
        if (text.length > 0 && text.length <= MAX_RESPONSE_BYTES) {
          try {
            body = JSON.parse(text)
          } catch {
            body = null
          }
        }
        outcome = { status: response.status, body }
      } catch (error) {
        outcome = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'
      }
      if (typeof outcome !== 'string') {
        if (outcome.status < 500 && outcome.status !== 429) {
          return outcome
        }
        last = new MailTransportError('unavailable', outcome.status)
      } else {
        last = new MailTransportError(outcome === 'timeout' ? 'timeout' : 'unavailable')
      }
      if (!retryOn(outcome)) {
        break
      }
    }
    throw last
  }
}
