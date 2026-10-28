import { expect, test } from 'bun:test'
import {
  type CampaignId,
  type Enrollment,
  type EnrollmentEvent,
  formatId,
  type OrganizationId,
  type ProspectId,
} from 'tula-closeline-contract'
import { createMemoryEnrollmentStore } from '../src/adapters/memory/enrollment-store'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// Hot path: the A/B results read (`variantCounts`). It reads at most four tally rows, so it is
// O(variants), whatever the size of the Campaign.
// Typical best batch: 0.5 ms for 500 reads; 50 ms leaves room for a slow runner.
const BUDGET_MS = 50
const SENDS = 2_000

test(`variant results: the best of ${BATCHES} batches of ${BATCH_REQUESTS} reads over ${SENDS} sends is within ${BUDGET_MS} ms`, async () => {
  const store = createMemoryEnrollmentStore()
  const org = formatId('org', crypto.randomUUID()) as OrganizationId
  const campaignId = formatId('cpg', crypto.randomUUID()) as CampaignId
  const at = '2026-03-10T12:00:00.000Z'
  // One Enrollment carries every send, so the setup is one insert (20 000 inserts timed out in CI).
  const id = formatId('enr', crypto.randomUUID()) as Enrollment['id']
  const enrollment: Enrollment = {
    id,
    campaignId,
    prospectId: formatId('prs', crypto.randomUUID()) as ProspectId,
    state: 'active',
    stopReason: null,
    currentStepKey: 'intro',
    currentStep: 0,
    attemptEpoch: 0,
    nextDueAt: null,
    enrolledAt: at,
    stoppedAt: null,
    completedAt: null,
  }
  const sends = Array.from(
    { length: SENDS },
    (_, i): EnrollmentEvent => ({
      id: formatId('eev', crypto.randomUUID()) as EnrollmentEvent['id'],
      enrollmentId: id,
      kind: 'sent',
      stepKey: 'intro',
      variantKey: i % 2 === 0 ? 'a' : 'b',
      sendId: null,
      stopReason: null,
      actorMembershipId: null,
      occurredAt: at,
    })
  )
  await store.insertIfAbsent(org, enrollment, sends)
  const result = await measure(() => store.variantCounts(org, campaignId, 1, 'intro'))
  console.log(summary('variant results', result))
  expect(await store.variantCounts(org, campaignId, 1, 'intro')).toHaveLength(2)
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
}, 30_000)
