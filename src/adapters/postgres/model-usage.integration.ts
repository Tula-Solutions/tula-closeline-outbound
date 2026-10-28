import { afterAll, describe, expect, test } from 'bun:test'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createMemoryModelUsageStore } from '~/adapters/memory/model-usage'
import { integrationUrls } from '~/integration-support'
import type { ModelUsageStore } from '~/ports/model-usage'
import { newOrganizationId } from '~/testing'
import { createPostgresModelUsageStore } from './model-usage'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())
const inOrg = (organizationId: string, fn: Parameters<typeof withOrganization>[2]) =>
  withOrganization(database.db, organizationId as never, fn)

const stores: [string, ModelUsageStore][] = [
  ['memory', createMemoryModelUsageStore()],
  ['postgres', createPostgresModelUsageStore(inOrg as never)],
]

describe.each(stores)('model usage store (%s)', (_name, store) => {
  test('adds per model, sums per month and Organization', async () => {
    const a = newOrganizationId()
    const b = newOrganizationId()
    const u = { inputTokens: 10, outputTokens: 5, costMicros: 100 }
    await store.record(a, '2026-10-01', 'm1', u)
    await store.record(a, '2026-10-01', 'm1', u)
    await store.record(a, '2026-10-01', 'm2', u)
    await store.record(a, '2026-11-01', 'm1', u)
    expect(await store.spentMicros(a, '2026-10-01')).toBe(300)
    expect(await store.spentMicros(a, '2026-11-01')).toBe(100)
    expect(await store.spentMicros(b, '2026-10-01')).toBe(0)
  })
})
