import { type Database, hitUnsubscribeRateLimit } from 'tula-closeline-db'
import type { RateLimiter } from '~/ports/rate-limiter'

/** A rate limiter over the database's counter function, so every instance shares the count. */
export function createPostgresRateLimiter(db: Database): RateLimiter {
  return { hit: (keyHash, options) => hitUnsubscribeRateLimit(db, { keyHash, ...options }) }
}
