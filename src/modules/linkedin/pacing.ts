/** The hours of the UTC day in which LinkedIn sends may go out: `startHour` inclusive, `endHour` exclusive. */
export type SendWindow = { startHour: number; endHour: number }

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** The UTC calendar day (`YYYY-MM-DD`) of an instant. */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/** The Monday (`YYYY-MM-DD`, UTC) that starts the week of an instant. */
export function weekStartOf(at: Date): string {
  const sinceMonday = (at.getUTCDay() + 6) % 7
  return dayOf(new Date(at.getTime() - sinceMonday * DAY_MS))
}

/** Whether an instant falls inside the sending window. */
export function inWindow(at: Date, window: SendWindow): boolean {
  const hour = at.getUTCHours()
  return hour >= window.startHour && hour < window.endHour
}

/**
 * The next time sending may start: `at` itself inside the window, else the window's opening on the
 * next fitting day, pushed later by up to `jitterMs` times `random` so accounts do not all wake at once.
 */
export function nextWindowStart(
  at: Date,
  window: SendWindow,
  jitterMs: number,
  random: () => number
): Date {
  const midnight = Date.parse(`${dayOf(at)}T00:00:00.000Z`)
  const today = midnight + window.startHour * HOUR_MS
  const opening = at.getTime() < today ? today : today + DAY_MS
  return new Date(opening + Math.floor(random() * jitterMs))
}

/** The opening of the window on the first day after the current UTC day (daily limit reached). */
export function nextDayStart(at: Date, window: SendWindow, jitterMs: number, random: () => number) {
  const midnight = Date.parse(`${dayOf(at)}T00:00:00.000Z`) + DAY_MS
  return new Date(midnight + window.startHour * HOUR_MS + Math.floor(random() * jitterMs))
}

/** The opening of the window on the Monday after the current week (weekly limit reached). */
export function nextWeekStart(
  at: Date,
  window: SendWindow,
  jitterMs: number,
  random: () => number
) {
  const monday = Date.parse(`${weekStartOf(at)}T00:00:00.000Z`) + 7 * DAY_MS
  return new Date(monday + window.startHour * HOUR_MS + Math.floor(random() * jitterMs))
}
