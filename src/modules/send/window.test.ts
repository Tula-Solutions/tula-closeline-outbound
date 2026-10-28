import { describe, expect, test } from 'bun:test'
import type { SendWindow } from 'tula-closeline-contract'
import { isOpen, nextOpen } from './window'

const weekdays: SendWindow = {
  timeZone: 'America/New_York',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  startMinute: 540,
  endMinute: 1020,
}

describe('send window', () => {
  test('is open inside the local hours and closed outside', () => {
    // Wed 2026-01-14 14:00Z is 09:00 in New York.
    expect(isOpen(weekdays, new Date('2026-01-14T14:00:00Z'))).toBe(true)
    expect(isOpen(weekdays, new Date('2026-01-14T13:59:00Z'))).toBe(false)
    expect(isOpen(weekdays, new Date('2026-01-14T22:00:00Z'))).toBe(false)
  })

  test('is closed on a day that is not listed', () => {
    expect(isOpen(weekdays, new Date('2026-01-17T16:00:00Z'))).toBe(false)
  })

  test('next open on a Friday evening is Monday morning local time', () => {
    const next = nextOpen(weekdays, new Date('2026-01-16T23:00:00Z'))
    expect(next.toISOString()).toBe('2026-01-19T14:00:00.000Z')
  })

  test('next open is now when open', () => {
    const now = new Date('2026-01-14T15:00:30Z')
    expect(nextOpen(weekdays, now)).toEqual(now)
  })

  test('a window that never opens still answers a retry time a day later', () => {
    const never: SendWindow = { ...weekdays, days: [] }
    const now = new Date('2026-01-14T15:00:00Z')
    expect(nextOpen(never, now).getTime() - now.getTime()).toBe(86_400_000)
  })

  test('follows daylight saving time', () => {
    // Mon 2026-03-09 is after the US spring-forward: 09:00 is 13:00Z.
    expect(isOpen(weekdays, new Date('2026-03-09T13:00:00Z'))).toBe(true)
    expect(isOpen(weekdays, new Date('2026-03-09T12:59:00Z'))).toBe(false)
  })
})
