import { expect, test } from 'bun:test'
import { formatId, type ProviderKey } from 'tula-closeline-contract'
import { createMemoryProvider } from '../src/adapters/memory/providers'
import { createTestApp, newOrganizationId, newUserId } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// Hot path: POST /v1/enrichment-runs. Its cost is O(k) in the Prospects named (k at most 500),
// never in the Organization's size: one visibility check, one idempotency lookup, one insert and
// the publish in batches of ten. This benchmark names 10 Prospects (one publish batch).
// Typical best batch: 460 ms for 500 requests (about 0.9 ms each, 10 Prospects each) over the
// memory store and queue, whose scans make later batches slower; the gate uses the fastest.
// Budget: 5x, rounded up. A request that did work proportional to the Organization would fail.
const BUDGET_MS = 2_500

test(`enrichment create: the best of ${BATCHES} batches of ${BATCH_REQUESTS} requests is within ${BUDGET_MS} ms`, async () => {
  const t = await createTestApp({
    providers: [createMemoryProvider({ key: 'alpha' as ProviderKey, groups: ['person'] })],
  })
  const organizationId = newOrganizationId()
  const userId = newUserId()
  const prospectIds = Array.from({ length: 10 }, () => formatId('prs', crypto.randomUUID()))
  for (const id of prospectIds) {
    t.deps.core.seed(organizationId, { id, ownerId: userId })
  }
  t.deps.config.set(organizationId, [
    {
      provider: 'alpha' as ProviderKey,
      enabled: true,
      apiKey: 'key',
      positions: { person: 1, company: null, emailVerification: null },
    },
  ])
  const headers = {
    ...(await t.bearer({ userId, organizationId, role: 'owner' })),
    'content-type': 'application/json',
  }
  const body = JSON.stringify({ prospectIds, groups: ['person'] })
  let n = 0

  const result = await measure(async () => {
    const response = await t.app.request('/v1/enrichment-runs', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': `bench-key-${(n++).toString().padStart(10, '0')}` },
      body,
    })
    if (response.status !== 202) {
      throw new Error(`unexpected status ${response.status}`)
    }
  })

  console.log(summary('enrichment create', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
}, 120_000)
