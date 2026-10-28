import type { Step } from 'tula-closeline-contract'

const HOUR_MS = 3_600_000

/**
 * The Step key a branch leads to now. The arms are tried in order; the first that holds wins, else
 * the default. Only `no_response` has a signal today (time since the last send, and a reply stops
 * the Enrollment before a branch is reached). shortcut: `out_of_office`, `task_completed` and
 * `task_skipped` never match until inbound classification and Rep tasks report them.
 */
export function branchTarget(
  step: Extract<Step, { kind: 'branch' }>,
  at: { now: Date; lastSentAt: string | null }
): string {
  for (const arm of step.arms) {
    if (
      arm.condition.kind === 'no_response' &&
      at.lastSentAt !== null &&
      at.now.getTime() - new Date(at.lastSentAt).getTime() >= arm.condition.afterHours * HOUR_MS
    ) {
      return arm.next
    }
  }
  return step.default
}
