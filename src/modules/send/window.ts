import type { SendWindow } from 'tula-closeline-contract'

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const MINUTE_MS = 60_000
const SEARCH_MINUTES = 8 * 24 * 60
const FALLBACK_MS = 24 * 60 * MINUTE_MS

const formats = new Map<string, Intl.DateTimeFormat>()

function localParts(timeZone: string, at: Date): { day: (typeof DAYS)[number]; minute: number } {
  let format = formats.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formats.set(timeZone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]))
  const day = DAYS.find((d) => d === String(parts.weekday).toLowerCase().slice(0, 3)) ?? 'sun'
  return { day, minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

/** Whether `at` falls inside the window, read in the window's time zone. */
export function isOpen(window: SendWindow, at: Date): boolean {
  const { day, minute } = localParts(window.timeZone, at)
  return window.days.includes(day) && minute >= window.startMinute && minute < window.endMinute
}

/**
 * When the window is next open at or after `at`, to the minute. A window that never opens
 * (no days, or an empty range) answers a day later, so a caller always has a retry time.
 */
export function nextOpen(window: SendWindow, at: Date): Date {
  const start = Math.ceil(at.getTime() / MINUTE_MS) * MINUTE_MS
  if (isOpen(window, at)) {
    return at
  }
  for (let i = 0; i <= SEARCH_MINUTES; i++) {
    const candidate = new Date(start + i * MINUTE_MS)
    if (isOpen(window, candidate)) {
      return candidate
    }
  }
  return new Date(at.getTime() + FALLBACK_MS)
}
