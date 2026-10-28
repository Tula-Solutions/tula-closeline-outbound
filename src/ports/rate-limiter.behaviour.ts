import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import type { RateLimiter } from './rate-limiter'

const newKey = () => new Uint8Array(randomBytes(32))
// A day-long window cannot roll over mid-test.
const DAY = 86_400

/** The behaviour every rate limiter must have. */
export function describeRateLimiter(name: string, make: () => RateLimiter) {
  describe(`rate limiter: ${name}`, () => {
    test('allows up to the limit, then refuses', async () => {
      const limiter = make()
      const key = newKey()
      const answers: boolean[] = []
      for (let i = 0; i < 4; i++) {
        answers.push(await limiter.hit(key, { windowSeconds: DAY, limit: 3 }))
      }
      expect(answers).toEqual([true, true, true, false])
    })

    test('counts keys apart', async () => {
      const limiter = make()
      const key = newKey()
      expect(await limiter.hit(key, { windowSeconds: DAY, limit: 1 })).toBe(true)
      expect(await limiter.hit(key, { windowSeconds: DAY, limit: 1 })).toBe(false)
      expect(await limiter.hit(newKey(), { windowSeconds: DAY, limit: 1 })).toBe(true)
    })
  })
}
