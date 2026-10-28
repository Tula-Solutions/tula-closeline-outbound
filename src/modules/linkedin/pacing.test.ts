import { describe, expect, test } from 'bun:test'
import {
  dayOf,
  inWindow,
  nextDayStart,
  nextWeekStart,
  nextWindowStart,
  weekStartOf,
} from './pacing'

const window = { startHour: 9, endHour: 17 }
const none = () => 0

describe('pacing', () => {
  test('day and week start are UTC and the week starts on Monday', () => {
    expect(dayOf(new Date('2026-03-10T23:59:00Z'))).toBe('2026-03-10')
    expect(weekStartOf(new Date('2026-03-10T10:00:00Z'))).toBe('2026-03-09')
    expect(weekStartOf(new Date('2026-03-15T10:00:00Z'))).toBe('2026-03-09')
    expect(weekStartOf(new Date('2026-03-09T00:00:00Z'))).toBe('2026-03-09')
  })

  test('the window is start inclusive, end exclusive', () => {
    expect(inWindow(new Date('2026-03-10T09:00:00Z'), window)).toBe(true)
    expect(inWindow(new Date('2026-03-10T16:59:00Z'), window)).toBe(true)
    expect(inWindow(new Date('2026-03-10T17:00:00Z'), window)).toBe(false)
    expect(inWindow(new Date('2026-03-10T08:59:00Z'), window)).toBe(false)
  })

  test('outside the window waits for the next opening, plus jitter', () => {
    expect(nextWindowStart(new Date('2026-03-10T06:00:00Z'), window, 0, none).toISOString()).toBe(
      '2026-03-10T09:00:00.000Z'
    )
    expect(nextWindowStart(new Date('2026-03-10T20:00:00Z'), window, 0, none).toISOString()).toBe(
      '2026-03-11T09:00:00.000Z'
    )
    expect(
      nextWindowStart(new Date('2026-03-10T20:00:00Z'), window, 600_000, () => 0.5).toISOString()
    ).toBe('2026-03-11T09:05:00.000Z')
  })

  test('a reached limit waits for tomorrow or next Monday', () => {
    const at = new Date('2026-03-10T10:00:00Z')
    expect(nextDayStart(at, window, 0, none).toISOString()).toBe('2026-03-11T09:00:00.000Z')
    expect(nextWeekStart(at, window, 0, none).toISOString()).toBe('2026-03-16T09:00:00.000Z')
  })
})
