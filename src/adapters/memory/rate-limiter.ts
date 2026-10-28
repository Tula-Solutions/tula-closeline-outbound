import type { Clock } from 'tula-closeline-kit'
import type { RateLimiter } from '~/ports/rate-limiter'

/** An in-memory rate limiter on the given clock; a test double (one process only). */
export function createMemoryRateLimiter(clock: Clock): RateLimiter {
  const hits = new Map<string, number>()
  return {
    async hit(keyHash, { windowSeconds, limit }) {
      const window = Math.floor(clock.now().getTime() / 1000 / windowSeconds)
      const key = `${Buffer.from(keyHash).toString('hex')}:${windowSeconds}:${window}`
      const next = (hits.get(key) ?? 0) + 1
      if (next <= limit) {
        hits.set(key, next)
      }
      return next <= limit
    },
  }
}
