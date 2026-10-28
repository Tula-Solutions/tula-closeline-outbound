import type { FetchLike } from '~/adapters/providers/vendor-call'

/** Bounds shared by the model and web search adapters. */
export type VendorBounds = {
  /** Bound for one HTTP try, in ms. */
  timeoutMs: number
  /** Most tries (at least 1); only a timeout, 429 or 5xx is repeated. */
  maxTries: number
  /** First retry delay, in ms; doubles each try, with jitter. */
  retryBaseMs: number
  fetch?: FetchLike
  sleep: (ms: number) => Promise<void>
  /** Returns a number in [0, 1); used for jitter. */
  random: () => number
}

/** How a vendor call failed, in fixed words (never vendor text, never the key). */
export type VendorFailure =
  | 'timeout'
  | 'rate_limited'
  | 'key_rejected'
  | 'invalid_response'
  | 'provider_error'

/** What {@link postJson} throws: the failure in fixed words. */
export class VendorCallError extends Error {
  readonly failure: VendorFailure

  constructor(failure: VendorFailure) {
    super(`vendor call failed: ${failure}`)
    this.name = 'VendorCallError'
    this.failure = failure
  }
}

const MAX_RESPONSE_BYTES = 1_000_000

/**
 * POSTs JSON to a vendor and answers the parsed 2xx body. Each try has its own timeout and also
 * ends when `deadline` aborts. Retries a timeout, 429 or 5xx up to `maxTries`, stopping when
 * `deadline` has aborted. The URL, headers and vendor text never enter the thrown value.
 */
export async function postJson(
  bounds: VendorBounds,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  deadline: AbortSignal
): Promise<unknown> {
  const fetchFn = bounds.fetch ?? ((u, init) => fetch(u, init))
  let failure: VendorFailure = 'provider_error'
  for (let attempt = 1; attempt <= Math.max(1, bounds.maxTries); attempt += 1) {
    if (attempt > 1) {
      await bounds.sleep(bounds.retryBaseMs * 2 ** (attempt - 2) * (0.5 + bounds.random()))
    }
    if (deadline.aborted) {
      throw new VendorCallError('timeout')
    }
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(bounds.timeoutMs)])
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      })
      if (response.status === 401 || response.status === 403) {
        throw new VendorCallError('key_rejected')
      }
      if (response.status === 429 || response.status >= 500) {
        failure = response.status === 429 ? 'rate_limited' : 'provider_error'
        continue
      }
      if (response.status < 200 || response.status > 299) {
        throw new VendorCallError('provider_error')
      }
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new VendorCallError('invalid_response')
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new VendorCallError('invalid_response')
      }
    } catch (error) {
      if (error instanceof VendorCallError) {
        throw error
      }
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        failure = 'timeout'
        continue
      }
      failure = 'provider_error'
    }
  }
  throw new VendorCallError(failure)
}
