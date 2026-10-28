const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** The UTC day and clock hour `now` falls in; limits count from these starts. */
export function bucketsOf(now: Date) {
  const hourStart = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS
  const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  return {
    dayStart: new Date(dayStart),
    hourStart: new Date(hourStart),
    nextHour: new Date(hourStart + HOUR_MS),
    nextDay: new Date(dayStart + DAY_MS),
  }
}
