import { expect, test } from 'bun:test'
import { type CampaignId, formatId, type ProspectId, type Variant } from 'tula-closeline-contract'
import { assignVariant } from '../src/modules/variant/assign'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// Hot path: `assignVariant`, run once per email send. It is O(variants) (at most four) and does
// no I/O: one SHA-256 of the three ids and a walk over the cumulative weights.
// Typical best batch: 0.2 ms for 500 calls; 50 ms leaves room for a slow runner.
const BUDGET_MS = 50

test(`variant assignment: the best of ${BATCHES} batches of ${BATCH_REQUESTS} calls is within ${BUDGET_MS} ms`, async () => {
  const variants: Variant[] = [25, 25, 25, 25].map((weight, i) => ({
    key: `v${i}`,
    label: `V${i}`,
    angle: 'Lead with a story',
    weight,
  }))
  const campaignId = formatId('cpg', crypto.randomUUID()) as CampaignId
  const prospectId = formatId('prs', crypto.randomUUID()) as ProspectId
  const result = await measure(() =>
    assignVariant({ prospectId, campaignId, stepKey: 'intro' }, variants, null)
  )
  console.log(summary('variant assignment', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
