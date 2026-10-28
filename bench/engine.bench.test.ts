import { expect, test } from 'bun:test'
import type { Step } from 'tula-closeline-contract'
import { branchTarget } from '../src/modules/engine/branch'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// Hot path: the engine's per-Step decision, `branchTarget`. It is O(arms) with a Sequence capped
// at a few dozen Steps, and does no I/O; the sweep tick itself is O(due rows in a page) because
// `claimDue` reads `enrollments_due_idx` in due order with a limit. This benchmark takes a branch
// of 30 arms where only the last matches (the worst case).
// Typical best batch: 0.2 ms for 500 calls (the work is tiny); 50 ms leaves room for a slow runner.
const BUDGET_MS = 50

test(`engine branch: the best of ${BATCHES} batches of ${BATCH_REQUESTS} calls is within ${BUDGET_MS} ms`, async () => {
  const arms = Array.from({ length: 30 }, (_, i) => ({
    condition: { kind: 'no_response' as const, afterHours: 24 * (30 - i) },
    next: `step-${i}`,
  }))
  const step: Extract<Step, { kind: 'branch' }> = {
    kind: 'branch',
    key: 'b',
    arms,
    default: 'fallback',
  }
  const now = new Date('2026-11-02T10:00:00Z')
  const lastSentAt = new Date(now.getTime() - 25 * 3_600_000).toISOString()
  const result = await measure(() => branchTarget(step, { now, lastSentAt }))
  console.log(summary('engine branch', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
