import { ProviderError } from '~/ports/enrichment-provider'

/** Options for {@link createCircuit}. */
export type CircuitOptions = {
  /** Consecutive failures that open the circuit. */
  failures: number
  /** How long an open circuit refuses calls before one trial call, in ms. */
  openMs: number
  now: () => number
}

/**
 * A circuit breaker for one vendor. Consecutive outage-like failures (timeout, 5xx, unreadable answer) open it; while open it throws `provider_error` without calling; after `openMs`
 * one trial call is let through. A rejected key or a rate limit is one Organization's account, so it never counts.
 * It lives in this process: each instance learns of an outage on its own.
 */
export function createCircuit(options: CircuitOptions) {
  let failures = 0
  let openedAt: number | null = null
  let trial = false
  return async function guard<T>(call: () => Promise<T>): Promise<T> {
    if (openedAt !== null) {
      if (trial || options.now() - openedAt < options.openMs) {
        throw new ProviderError('provider_error')
      }
      trial = true
    }
    try {
      const value = await call()
      failures = 0
      openedAt = null
      trial = false
      return value
    } catch (error) {
      // One Organization's key or quota says nothing about the vendor, so those never count.
      const accountLevel =
        error instanceof ProviderError &&
        (error.failure === 'key_rejected' || error.failure === 'rate_limited')
      if (!accountLevel) {
        failures += 1
        if (openedAt !== null || failures >= options.failures) {
          openedAt = options.now()
        }
      } else if (trial) {
        // A trial that reached the vendor and was refused for the account: the vendor is up.
        openedAt = null
        failures = 0
      }
      trial = false
      throw error
    }
  }
}
