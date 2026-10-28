import { describe, expect, test } from 'bun:test'
import { formatId, type ProspectId } from 'tula-closeline-contract'
import { createApolloProvider } from '~/adapters/providers/apollo'
import { createCircuit } from '~/adapters/providers/circuit'
import { createZeroBounceVerifier } from '~/adapters/providers/zerobounce'
import {
  createTestApp,
  newOrganizationId,
  newUserId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

const KEY_A = 'apollo-key-of-org-A-0123456789'
const KEY_B = 'apollo-key-of-org-B-9876543210'

type Api = { status: number; body: Record<string, unknown> }
type Found = { person: { first_name: string } }

/** Apollo and ZeroBounce over scripted vendors that never touch the network. */
async function world(vendor: (url: string, init: RequestInit) => Response = () => json({})) {
  const seen: { url: string; key: string | null }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({ url, key: new Headers(init.headers).get('x-api-key') })
    return vendor(url, init)
  }
  const guard = createCircuit({ failures: 2, openMs: 60_000, now: () => 0 })
  const provider = {
    ...createApolloProvider({ baseUrl: 'https://apollo.test', fetch, guard }),
    calls: [],
  }
  const verifier = {
    ...createZeroBounceVerifier({ baseUrl: 'https://zb.test', fetch }),
    calls: [],
  }
  const t = await createTestApp({
    providers: [provider],
    verifiers: [verifier],
    env: { ENRICHMENT_PROVIDER_MAX_TRIES: '1' },
  })
  const person = (organizationId = newOrganizationId(), role: TestIdentity['role'] = 'owner') =>
    ({ userId: newUserId(), organizationId, role }) satisfies TestIdentity
  return { t, seen, person }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

async function call(
  t: TestApp,
  method: string,
  path: string,
  as: TestIdentity,
  body?: unknown,
  withKey = true
): Promise<Api> {
  const response = await t.app.request(path, {
    method,
    headers: {
      ...(await t.bearer(as)),
      'content-type': 'application/json',
      ...(withKey && method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const codeOf = (r: Api) => (r.body.error as { code?: string } | undefined)?.code

/** Seeds a Prospect and enriches it; returns after the queue has drained. */
async function enrich(t: TestApp, as: TestIdentity, email = 'ada@x.test') {
  const id: ProspectId = formatId('prs', crypto.randomUUID())
  t.deps.core.seed(as.organizationId, { id, ownerId: as.userId, values: { email } })
  const created = await call(t, 'POST', '/v1/enrichment-runs', as, {
    prospectIds: [id],
    groups: ['person'],
  })
  if (created.status === 503) {
    return undefined // nothing is enabled, so there is nothing to run
  }
  expect([200, 202]).toContain(created.status)
  for (let i = 0; i < 10; i++) {
    let settled = false
    const polled = t.deps.consumer.pollOnce().finally(() => {
      settled = true
    })
    while (!settled) {
      await t.deps.time.advance(1_000)
    }
    if ((await polled) === 0) {
      break
    }
  }
  const runs = await call(t, 'GET', `/v1/enrichment-runs?runSetId=${created.body.id}`, as)
  return (runs.body.items as { attempts: { provider: string; outcome: string }[] }[])[0]
}

const turnOn = (t: TestApp, as: TestIdentity, provider: string, apiKey: string, enabled = true) =>
  call(t, 'PUT', `/v1/enrichment/providers/${provider}`, as, { enabled, apiKey })

describe('provider settings', () => {
  test('lists what the deployment offers; the key is write-only', async () => {
    const w = await world()
    const owner = w.person()
    const put = await turnOn(w.t, owner, 'apollo', KEY_A)
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ provider: 'apollo', enabled: true, credentialSet: true })
    const list = await call(w.t, 'GET', '/v1/enrichment/providers', owner)
    expect(
      (list.body.items as { provider: string; credentialSet: boolean }[]).map((i) => [
        i.provider,
        i.credentialSet,
      ])
    ).toEqual([
      ['apollo', true],
      ['zerobounce', false],
    ])
    expect(JSON.stringify([put.body, list.body])).not.toContain(KEY_A)
  })

  test('omitting apiKey keeps the key; null removes it', async () => {
    const w = await world()
    const owner = w.person()
    await turnOn(w.t, owner, 'apollo', KEY_A)
    const off = await call(w.t, 'PUT', '/v1/enrichment/providers/apollo', owner, { enabled: false })
    expect(off.body).toMatchObject({ enabled: false, credentialSet: true })
    const gone = await call(w.t, 'PUT', '/v1/enrichment/providers/apollo', owner, {
      enabled: true,
      apiKey: null,
    })
    expect(gone.body).toMatchObject({ credentialSet: false })
  })

  test('only owner and admin change it; a manager reads; a rep does neither; PUT needs an Idempotency-Key', async () => {
    const w = await world()
    const org = newOrganizationId()
    const body = { enabled: true }
    expect(
      (await call(w.t, 'PUT', '/v1/enrichment/providers/apollo', w.person(org, 'admin'), body))
        .status
    ).toBe(200)
    expect(
      (await call(w.t, 'PUT', '/v1/enrichment/providers/apollo', w.person(org, 'manager'), body))
        .status
    ).toBe(403)
    expect(
      (await call(w.t, 'GET', '/v1/enrichment/providers', w.person(org, 'manager'))).status
    ).toBe(200)
    expect((await call(w.t, 'GET', '/v1/enrichment/providers', w.person(org, 'rep'))).status).toBe(
      403
    )
    const missing = await call(
      w.t,
      'PUT',
      '/v1/enrichment/providers/apollo',
      w.person(org),
      body,
      false
    )
    expect(missing.status).toBeGreaterThanOrEqual(400)
  })

  test('an unknown provider is enrichment.provider_unknown', async () => {
    const w = await world()
    const r = await turnOn(w.t, w.person(), 'nobody', KEY_A)
    expect(codeOf(r)).toBe('enrichment.provider_unknown')
  })

  test('the key never reaches a response, a log line or an error report', async () => {
    const w = await world((url) => (url.includes('zb.test') ? json({}, 401) : json({}, 401)))
    const owner = w.person()
    await turnOn(w.t, owner, 'apollo', KEY_A)
    await turnOn(w.t, owner, 'zerobounce', KEY_A)
    const run = await enrich(w.t, owner)
    expect(run?.attempts.some((a) => a.outcome === 'failed')).toBe(true)
    const everything = JSON.stringify([
      w.t.deps.logLines,
      w.t.deps.reported.map((r) => [String(r.error), (r.error as Error).stack, r.context]),
      w.t.deps.errors,
      run,
    ])
    expect(everything).not.toContain(KEY_A)
  })
})

describe('waterfall order', () => {
  const order = (person: string[]) => ({
    order: { person, company: ['apollo'], email_verification: ['zerobounce'] },
  })

  test('starts at the default (version 0), then saves, conflicts when stale, replays', async () => {
    const w = await world()
    const owner = w.person()
    const first = await call(w.t, 'GET', '/v1/enrichment/waterfall', owner)
    expect(first.body).toMatchObject({ version: 0 })
    const saved = await call(w.t, 'PUT', '/v1/enrichment/waterfall', owner, {
      ...order(['apollo']),
      expectedVersion: 0,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.version).not.toBe(0)
    const replay = await call(w.t, 'PUT', '/v1/enrichment/waterfall', owner, {
      ...order(['apollo']),
      expectedVersion: 0,
    })
    expect(replay.status).toBe(200)
    expect(replay.body.version).toBe(saved.body.version)
    const stale = await call(w.t, 'PUT', '/v1/enrichment/waterfall', owner, {
      ...order([]),
      expectedVersion: 0,
    })
    expect(codeOf(stale)).toBe('enrichment.version_conflict')
    const next = await call(w.t, 'PUT', '/v1/enrichment/waterfall', owner, {
      ...order([]),
      expectedVersion: saved.body.version,
    })
    expect(next.status).toBe(200)
    expect((next.body.order as { person: string[] }).person).toEqual([])
  })

  test('a provider that is unknown or does not serve the group is enrichment.invalid_waterfall', async () => {
    const w = await world()
    const owner = w.person()
    const unknown = await call(w.t, 'PUT', '/v1/enrichment/waterfall', owner, {
      ...order(['nobody']),
      expectedVersion: 0,
    })
    expect(codeOf(unknown)).toBe('enrichment.invalid_waterfall')
    const wrongGroup = await call(w.t, 'PUT', '/v1/enrichment/waterfall', owner, {
      order: { person: ['zerobounce'], company: [], email_verification: [] },
      expectedVersion: 0,
    })
    expect(codeOf(wrongGroup)).toBe('enrichment.invalid_waterfall')
  })
})

describe('using the providers', () => {
  const found: Found = { person: { first_name: 'Ada' } }

  test('a disabled provider is never called', async () => {
    const w = await world(() => json(found))
    const owner = w.person()
    await turnOn(w.t, owner, 'apollo', KEY_A, false)
    await enrich(w.t, owner)
    expect(w.seen).toHaveLength(0)
  })

  test('an enabled provider is called with the Organization own key', async () => {
    const w = await world(() => json(found))
    const owner = w.person()
    await turnOn(w.t, owner, 'apollo', KEY_A)
    const run = await enrich(w.t, owner)
    expect(w.seen.map((s) => s.key)).toEqual([KEY_A])
    expect(run?.attempts.map((a) => a.outcome)).toEqual(['filled'])
  })

  test('after the circuit opens a failing provider is skipped, not called', async () => {
    const w = await world(() => json({}, 500))
    const owner = w.person()
    await turnOn(w.t, owner, 'apollo', KEY_A)
    for (let i = 0; i < 4; i++) {
      await enrich(w.t, owner, `p${i}@x.test`)
    }
    expect(w.seen).toHaveLength(2)
  })

  test('a second Organization neither sees nor uses the first one key or order', async () => {
    const w = await world(() => json(found))
    const a = w.person()
    const b = w.person()
    await turnOn(w.t, a, 'apollo', KEY_A)
    await call(w.t, 'PUT', '/v1/enrichment/waterfall', a, {
      order: { person: ['apollo'], company: [], email_verification: [] },
      expectedVersion: 0,
    })
    const listB = await call(w.t, 'GET', '/v1/enrichment/providers', b)
    expect(
      (listB.body.items as { credentialSet: boolean; enabled: boolean }[]).every(
        (i) => !i.credentialSet && !i.enabled
      )
    ).toBe(true)
    expect(await call(w.t, 'GET', '/v1/enrichment/waterfall', b)).toMatchObject({
      body: { version: 0 },
    })
    await turnOn(w.t, b, 'apollo', KEY_B)
    await enrich(w.t, a)
    await enrich(w.t, b)
    expect(w.seen.map((s) => s.key)).toEqual([KEY_A, KEY_B])
  })
})

describe('budget and spend', () => {
  const found: Found = { person: { first_name: 'Ada' } }

  test('the budget starts at the configured limit and falls as providers are paid', async () => {
    const w = await world(() => json(found))
    const owner = w.person()
    const before = await call(w.t, 'GET', '/v1/enrichment/budget', owner)
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ spentMicros: 0, version: 0, updatedAt: null })
    expect(before.body.remainingMicros).toBe(before.body.monthlyLimitMicros)
    await turnOn(w.t, owner, 'apollo', KEY_A)
    await enrich(w.t, owner)
    const after = (await call(w.t, 'GET', '/v1/enrichment/budget', owner)).body
    expect(after.spentMicros as number).toBeGreaterThan(0)
    expect(after.remainingMicros).toBe(
      (after.monthlyLimitMicros as number) - (after.spentMicros as number)
    )
  })

  test('spend lists by month and provider, pages with a cursor, and filters by month', async () => {
    const w = await world(() => json(found))
    const owner = w.person()
    await turnOn(w.t, owner, 'apollo', KEY_A)
    await enrich(w.t, owner)
    const all = await call(w.t, 'GET', '/v1/enrichment/spend?limit=1', owner)
    expect(all.status).toBe(200)
    const items = all.body.items as { month: string; provider: string; calls: number }[]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ provider: 'apollo', calls: 1 })
    expect(items[0]?.month).toMatch(/^\d{4}-\d{2}$/)
    expect(all.body.nextCursor).toBeNull()
    const other = await call(w.t, 'GET', '/v1/enrichment/spend?month=1999-01', owner)
    expect(other.body.items).toEqual([])
    expect(codeOf(await call(w.t, 'GET', '/v1/enrichment/spend?cursor=nope', owner))).toBe(
      'request.invalid'
    )
  })

  test('owner, admin and manager read; a rep does not; another Organization sees none of it', async () => {
    const w = await world(() => json(found))
    const a = w.person()
    await turnOn(w.t, a, 'apollo', KEY_A)
    await enrich(w.t, a)
    const org = a.organizationId
    for (const role of ['admin', 'manager'] as const) {
      const as = w.person(org, role)
      expect((await call(w.t, 'GET', '/v1/enrichment/budget', as)).status).toBe(200)
      expect((await call(w.t, 'GET', '/v1/enrichment/spend', as)).status).toBe(200)
    }
    const rep = w.person(org, 'rep')
    expect(codeOf(await call(w.t, 'GET', '/v1/enrichment/budget', rep))).toBe('auth.forbidden')
    expect(codeOf(await call(w.t, 'GET', '/v1/enrichment/spend', rep))).toBe('auth.forbidden')
    const b = w.person()
    expect((await call(w.t, 'GET', '/v1/enrichment/spend', b)).body.items).toEqual([])
    expect((await call(w.t, 'GET', '/v1/enrichment/budget', b)).body.spentMicros).toBe(0)
  })
})
