import { expect, test } from 'bun:test'
import { newLinkedinRecord } from '../src/ports/linkedin-store.behaviour'
import { createTestApp, newOrganizationId } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// Hot path: LinkedinStore.reserve, called once per LinkedIn send. Its cost is O(1) in the
// Organization's size: one keyed lookup of the send key and one keyed counter per day and week
// (Postgres: one advisory lock, a primary-key lookup and two upserts, in one transaction).
// This benchmark reserves distinct keys on distinct days so each call writes.
// Typical best batch: 18 ms for 500 reservations (0.04 ms each) over the memory store; the gate
// uses the fastest batch. Budget: 5x, rounded up.
const BUDGET_MS = 100

test(`linkedin quota reserve: the best of ${BATCHES} batches of ${BATCH_REQUESTS} is within ${BUDGET_MS} ms`, async () => {
  const t = await createTestApp()
  const org = newOrganizationId()
  const account = await t.deps.linkedinStore.connect(org, newLinkedinRecord())
  let n = 0
  const start = Date.parse('2030-01-01T00:00:00Z')
  const result = await measure((i) => {
    const at = new Date(start + i * 86_400_000)
    const day = at.toISOString().slice(0, 10)
    return t.deps.linkedinStore.reserve(org, {
      accountId: account.id,
      sendKey: `bench-${n++}`,
      kind: 'connection',
      day,
      weekStart: day,
      at: at.toISOString(),
    })
  })
  console.log(summary('linkedin quota reserve', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
}, 120_000)
