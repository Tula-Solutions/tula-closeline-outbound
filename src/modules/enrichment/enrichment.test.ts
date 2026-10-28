import { describe, expect, test } from 'bun:test'
import {
  type EnrichmentRun,
  type EnrichmentRunSet,
  formatId,
  type OrganizationId,
  type ProspectId,
  type ProviderKey,
} from 'tula-closeline-contract'
import { createMemoryProvider, createMemoryVerifier } from '~/adapters/memory/providers'
import * as Waterfall from '~/modules/enrichment/waterfall'
import { CoreProspectNotFoundError } from '~/ports/core'
import { ProviderError } from '~/ports/enrichment-provider'
import type { ProviderSetting } from '~/ports/provider-config'
import { LeaseLostError } from '~/ports/store'
import {
  createTestApp,
  newOrganizationId,
  newUserId,
  type TestApp,
  type TestDepsOverrides,
  type TestIdentity,
} from '~/testing'

const key = (name: string) => name as ProviderKey

function setting(provider: string, position: number, enabled = true): ProviderSetting {
  return {
    provider: key(provider),
    enabled,
    apiKey: enabled ? 'secret-key' : null,
    positions: { person: position, company: position, emailVerification: position },
  }
}

/** The `area.reason` code of an error body. */
function codeOf(body: Record<string, unknown>): unknown {
  return (body.error as { code?: unknown } | undefined)?.code
}

const newProspectId = (): ProspectId => formatId('prs', crypto.randomUUID())

type World = {
  t: TestApp
  organizationId: OrganizationId
  owner: TestIdentity
  prospectId: ProspectId
  post: (
    body: unknown,
    idempotencyKey?: string,
    as?: TestIdentity
  ) => Promise<{ status: number; body: Record<string, unknown>; headers: Headers }>
  get: (
    path: string,
    as?: TestIdentity
  ) => Promise<{ status: number; body: Record<string, unknown> }>
  drain: () => Promise<void>
  run: (runId: string, as?: TestIdentity) => Promise<EnrichmentRun>
  runsOf: (runSetId: string) => Promise<EnrichmentRun[]>
}

async function world(
  options: TestDepsOverrides & {
    settings?: ProviderSetting[]
    ceiling?: string
    budget?: string
  } = {}
): Promise<World> {
  const { settings, ceiling, budget, ...overrides } = options
  const env = {
    ...(ceiling ? { ENRICHMENT_RUN_CEILING_MICROS: ceiling } : {}),
    ...(budget ? { ENRICHMENT_MONTHLY_BUDGET_MICROS: budget } : {}),
    ...overrides.env,
  }
  const t = await createTestApp({ ...overrides, env })
  const organizationId = newOrganizationId()
  const owner: TestIdentity = { userId: newUserId(), organizationId, role: 'owner' }
  const prospectId = newProspectId()
  t.deps.core.seed(organizationId, { id: prospectId, ownerId: owner.userId, values: {} })
  t.deps.config.set(organizationId, settings ?? [])

  const call = async (
    method: string,
    path: string,
    as: TestIdentity,
    body?: unknown,
    idempotencyKey?: string
  ) => {
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(as)),
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      headers: response.headers,
    }
  }
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      // Retry waits use virtual time, so move it while the batch is handled.
      let settled = false
      const polled = t.deps.consumer.pollOnce().finally(() => {
        settled = true
      })
      while (!settled) {
        await t.deps.time.advance(1_000)
      }
      if ((await polled) === 0) {
        return
      }
    }
  }
  const get = (path: string, as: TestIdentity = owner) => call('GET', path, as)
  return {
    t,
    organizationId,
    owner,
    prospectId,
    post: (body, idempotencyKey = crypto.randomUUID(), as = owner) =>
      call('POST', '/v1/enrichment-runs', as, body, idempotencyKey),
    get,
    drain,
    run: async (runId, as = owner) =>
      (await get(`/v1/enrichment-runs/${runId}`, as)).body as unknown as EnrichmentRun,
    runsOf: async (runSetId) =>
      ((await get(`/v1/enrichment-runs?runSetId=${runSetId}`)).body.items ?? []) as EnrichmentRun[],
  }
}

/** Runs one Prospect through and returns its finished run. */
async function enrichOne(w: World, body: unknown = { prospectIds: [w.prospectId] }) {
  const created = await w.post(body)
  expect([200, 202]).toContain(created.status)
  await w.drain()
  const [run] = await w.runsOf((created.body as unknown as EnrichmentRunSet).id)
  if (run === undefined) {
    throw new Error('no run was made')
  }
  return { created, run: await w.run(run.id) }
}

describe('the waterfall', () => {
  test('the first provider that fills a group stops it, and core receives its source', async () => {
    const first = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const second = createMemoryProvider({ key: key('beta'), groups: ['person'] })
    const w = await world({
      providers: [first, second],
      settings: [setting('alpha', 1), setting('beta', 2)],
    })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    expect(run.status).toBe('complete')
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
    const stored = w.t.deps.core.read(w.organizationId, w.prospectId)
    expect(stored?.sources.firstName).toBe('enrichment:alpha')
    expect(run.costMicros).toBe(10_000)
    expect(run.attempts.map((a) => a.outcome)).toEqual(['filled'])
  })

  test('a failing provider falls through to the next', async () => {
    const broken = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      respond: async () => {
        throw new ProviderError('provider_error')
      },
    })
    const good = createMemoryProvider({ key: key('beta'), groups: ['person'] })
    const w = await world({
      providers: [broken, good],
      settings: [setting('alpha', 1), setting('beta', 2)],
    })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    expect(run.status).toBe('complete')
    expect(run.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['alpha', 'failed'],
      ['beta', 'filled'],
    ])
    // The failed provider was billed nothing; the retry was bounded by the configured tries.
    expect(broken.calls.length).toBe(w.t.deps.enrichment.limits.providerMaxTries)
    expect(run.costMicros).toBe(10_000)
  })

  test('when no provider fills a group the run ends incomplete', async () => {
    const empty = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      respond: async () => [],
    })
    const w = await world({ providers: [empty], settings: [setting('alpha', 1)] })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    expect(run.status).toBe('incomplete')
    expect(run.stopReason).toBeNull()
    expect(run.attempts.map((a) => a.outcome)).toEqual(['no_result'])
    expect(w.t.deps.core.writeCalls()).toBe(0)
  })

  test('a disabled provider is skipped and the next one used', async () => {
    const off = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const on = createMemoryProvider({ key: key('beta'), groups: ['person'] })
    const w = await world({
      providers: [off, on],
      settings: [setting('alpha', 1, false), setting('beta', 2)],
    })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    expect(off.calls).toHaveLength(0)
    expect(run.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['alpha', 'skipped_disabled'],
      ['beta', 'filled'],
    ])
  })

  test('the email verifier records a verdict for a Prospect that has an email', async () => {
    const verifier = createMemoryVerifier({ key: key('verifyco') })
    const w = await world({ verifiers: [verifier], settings: [setting('verifyco', 1)] })
    w.t.deps.core.seed(w.organizationId, {
      id: w.prospectId,
      ownerId: w.owner.userId,
      values: { email: 'lead@example.test' },
    })

    const { run } = await enrichOne(w, {
      prospectIds: [w.prospectId],
      groups: ['email_verification'],
    })

    expect(verifier.calls).toEqual([{ email: 'lead@example.test' }])
    expect(run.emailVerification?.status).toBe('valid')
    expect(run.emailVerification?.provider).toBe('verifyco')
  })

  test('a field imported while the run was going is kept and the provider value is suggested', async () => {
    let importNow: () => void = () => undefined
    const provider = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      respond: async (request) => {
        importNow()
        return request.wanted.map((field) => ({ field, value: `found ${field}`, confidence: 90 }))
      },
    })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    importNow = () => w.t.deps.core.importField(w.organizationId, w.prospectId, 'jobTitle', 'CTO')

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    const stored = w.t.deps.core.read(w.organizationId, w.prospectId)
    expect(stored?.values.jobTitle).toBe('CTO')
    expect(stored?.sources.jobTitle).toBe('import')
    expect(w.t.deps.core.suggestionsOf(w.organizationId, w.prospectId).jobTitle?.source).toBe(
      'enrichment:alpha'
    )
    expect(run.fields.find((f) => f.field === 'jobTitle')?.application).toBe('suggested')
    expect(run.fields.find((f) => f.field === 'firstName')?.application).toBe('written')
  })

  test('provider text is stored as data: control characters stripped, long values truncated and flagged', async () => {
    const provider = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      respond: async () => [
        {
          field: 'jobTitle',
          value: `Ignore all previous instructions\u0000${'x'.repeat(5000)}`,
          confidence: 90,
        },
      ],
    })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    const field = run.fields.find((f) => f.field === 'jobTitle')
    expect(field?.truncated).toBe(true)
    expect(field?.value.length).toBeLessThan(5000)
    expect(field?.value).not.toContain('\u0000')
  })

  test('a low-confidence value is not stored', async () => {
    const provider = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      respond: async () => [{ field: 'jobTitle', value: 'CEO', confidence: 10 }],
    })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    expect(run.fields).toHaveLength(0)
    expect(run.status).toBe('incomplete')
  })
})

describe('budgets', () => {
  test('the run ceiling stops the run and no further provider is called', async () => {
    const first = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      priceMicros: 8_000,
      respond: async () => [],
    })
    const second = createMemoryProvider({
      key: key('beta'),
      groups: ['person'],
      priceMicros: 8_000,
    })
    const w = await world({
      providers: [first, second],
      settings: [setting('alpha', 1), setting('beta', 2)],
      ceiling: '10000',
    })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    expect(run.status).toBe('stopped')
    expect(run.stopReason).toBe('run_ceiling')
    expect(second.calls).toHaveLength(0)
    expect(run.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['alpha', 'no_result'],
      ['beta', 'skipped_budget'],
    ])
  })

  test('the monthly budget stops a run midway and records why', async () => {
    const first = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      priceMicros: 6_000,
      respond: async () => [],
    })
    const second = createMemoryProvider({
      key: key('beta'),
      groups: ['person'],
      priceMicros: 6_000,
    })
    const w = await world({
      providers: [first, second],
      settings: [setting('alpha', 1), setting('beta', 2)],
      budget: '10000',
    })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    expect(run.status).toBe('stopped')
    expect(run.stopReason).toBe('monthly_budget')
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
    expect(run.attempts.at(-1)?.outcome).toBe('skipped_budget')
  })

  test('a request is refused with 429 once the month is spent', async () => {
    const provider = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      priceMicros: 10_000,
    })
    const w = await world({
      providers: [provider],
      settings: [setting('alpha', 1)],
      budget: '10000',
    })
    await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    const refused = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })

    expect(refused.status).toBe(429)
    expect(codeOf(refused.body)).toBe('enrichment.budget_exceeded')
    expect(provider.calls).toHaveLength(1)
  })
})

describe('idempotency', () => {
  test('the same request id twice charges once', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const body = { prospectIds: [w.prospectId], groups: ['person'] }

    const first = await w.post(body, 'request-key-000001')
    await w.drain()
    const second = await w.post(body, 'request-key-000001')
    await w.drain()

    expect(first.status).toBe(202)
    expect(second.status).toBe(200)
    expect((second.body as { id: string }).id).toBe((first.body as { id: string }).id)
    expect(provider.calls).toHaveLength(1)
    const month = `${w.t.deps.clock.now().toISOString().slice(0, 7)}-01`
    const spent = [...w.t.deps.store.spendOf(w.organizationId, month).values()]
    expect(spent.reduce((sum, s) => sum + s.costMicros, 0)).toBe(10_000)
  })

  test('the same key with different groups is a conflict', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    await w.post({ prospectIds: [w.prospectId], groups: ['person'] }, 'request-key-000001')

    const reused = await w.post(
      { prospectIds: [w.prospectId], groups: ['company'] },
      'request-key-000001'
    )

    expect(reused.status).toBe(422)
    expect(codeOf(reused.body)).toBe('request.idempotency_key_reused')
  })

  test('a queue message delivered twice makes no second provider call', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const [run] = await w.runsOf((created.body as { id: string }).id)
    if (run === undefined) {
      throw new Error('no run')
    }
    await w.drain()

    // A duplicate delivery of the same run, as at-least-once delivery may produce.
    const { registry } = await import('~/messages')
    await w.t.deps.queue.publish(
      registry.create({
        type: 'enrichment.run',
        payload: { runId: run.id, prospectId: w.prospectId },
        traceId: 'trace-dup',
        organizationId: w.organizationId,
      })
    )
    await w.drain()

    expect(provider.calls).toHaveLength(1)
    expect(w.t.deps.core.writeCalls()).toBe(1)
    expect(w.t.deps.queue.deadLetters()).toHaveLength(0)
  })
})

describe('the routes', () => {
  test('a missing Idempotency-Key is rejected', async () => {
    const w = await world()
    const response = await w.t.app.request('/v1/enrichment-runs', {
      method: 'POST',
      headers: { ...(await w.t.bearer(w.owner)), 'content-type': 'application/json' },
      body: JSON.stringify({ prospectIds: [w.prospectId] }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
  })

  test('an invalid body is rejected', async () => {
    const w = await world()
    const response = await w.post({ prospectIds: [] })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
  })

  test('a request without a token is 401', async () => {
    const w = await world()
    const response = await w.t.app.request('/v1/enrichment-runs')
    expect(response.status).toBe(401)
  })

  test('a token from an unknown key is 401', async () => {
    const w = await world()
    const response = await w.t.app.request('/v1/enrichment-runs', {
      headers: await w.t.bearerFromUnknownKey(w.owner),
    })
    expect(response.status).toBe(401)
  })

  test('an unknown Prospect fails the whole call with 404', async () => {
    const w = await world({
      providers: [createMemoryProvider({ key: key('alpha') })],
      settings: [setting('alpha', 1)],
    })
    const response = await w.post({ prospectIds: [w.prospectId, newProspectId()] })
    expect(response.status).toBe(404)
    expect(codeOf(response.body)).toBe('enrichment.prospect_not_found')
  })

  test('a group with no usable provider is 503 with Retry-After', async () => {
    const w = await world()
    const response = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    expect(response.status).toBe(503)
    expect(codeOf(response.body)).toBe('enrichment.provider_unavailable')
    expect(response.headers.get('retry-after')).toBe('5')
  })

  test('email verification for a Prospect without an email is refused', async () => {
    const w = await world({
      verifiers: [createMemoryVerifier({ key: key('verifyco') })],
      settings: [setting('verifyco', 1)],
    })
    const response = await w.post({ prospectIds: [w.prospectId], groups: ['email_verification'] })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(codeOf(response.body)).toBe('enrichment.verification_failed')
  })

  test('a bulk request makes a run set whose progress can be read', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const ids = [w.prospectId]
    for (let i = 0; i < 24; i++) {
      const id = newProspectId()
      w.t.deps.core.seed(w.organizationId, { id, ownerId: w.owner.userId })
      ids.push(id)
    }

    const created = await w.post({ prospectIds: ids, groups: ['person'] })
    const runSet = created.body as unknown as EnrichmentRunSet
    expect(created.status).toBe(202)
    expect(runSet.total).toBe(25)
    expect(runSet.counts.queued).toBe(25)
    await w.drain()

    const done = (await w.get(`/v1/enrichment-run-sets/${runSet.id}`))
      .body as unknown as EnrichmentRunSet
    expect(done.done).toBe(true)
    expect(done.counts.complete).toBe(25)
    expect(done.costMicros).toBe(250_000)
  })

  test('the run list pages by cursor and caps the page size', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const ids = [w.prospectId]
    for (let i = 0; i < 4; i++) {
      const id = newProspectId()
      w.t.deps.core.seed(w.organizationId, { id, ownerId: w.owner.userId })
      ids.push(id)
    }
    await w.post({ prospectIds: ids, groups: ['person'] })

    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const query = `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const { body } = await w.get(`/v1/enrichment-runs?${query}`)
      const items = body.items as { id: string }[]
      expect(items.length).toBeLessThanOrEqual(2)
      for (const item of items) {
        seen.add(item.id)
      }
      cursor = (body.nextCursor ?? undefined) as string | undefined
      if (cursor === undefined) {
        break
      }
    }
    expect(seen.size).toBe(5)

    const tooBig = await w.get('/v1/enrichment-runs?limit=101')
    expect(tooBig.status).toBeGreaterThanOrEqual(400)
    expect(tooBig.status).toBeLessThan(500)
  })

  test('a Rep sees only runs on their own Prospects and a Manager also their Team', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const rep: TestIdentity = { userId: newUserId(), organizationId: w.organizationId, role: 'rep' }
    const otherRep: TestIdentity = {
      userId: newUserId(),
      organizationId: w.organizationId,
      role: 'rep',
    }
    const manager: TestIdentity = {
      userId: newUserId(),
      organizationId: w.organizationId,
      role: 'manager',
    }
    w.t.deps.core.setTeam(w.organizationId, manager.userId, [rep.userId])
    const mine = newProspectId()
    w.t.deps.core.seed(w.organizationId, { id: mine, ownerId: rep.userId })
    const created = await w.post({ prospectIds: [mine], groups: ['person'] }, undefined, rep)
    expect(created.status).toBe(202)
    const [run] = await w.runsOf((created.body as { id: string }).id)

    expect((await w.get(`/v1/enrichment-runs/${run?.id}`, rep)).status).toBe(200)
    expect((await w.get(`/v1/enrichment-runs/${run?.id}`, manager)).status).toBe(200)
    const hidden = await w.get(`/v1/enrichment-runs/${run?.id}`, otherRep)
    expect(hidden.status).toBe(404)
    expect(codeOf(hidden.body)).toBe('enrichment.run_not_found')
    const refused = await w.post({ prospectIds: [mine], groups: ['person'] }, undefined, otherRep)
    expect(refused.status).toBe(404)
    expect(codeOf(refused.body)).toBe('enrichment.prospect_not_found')
  })
})

describe('Organization isolation', () => {
  test('a second Organization cannot read the first one runs, run sets or spend', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    await w.drain()
    const runSetId = (created.body as { id: string }).id
    const [run] = await w.runsOf(runSetId)

    const otherOrg = newOrganizationId()
    const stranger: TestIdentity = { userId: newUserId(), organizationId: otherOrg, role: 'owner' }
    w.t.deps.config.set(otherOrg, [setting('alpha', 1)])

    expect((await w.get(`/v1/enrichment-runs/${run?.id}`, stranger)).status).toBe(404)
    expect((await w.get(`/v1/enrichment-run-sets/${runSetId}`, stranger)).status).toBe(404)
    const list = await w.get('/v1/enrichment-runs', stranger)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    const month = `${w.t.deps.clock.now().toISOString().slice(0, 7)}-01`
    expect(w.t.deps.store.spendOf(otherOrg, month).size).toBe(0)
    const foreign = await w.post(
      { prospectIds: [w.prospectId], groups: ['person'] },
      undefined,
      stranger
    )
    expect(foreign.status).toBe(404)
    expect(codeOf(foreign.body)).toBe('enrichment.prospect_not_found')
  })

  test('the spend of one Organization does not use up the budget of another', async () => {
    const provider = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      priceMicros: 10_000,
    })
    const w = await world({
      providers: [provider],
      settings: [setting('alpha', 1)],
      budget: '10000',
    })
    await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    const otherOrg = newOrganizationId()
    const other: TestIdentity = { userId: newUserId(), organizationId: otherOrg, role: 'owner' }
    const prospect = newProspectId()
    w.t.deps.core.seed(otherOrg, { id: prospect, ownerId: other.userId })
    w.t.deps.config.set(otherOrg, [setting('alpha', 1)])

    const created = await w.post({ prospectIds: [prospect], groups: ['person'] }, undefined, other)
    expect(created.status).toBe(202)
  })
})

describe('malformed provider answers', () => {
  test('a null item in a provider answer is an invalid_response attempt that falls through', async () => {
    const bad = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      respond: async () => [null] as never,
    })
    const good = createMemoryProvider({ key: key('beta'), groups: ['person'] })
    const w = await world({
      providers: [bad, good],
      settings: [setting('alpha', 1), setting('beta', 2)],
    })

    const { run } = await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    expect(run.status).toBe('complete')
    expect(run.attempts.map((a) => [a.provider, a.outcome, a.failure])).toEqual([
      ['alpha', 'failed', 'invalid_response'],
      ['beta', 'filled', null],
    ])
    // A malformed answer is not billed and is not tried again.
    expect(bad.calls).toHaveLength(1)
    expect(run.costMicros).toBe(10_000)
    const month = `${w.t.deps.clock.now().toISOString().slice(0, 7)}-01`
    const spent = [...w.t.deps.store.spendOf(w.organizationId, month).values()]
    expect(spent.reduce((sum, s) => sum + s.costMicros, 0)).toBe(10_000)
  })

  test('a malformed verifier verdict is an invalid_response attempt and the run stays readable', async () => {
    const bad = createMemoryVerifier({
      key: key('verifyco'),
      respond: async () => ({}) as never,
    })
    const w = await world({ verifiers: [bad], settings: [setting('verifyco', 1)] })
    w.t.deps.core.seed(w.organizationId, {
      id: w.prospectId,
      ownerId: w.owner.userId,
      values: { email: 'lead@example.test' },
    })

    const { run } = await enrichOne(w, {
      prospectIds: [w.prospectId],
      groups: ['email_verification'],
    })

    expect(run.emailVerification).toBeNull()
    expect(run.attempts.map((a) => [a.outcome, a.failure])).toEqual([
      ['failed', 'invalid_response'],
    ])
    expect(run.costMicros).toBe(0)
    expect(bad.calls).toHaveLength(1)
  })
})

describe('resuming a run', () => {
  test('a run resumed after a recorded budget skip stays stopped with its reason', async () => {
    const alpha = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const beta = createMemoryProvider({ key: key('beta'), groups: ['person'] })
    const w = await world({
      providers: [alpha, beta],
      settings: [setting('alpha', 1), setting('beta', 2)],
    })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const [queued] = await w.runsOf((created.body as { id: string }).id)
    if (queued === undefined) {
      throw new Error('no run')
    }
    // The state a crash leaves: the skip is recorded, the run was never finished.
    const claimed = await w.t.deps.store.claim(
      w.organizationId,
      queued.id,
      w.t.deps.clock.now(),
      120
    )
    if (claimed.kind !== 'claimed') {
      throw new Error('not claimed')
    }
    await w.t.deps.store.recordAttempt(
      w.organizationId,
      queued.id,
      claimed.lease,
      {
        provider: key('alpha'),
        group: 'person',
        outcome: 'skipped_budget',
        failure: null,
        costMicros: 0,
        startedAt: w.t.deps.clock.now().toISOString(),
        durationMs: 0,
        position: 0,
      },
      []
    )
    w.t.deps.time.advance(121_000)

    await w.drain()
    const run = await w.run(queued.id)

    expect(run.status).toBe('stopped')
    expect(run.stopReason).toBe('monthly_budget')
    expect(alpha.calls).toHaveLength(0)
    expect(beta.calls).toHaveLength(0)
  })
})

describe('idempotency across callers', () => {
  test('a second user with the same key and Prospects does not get the first run set', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const other: TestIdentity = {
      userId: newUserId(),
      organizationId: w.organizationId,
      role: 'owner',
    }
    const body = { prospectIds: [w.prospectId], groups: ['person'] }
    const first = await w.post(body, 'shared-key-00000001')
    expect(first.status).toBe(202)

    const second = await w.post(body, 'shared-key-00000001', other)

    expect(second.status).toBe(422)
    expect(codeOf(second.body)).toBe('request.idempotency_key_reused')
    const replayByFirst = await w.post(body, 'shared-key-00000001')
    expect(replayByFirst.status).toBe(200)
  })
})

/** The first instant of the month after the current virtual time, in milliseconds. */
function nextMonthStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
}

describe('a Prospect core no longer has', () => {
  test('a write-back that finds it gone ends the run incomplete instead of retrying the message', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const [run] = await w.runsOf((created.body as { id: string }).id)
    if (run === undefined) {
      throw new Error('no run')
    }
    w.t.deps.core.prospects.writeEnrichedFields = async () => {
      throw new CoreProspectNotFoundError()
    }

    await Waterfall.execute(w.t.deps.enrichment, w.organizationId, run.id)

    const finished = await w.run(run.id)
    expect(finished.status).toBe('incomplete')
    expect(w.t.deps.core.writeCalls()).toBe(0)
  })

  test('a run that had already hit its ceiling keeps the stop when the Prospect is gone', async () => {
    const first = createMemoryProvider({
      key: key('alpha'),
      groups: ['person', 'company'],
      priceMicros: 8_000,
      respond: async () => [{ field: 'jobTitle', value: 'CEO', confidence: 90 }],
    })
    const w = await world({
      providers: [first],
      settings: [setting('alpha', 1)],
      ceiling: '10000',
    })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person', 'company'] })
    const [run] = await w.runsOf((created.body as { id: string }).id)
    if (run === undefined) {
      throw new Error('no run')
    }
    let attempted = 0
    w.t.deps.core.prospects.writeEnrichedFields = async () => {
      attempted += 1
      throw new CoreProspectNotFoundError()
    }

    await Waterfall.execute(w.t.deps.enrichment, w.organizationId, run.id)

    const finished = await w.run(run.id)
    expect(attempted).toBe(1)
    expect(finished.status).toBe('stopped')
    expect(finished.stopReason).toBe('run_ceiling')
  })
})

describe('the budget reservation', () => {
  test('a reservation left by a crash is taken back when the run is claimed again', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const [run] = await w.runsOf((created.body as { id: string }).id)
    if (run === undefined) {
      throw new Error('no run')
    }
    const store = w.t.deps.store
    const deps = w.t.deps.enrichment
    const month = Waterfall.monthOf(w.t.deps.clock.now())
    // The process dies after reserving and before recording: nothing runs after that point.
    const realRecord = store.recordAttempt.bind(store)
    let crashed = false
    store.recordAttempt = async (...args) => {
      if (!crashed) {
        crashed = true
        throw new Error('process died')
      }
      return realRecord(...args)
    }
    store.releaseSpend = async () => {}
    await expect(Waterfall.execute(deps, w.organizationId, run.id)).rejects.toThrow()
    expect(await store.monthSpend(w.organizationId, month)).toBe(10_000)

    await w.t.deps.time.advance((deps.limits.runLeaseSeconds + 1) * 1000)
    await Waterfall.execute(deps, w.organizationId, run.id)

    expect((await w.run(run.id)).status).toBe('complete')
    expect(await store.monthSpend(w.organizationId, month)).toBe(10_000)
  })

  test('a reservation of a run nobody resumes expires and stops counting against the month', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({
      providers: [provider],
      settings: [setting('alpha', 1)],
      budget: '15000',
    })
    const other = newProspectId()
    w.t.deps.core.seed(w.organizationId, { id: other, ownerId: w.owner.userId, values: {} })
    const first = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const second = await w.post({ prospectIds: [other], groups: ['person'] })
    const [lost] = await w.runsOf((first.body as { id: string }).id)
    const [next] = await w.runsOf((second.body as { id: string }).id)
    if (lost === undefined || next === undefined) {
      throw new Error('no run')
    }
    const store = w.t.deps.store
    const deps = w.t.deps.enrichment
    const realRecord = store.recordAttempt
    const realRelease = store.releaseSpend
    store.recordAttempt = async () => {
      throw new Error('process died')
    }
    store.releaseSpend = async () => {}
    await expect(Waterfall.execute(deps, w.organizationId, lost.id)).rejects.toThrow()
    store.recordAttempt = realRecord
    store.releaseSpend = realRelease
    await w.t.deps.time.advance((deps.limits.runLeaseSeconds + 1) * 1000)

    await Waterfall.execute(deps, w.organizationId, next.id)

    expect((await w.run(next.id)).status).toBe('complete')
  })

  test('a release after the month changed is charged back to the month it was reserved in', async () => {
    const provider = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      respond: async () => {
        throw new ProviderError('key_rejected')
      },
    })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const clock = w.t.deps.clock
    await w.t.deps.time.advance(nextMonthStart(clock.now()) - 1_000 - clock.now().getTime())
    const march = Waterfall.monthOf(clock.now())
    const store = w.t.deps.store
    const realReserve = store.reserveSpend.bind(store)
    store.reserveSpend = async (...args) => {
      const reserved = await realReserve(...args)
      await w.t.deps.time.advance(2_000)
      return reserved
    }

    await enrichOne(w, { prospectIds: [w.prospectId], groups: ['person'] })

    const april = Waterfall.monthOf(clock.now())
    expect(april).not.toBe(march)
    expect(await store.monthSpend(w.organizationId, march)).toBe(0)
    expect(await store.monthSpend(w.organizationId, april)).toBe(0)
  })
})

describe('the run lease', () => {
  test('a worker that lost its lease cannot record or finish; the run keeps the new holder result', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = createMemoryProvider({
      key: key('alpha'),
      groups: ['person'],
      respond: async (request, call) => {
        if (call === 1) {
          await gate
        }
        return request.wanted.map((field) => ({ field, value: `v-${call}`, confidence: 90 }))
      },
    })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const [run] = await w.runsOf((created.body as { id: string }).id)
    if (run === undefined) {
      throw new Error('no run')
    }
    const deps = w.t.deps.enrichment
    const slow = Waterfall.execute(deps, w.organizationId, run.id)
    await w.t.deps.time.advance((deps.limits.runLeaseSeconds + 1) * 1000)
    await Waterfall.execute(deps, w.organizationId, run.id)
    const done = await w.run(run.id)
    expect(done.status).toBe('complete')

    release()
    await expect(slow).resolves.toBeUndefined()

    const after = await w.run(run.id)
    expect(after.attempts).toHaveLength(1)
    expect(after.costMicros).toBe(10_000)
    expect(after.fields.every((field) => field.value === 'v-2')).toBe(true)
    expect(w.t.deps.core.writeCalls()).toBe(1)
    const month = Waterfall.monthOf(w.t.deps.clock.now())
    expect(await w.t.deps.store.monthSpend(w.organizationId, month)).toBe(10_000)
  })

  test('renewing the lease keeps the token and the true start time', async () => {
    const w = await world({
      providers: [createMemoryProvider({ key: key('alpha'), groups: ['person'] })],
      settings: [setting('alpha', 1)],
    })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const [run] = await w.runsOf((created.body as { id: string }).id)
    if (run === undefined) {
      throw new Error('no run')
    }
    const store = w.t.deps.store
    const now = w.t.deps.clock.now()
    const claim = await store.claim(w.organizationId, run.id, now, 120)
    if (claim.kind !== 'claimed') {
      throw new Error('not claimed')
    }
    const later = new Date(now.getTime() + 60_000)

    const lease = await store.renewLease(w.organizationId, run.id, claim.lease, later)

    expect(lease).toBe(claim.lease)
    expect((await w.run(run.id)).startedAt).toBe(now.toISOString())
    const again = await store.claim(
      w.organizationId,
      run.id,
      new Date(later.getTime() + 61_000),
      120
    )
    expect(again.kind).toBe('busy')
  })

  test('a new claim after the lease ran out issues a new token and fences the old one', async () => {
    const w = await world({
      providers: [createMemoryProvider({ key: key('alpha'), groups: ['person'] })],
      settings: [setting('alpha', 1)],
    })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const [run] = await w.runsOf((created.body as { id: string }).id)
    if (run === undefined) {
      throw new Error('no run')
    }
    const store = w.t.deps.store
    const now = w.t.deps.clock.now()
    const first = await store.claim(w.organizationId, run.id, now, 120)
    const later = new Date(now.getTime() + 121_000)
    const second = await store.claim(w.organizationId, run.id, later, 120)
    if (first.kind !== 'claimed' || second.kind !== 'claimed') {
      throw new Error('not claimed')
    }

    expect(second.lease).not.toBe(first.lease)
    await expect(
      store.renewLease(w.organizationId, run.id, first.lease, later)
    ).rejects.toBeInstanceOf(LeaseLostError)
  })

  test('the lease is renewed between provider calls, so a long run is not taken from its worker', async () => {
    const claims: string[] = []
    const w0 = await world()
    const lease = w0.t.deps.enrichment.limits.runLeaseSeconds
    const slow = (name: string) =>
      createMemoryProvider({
        key: key(name),
        groups: ['person'],
        respond: async () => {
          await w.t.deps.time.advance(((lease * 5) / 6) * 1000)
          const taken = await w.t.deps.store.claim(
            w.organizationId,
            runId,
            w.t.deps.clock.now(),
            lease
          )
          claims.push(taken.kind)
          return []
        },
      })
    const w = await world({
      providers: [slow('alpha'), slow('beta'), slow('gamma')],
      settings: [setting('alpha', 1), setting('beta', 2), setting('gamma', 3)],
    })
    const created = await w.post({ prospectIds: [w.prospectId], groups: ['person'] })
    const [run] = await w.runsOf((created.body as { id: string }).id)
    if (run === undefined) {
      throw new Error('no run')
    }
    const runId = run.id

    await Waterfall.execute(w.t.deps.enrichment, w.organizationId, runId)

    expect(claims).toEqual(['busy', 'busy', 'busy'])
  })
})

describe('one idempotency key, one request', () => {
  test('concurrent requests with the same key and different Prospects make one run set', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const other = newProspectId()
    w.t.deps.core.seed(w.organizationId, { id: other, ownerId: w.owner.userId, values: {} })

    const [a, b] = await Promise.all([
      w.post({ prospectIds: [w.prospectId], groups: ['person'] }, 'shared-key-00000002'),
      w.post({ prospectIds: [other], groups: ['person'] }, 'shared-key-00000002'),
    ])

    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([202, 422])
    const loser = a.status === 422 ? a : b
    expect(codeOf(loser.body)).toBe('request.idempotency_key_reused')
    await w.drain()
    const all = await w.get('/v1/enrichment-runs')
    expect((all.body.items as unknown[]).length).toBe(1)
  })

  test('the same key later with other Prospects is refused and makes no runs', async () => {
    const provider = createMemoryProvider({ key: key('alpha'), groups: ['person'] })
    const w = await world({ providers: [provider], settings: [setting('alpha', 1)] })
    const other = newProspectId()
    w.t.deps.core.seed(w.organizationId, { id: other, ownerId: w.owner.userId, values: {} })
    await w.post({ prospectIds: [w.prospectId], groups: ['person'] }, 'shared-key-00000003')

    const refused = await w.post(
      { prospectIds: [other], groups: ['person'] },
      'shared-key-00000003'
    )

    expect(refused.status).toBe(422)
    expect(codeOf(refused.body)).toBe('request.idempotency_key_reused')
    const all = await w.get('/v1/enrichment-runs')
    expect((all.body.items as unknown[]).length).toBe(1)
  })
})
