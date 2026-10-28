import { describe, expect, test } from 'bun:test'
import { formatId, type ProspectId } from 'tula-closeline-contract'
import type { ProspectValues } from '~/ports/enrichment-provider'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'

type Reply = { status: number; body: Record<string, unknown> }
const codeOf = (body: Record<string, unknown>) =>
  (body.error as { code?: unknown } | undefined)?.code

async function world() {
  const t = await createTestApp()
  const who = (role: TestIdentity['role'], organizationId = newOrganizationId()): TestIdentity => ({
    userId: newUserId(),
    organizationId,
    role,
  })
  const admin = who('admin')
  const other = who('admin')
  const rep = who('rep', admin.organizationId)
  const seed = (as: TestIdentity, values: ProspectValues) => {
    const id: ProspectId = formatId('prs', crypto.randomUUID())
    t.deps.core.seed(as.organizationId, { id, ownerId: as.userId, values })
    return id
  }
  const call = async (
    method: string,
    path: string,
    as: TestIdentity,
    body?: unknown,
    key: string = crypto.randomUUID()
  ): Promise<Reply> => {
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(as)),
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const add = (as: TestIdentity, criterion: Record<string, unknown>) =>
    call('POST', '/v1/fit-criteria', as, criterion)
  return { t, admin, other, rep, seed, call, add }
}

const SAAS = {
  name: 'SaaS industry',
  field: 'industry',
  condition: { operator: 'one_of', values: ['SaaS', 'Fintech'] },
  weight: 40,
}
const SIZE = {
  name: 'Mid-size',
  field: 'employeeCount',
  condition: { operator: 'between', min: 50, max: 500 },
  weight: 30,
}
const TECH = {
  name: 'Uses Postgres',
  field: 'technologies',
  condition: { operator: 'contains_any', values: ['postgres'] },
  weight: 20,
}

describe('fit criteria', () => {
  test('score equals the sum of matched weights and each criterion reports its result', async () => {
    const w = await world()
    for (const c of [SAAS, SIZE, TECH]) {
      expect((await w.add(w.admin, c)).status).toBe(201)
    }
    const prospect = w.seed(w.admin, {
      industry: 'saas',
      employeeCount: '900',
      technologies: 'React, PostgreSQL',
    })
    const fit = await w.call('GET', `/v1/prospects/${prospect}/fit`, w.admin)
    expect(fit.body).toMatchObject({ score: 60, maxScore: 90, criteriaVersion: 3 })
    const results = Object.fromEntries(
      (fit.body.matches as { name: string; result: string }[]).map((m) => [m.name, m.result])
    )
    expect(results).toEqual({
      'SaaS industry': 'matched',
      'Mid-size': 'missed',
      'Uses Postgres': 'matched',
    })
  })

  test('a missing value is unknown and adds nothing', async () => {
    const w = await world()
    await w.add(w.admin, SAAS)
    const prospect = w.seed(w.admin, {})
    const fit = await w.call('GET', `/v1/prospects/${prospect}/fit`, w.admin)
    expect(fit.body.score).toBe(0)
    expect((fit.body.matches as { result: string }[])[0]?.result).toBe('unknown')
  })

  test('fit_changed is emitted when the score moves and not when it does not', async () => {
    const w = await world()
    await w.add(w.admin, SAAS)
    const prospect = w.seed(w.admin, { industry: 'SaaS' })
    await w.call('GET', `/v1/prospects/${prospect}/fit`, w.admin)
    await w.call('GET', `/v1/prospects/${prospect}/fit`, w.admin)
    const events = w.t.deps.signalEvents.filter((e) => e.event.name === 'prospect.fit_changed')
    expect(events.length).toBe(1)
    expect(events[0]?.event.payload).toMatchObject({ previousScore: null, score: 40, maxScore: 40 })
    await w.add(w.admin, {
      ...TECH,
      name: 'Any tech',
      condition: { operator: 'contains_any', values: ['x'] },
    })
    await w.call('GET', `/v1/prospects/${prospect}/fit`, w.admin)
    expect(
      w.t.deps.signalEvents.filter((e) => e.event.name === 'prospect.fit_changed').length
    ).toBe(1)
  })

  test('two identical creates at once give one 201 and one 200 replay, never a refusal', async () => {
    const w = await world()
    const [a, b] = await Promise.all([w.add(w.admin, SAAS), w.add(w.admin, SAAS)])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(a.body.id).toBe(b.body.id)
  })

  test('an operator that does not suit the attribute, a taken name and a different replay are refused', async () => {
    const w = await world()
    const wrong = await w.add(w.admin, { ...SAAS, name: 'x', condition: SIZE.condition })
    expect(codeOf(wrong.body)).toBe('fit.invalid_criteria')
    const first = await w.add(w.admin, SAAS)
    const same = await w.add(w.admin, SAAS)
    expect([same.status, same.body.id]).toEqual([200, first.body.id])
    const different = await w.add(w.admin, { ...SAAS, weight: 5 })
    expect(codeOf(different.body)).toBe('fit.invalid_criteria')
  })

  test('update re-checks, delete is repeatable, and an unknown id is fit.criterion_not_found', async () => {
    const w = await world()
    const made = await w.add(w.admin, SAAS)
    const path = `/v1/fit-criteria/${made.body.id}`
    const ok = await w.call('PATCH', path, w.admin, { weight: 10 })
    expect(ok.body.weight).toBe(10)
    const bad = await w.call('PATCH', path, w.admin, { condition: SIZE.condition })
    expect(codeOf(bad.body)).toBe('fit.invalid_criteria')
    const missing = await w.call(
      'PATCH',
      `/v1/fit-criteria/${formatId('fcr', crypto.randomUUID())}`,
      w.admin,
      { weight: 1 }
    )
    expect(codeOf(missing.body)).toBe('fit.criterion_not_found')
    expect((await w.call('DELETE', path, w.admin)).status).toBe(200)
    expect((await w.call('DELETE', path, w.admin)).status).toBe(200)
    expect((await w.call('GET', '/v1/fit-criteria', w.admin)).body.items).toEqual([])
  })

  test('criteria list pages with a cursor and only admins change them', async () => {
    const w = await world()
    for (const c of [SAAS, SIZE, TECH]) {
      await w.add(w.admin, c)
    }
    const one = await w.call('GET', '/v1/fit-criteria?limit=2', w.rep)
    expect((one.body.items as unknown[]).length).toBe(2)
    const two = await w.call('GET', `/v1/fit-criteria?limit=2&cursor=${one.body.nextCursor}`, w.rep)
    expect((two.body.items as unknown[]).length).toBe(1)
    expect((await w.add(w.rep, SAAS)).status).toBe(403)
  })

  test('scores list highest first and filters by minScore', async () => {
    const w = await world()
    await w.add(w.admin, SAAS)
    const high = w.seed(w.admin, { industry: 'SaaS' })
    const low = w.seed(w.admin, { industry: 'Retail' })
    for (const p of [low, high]) {
      await w.call('GET', `/v1/prospects/${p}/fit`, w.admin)
    }
    const all = await w.call('GET', '/v1/fit-scores', w.admin)
    expect((all.body.items as { prospectId: string }[]).map((i) => i.prospectId)).toEqual([
      high,
      low,
    ])
    const min = await w.call('GET', '/v1/fit-scores?minScore=1', w.admin)
    expect((min.body.items as unknown[]).length).toBe(1)
  })

  test('a second Organization sees none of the first one criteria, Prospects or scores', async () => {
    const w = await world()
    await w.add(w.admin, SAAS)
    const prospect = w.seed(w.admin, { industry: 'SaaS' })
    await w.call('GET', `/v1/prospects/${prospect}/fit`, w.admin)
    expect((await w.call('GET', '/v1/fit-criteria', w.other)).body.items).toEqual([])
    expect((await w.call('GET', '/v1/fit-scores', w.other)).body.items).toEqual([])
    const fit = await w.call('GET', `/v1/prospects/${prospect}/fit`, w.other)
    expect(codeOf(fit.body)).toBe('enrichment.prospect_not_found')
    const made = await w.add(w.admin, TECH)
    const touch = await w.call('PATCH', `/v1/fit-criteria/${made.body.id}`, w.other, { weight: 1 })
    expect(codeOf(touch.body)).toBe('fit.criterion_not_found')
  })
})
