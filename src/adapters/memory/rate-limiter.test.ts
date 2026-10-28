import { describe, expect, test } from 'bun:test'
import { createVirtualTime } from 'tula-closeline-kit/testing'
import { describeRateLimiter } from '~/ports/rate-limiter.behaviour'
import { createMemoryRateLimiter } from './rate-limiter'

describeRateLimiter('memory', () => createMemoryRateLimiter(createVirtualTime().clock))

describe('memory rate limiter windows', () => {
  test('a new window starts a new count', async () => {
    const time = createVirtualTime()
    const limiter = createMemoryRateLimiter(time.clock)
    const key = new Uint8Array(32)
    expect(await limiter.hit(key, { windowSeconds: 60, limit: 1 })).toBe(true)
    expect(await limiter.hit(key, { windowSeconds: 60, limit: 1 })).toBe(false)
    time.clock.advance('2m')
    expect(await limiter.hit(key, { windowSeconds: 60, limit: 1 })).toBe(true)
  })
})
