import { afterAll, describe, expect, test } from 'bun:test'
import {
  formatId,
  type OrganizationId,
  type ProspectId,
  type ProviderKey,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createMemoryProvider } from '~/adapters/memory/providers'
import { integrationUrls } from '~/integration-support'
import * as Service from '~/modules/enrichment/service'
import * as Waterfall from '~/modules/enrichment/waterfall'
import { createTestDeps, newOrganizationId, newUserId } from '~/testing'
import { createPostgresEnrichmentStore } from './store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const store = createPostgresEnrichmentStore((organizationId, fn) =>
  withOrganization(database.db, organizationId, fn)
)

const NOW = new Date('2026-03-10T12:00:00Z')
const MONTH = '2026-03-01'
const alpha = 'alpha' as ProviderKey

function newRun(prospectId: ProspectId, requestId: string, userId = newUserId()) {
  return {
    id: formatId('erun', crypto.randomUUID()),
    runSetId: formatId('erset', crypto.randomUUID()),
    prospectId,
    requestId,
    groups: ['person'] as const,
    ceilingMicros: 1_000_000,
    requestedByUserId: userId,
    createdAt: NOW,
  }
}

const prospect = (): ProspectId => formatId('prs', crypto.randomUUID())

describe('the Postgres enrichment store', () => {
  test('a run is unique per Prospect and request id: a replay creates nothing', async () => {
    const org = newOrganizationId()
    const p = prospect()
    const first = await store.createRuns(org, [newRun(p, 'req-1')])
    const again = await store.createRuns(org, [newRun(p, 'req-1')])
    expect(first).toBe(1)
    expect(again).toBe(0)
    expect(await store.findByRequest(org, [p], 'req-1')).toHaveLength(1)
  })

  test('exactly one of many concurrent claims gets the run', async () => {
    const org = newOrganizationId()
    const run = newRun(prospect(), 'req-claim')
    await store.createRuns(org, [run])

    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claim(org, run.id, NOW, 120))
    )

    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'busy')).toHaveLength(7)
  })

  test('a run whose lease ran out can be claimed again', async () => {
    const org = newOrganizationId()
    const run = newRun(prospect(), 'req-lease')
    await store.createRuns(org, [run])
    await store.claim(org, run.id, NOW, 120)

    const early = await store.claim(org, run.id, new Date(NOW.getTime() + 60_000), 120)
    const late = await store.claim(org, run.id, new Date(NOW.getTime() + 121_000), 120)

    expect(early.kind).toBe('busy')
    expect(late.kind).toBe('claimed')
  })

  test('concurrent reservations never pass the monthly limit', async () => {
    const org = newOrganizationId()

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.reserveSpend(org, MONTH, alpha, 10_000, 35_000))
    )

    expect(results.filter(Boolean)).toHaveLength(3)
    expect(await store.monthSpend(org, MONTH)).toBe(30_000)
    await store.releaseSpend(org, MONTH, alpha, 10_000)
    expect(await store.monthSpend(org, MONTH)).toBe(20_000)
  })

  test('the runs and the spend of one Organization are invisible to another', async () => {
    const orgA = newOrganizationId()
    const orgB = newOrganizationId()
    const run = newRun(prospect(), 'req-iso')
    await store.createRuns(orgA, [run])
    await store.reserveSpend(orgA, MONTH, alpha, 5_000, 1_000_000)

    expect(await store.getRun(orgB, run.id)).toBeNull()
    expect(await store.getRunSet(orgB, run.runSetId)).toBeNull()
    expect((await store.listRuns(orgB, { limit: 10 })).items).toEqual([])
    expect(await store.monthSpend(orgB, MONTH)).toBe(0)
    expect((await store.claim(orgB, run.id, NOW, 120)).kind).toBe('missing')
    expect(await store.getRun(orgA, run.id)).not.toBeNull()
  })

  test('the run list pages newest first by cursor without gaps or repeats', async () => {
    const org = newOrganizationId()
    const runs = Array.from({ length: 5 }, (_, i) => ({
      ...newRun(prospect(), `req-page-${i}`),
      createdAt: new Date(NOW.getTime() + i * 1_000),
    }))
    await store.createRuns(org, runs)

    const seen: string[] = []
    let after: { createdAt: string; id: string } | undefined
    for (let i = 0; i < 5; i++) {
      const page = await store.listRuns(org, { limit: 2, after })
      seen.push(...page.items.map((r) => r.id))
      if (page.next === null) {
        break
      }
      after = page.next
    }

    expect(seen).toEqual([...runs].reverse().map((r) => r.id))
  })
})

describe('a run through the waterfall on Postgres', () => {
  test('fills, records attempts and cost, and a repeated execute calls no provider again', async () => {
    const org: OrganizationId = newOrganizationId()
    const userId = newUserId()
    const provider = createMemoryProvider({ key: alpha, groups: ['person'] })
    const deps = createTestDeps({ providers: [provider] })
    const enrichment = { ...deps.enrichment, store }
    const p = prospect()
    deps.core.seed(org, { id: p, ownerId: userId })
    deps.config.set(org, [
      {
        provider: alpha,
        enabled: true,
        apiKey: 'key',
        positions: { person: 1, company: null, emailVerification: null },
      },
    ])

    const runSet = await Service.create(
      enrichment,
      { bearer: 'unused', organizationId: org, userId, role: 'owner', requestId: 'trace' },
      { prospectIds: [p], groups: ['person'] },
      'integration-key-000001'
    )
    const [run] = await store.listRuns(org, { limit: 10 }).then((page) => page.items)
    if (run === undefined) {
      throw new Error('no run')
    }
    await Waterfall.execute(enrichment, org, run.id)
    await Waterfall.execute(enrichment, org, run.id)

    const done = await store.getRun(org, run.id)
    expect(done?.status).toBe('complete')
    expect(done?.attempts.map((a) => a.outcome)).toEqual(['filled'])
    expect(done?.costMicros).toBe(10_000)
    expect(provider.calls).toHaveLength(1)
    expect(deps.core.read(org, p)?.sources.firstName).toBe('enrichment:alpha')
    expect((await store.getRunSet(org, runSet.runSet.id))?.done).toBe(true)
  })
})
