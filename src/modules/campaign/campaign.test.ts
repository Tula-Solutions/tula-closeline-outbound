import { describe, expect, test } from 'bun:test'
import type { Campaign, CampaignId, OrganizationId, Step } from 'tula-closeline-contract'
import { membershipOf } from '~/adapters/memory/core'
import {
  createTestApp,
  newOrganizationId,
  newUserId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

type Reply = { status: number; body: Record<string, unknown> }

/** The `area.reason` code of an error body. */
function codeOf(body: Record<string, unknown>): unknown {
  return (body.error as { code?: unknown } | undefined)?.code
}

const WINDOW = {
  timeZone: 'America/New_York',
  days: ['mon', 'tue'],
  startMinute: 540,
  endMinute: 1020,
}

function campaignBody(name = 'Q3 outreach', extra: Record<string, unknown> = {}) {
  return {
    name,
    goal: 'Book intro calls with VPs of Sales',
    audience: { kind: 'filter', status: 'active' },
    sendWindow: WINDOW,
    dailyCap: 50,
    ...extra,
  }
}

const GOOD_STEPS: Step[] = [
  { kind: 'email', key: 'intro', goal: 'Introduce us', variants: null, next: 'pause' },
  { kind: 'wait', key: 'pause', waitHours: 48, next: 'bye' },
  { kind: 'end', key: 'bye' },
]

type World = {
  t: TestApp
  org: OrganizationId
  owner: TestIdentity
  admin: TestIdentity
  manager: TestIdentity
  rep: TestIdentity
  otherRep: TestIdentity
  call: (
    method: string,
    path: string,
    as: TestIdentity,
    body?: unknown,
    key?: string | null
  ) => Promise<Reply>
  create: (as: TestIdentity, name?: string) => Promise<Campaign>
  force: (id: string, change: Partial<Campaign>, org?: OrganizationId) => Promise<void>
}

async function world(): Promise<World> {
  const t = await createTestApp()
  const org = newOrganizationId()
  const who = (role: TestIdentity['role']): TestIdentity => ({
    userId: newUserId(),
    organizationId: org,
    role,
  })
  const owner = who('owner')
  const admin = who('admin')
  const manager = who('manager')
  const rep = who('rep')
  const otherRep = who('rep')
  t.deps.core.setTeam(org, manager.userId, [rep.userId])
  let counter = 0
  const call: World['call'] = async (method, path, as, body, key) => {
    counter += 1
    const idempotency = key === undefined ? `key-${counter}-${crypto.randomUUID()}` : key
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(as)),
        'content-type': 'application/json',
        ...(idempotency === null ? {} : { 'idempotency-key': idempotency }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return {
    t,
    org,
    owner,
    admin,
    manager,
    rep,
    otherRep,
    call,
    create: async (as, name) => {
      const reply = await call('POST', '/v1/campaigns', as, campaignBody(name))
      expect(reply.status).toBe(201)
      return reply.body as unknown as Campaign
    },
    force: async (id, change, organization = org) => {
      await t.deps.campaigns.store.modify(organization, id as CampaignId, (c) => ({
        ...c,
        ...change,
      }))
    },
  }
}

describe('create and read', () => {
  test('creates a draft Campaign owned by the caller, and a replay answers 200 with the same one', async () => {
    const w = await world()
    const key = 'create-key-0000000001'
    const first = await w.call('POST', '/v1/campaigns', w.rep, campaignBody(), key)
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({
      name: 'Q3 outreach',
      state: 'draft',
      sequenceVersion: 0,
      previewedVersion: null,
      approvalMode: 'review',
      language: 'en',
      windowZone: 'campaign',
      ownerMembershipId: membershipOf(w.rep.userId),
      archivedAt: null,
    })
    const replay = await w.call('POST', '/v1/campaigns', w.rep, campaignBody(), key)
    expect(replay.status).toBe(200)
    expect(replay.body.id).toBe(first.body.id)
    const reused = await w.call('POST', '/v1/campaigns', w.rep, campaignBody('Another'), key)
    expect(reused.status).toBe(422)
    expect(codeOf(reused.body)).toBe('request.idempotency_key_reused')
    const list = await w.call('GET', '/v1/campaigns', w.rep)
    expect((list.body.items as unknown[]).length).toBe(1)
  })

  test('a call without an Idempotency-Key is refused, and so is a Play that does not exist', async () => {
    const w = await world()
    const missing = await w.call('POST', '/v1/campaigns', w.rep, campaignBody(), null)
    expect(missing.status).toBe(400)
    expect(codeOf(missing.body)).toBe('request.invalid')
    const play = await w.call(
      'POST',
      '/v1/campaigns',
      w.rep,
      campaignBody('With play', { playId: `ply_${'a'.repeat(32)}` })
    )
    expect(codeOf(play.body)).toBe('play.not_found')
  })

  test('reads one Campaign; an unknown id is campaign.not_found', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    const got = await w.call('GET', `/v1/campaigns/${made.id}`, w.rep)
    expect(got.status).toBe(200)
    expect(got.body.id).toBe(made.id)
    const missing = await w.call('GET', `/v1/campaigns/cpg_${'0'.repeat(32)}`, w.rep)
    expect(missing.status).toBe(404)
    expect(codeOf(missing.body)).toBe('campaign.not_found')
  })
})

describe('visibility', () => {
  test('a Rep sees own, a Manager their Team, an Admin and an Owner all', async () => {
    const w = await world()
    const mine = await w.create(w.rep, 'Rep one')
    const theirs = await w.create(w.otherRep, 'Rep two')
    const managers = await w.create(w.manager, 'Manager own')
    const ids = async (as: TestIdentity) =>
      ((await w.call('GET', '/v1/campaigns', as)).body.items as { id: string }[])
        .map((c) => c.id)
        .sort()
    expect(await ids(w.rep)).toEqual([mine.id])
    expect(await ids(w.otherRep)).toEqual([theirs.id])
    expect(await ids(w.manager)).toEqual([mine.id, managers.id].sort())
    expect(await ids(w.admin)).toEqual([mine.id, theirs.id, managers.id].sort())
    expect(await ids(w.owner)).toEqual([mine.id, theirs.id, managers.id].sort())
  })

  test('outside the view a Campaign is 404, never 403, for every call', async () => {
    const w = await world()
    const mine = await w.create(w.rep)
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['PATCH', '', { name: 'Stolen' }],
      ['POST', '/duplicate', { name: 'Copy' }],
      ['POST', '/pause', undefined],
      ['GET', '/sequence', undefined],
      ['PUT', '/sequence', { expectedVersion: 0, steps: GOOD_STEPS }],
    ] as const) {
      const reply = await w.call(method, `/v1/campaigns/${mine.id}${suffix}`, w.otherRep, body)
      expect(reply.status).toBe(404)
      expect(codeOf(reply.body)).toBe('campaign.not_found')
    }
    const manager = await w.call('PATCH', `/v1/campaigns/${mine.id}`, w.manager, {
      name: 'Renamed',
    })
    expect(manager.status).toBe(200)
    const outsider = await w.create(w.otherRep, 'Other team')
    const refused = await w.call('PATCH', `/v1/campaigns/${outsider.id}`, w.manager, { name: 'X' })
    expect(refused.status).toBe(404)
  })

  test('filters narrow but never widen the view', async () => {
    const w = await world()
    await w.create(w.rep)
    const theirs = await w.create(w.otherRep)
    const asRep = await w.call(
      'GET',
      `/v1/campaigns?ownerMembershipId=${theirs.ownerMembershipId}`,
      w.rep
    )
    expect(asRep.body.items).toEqual([])
    const draft = await w.call('GET', '/v1/campaigns?state=draft', w.admin)
    expect((draft.body.items as unknown[]).length).toBe(2)
    const running = await w.call('GET', '/v1/campaigns?state=running', w.admin)
    expect(running.body.items).toEqual([])
  })

  test("a second Organization cannot read, list or change another's Campaigns", async () => {
    const w = await world()
    const made = await w.create(w.rep)
    const stranger: TestIdentity = {
      userId: newUserId(),
      organizationId: newOrganizationId(),
      role: 'owner',
    }
    expect((await w.call('GET', '/v1/campaigns', stranger)).body.items).toEqual([])
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['PATCH', '', { name: 'Hijack' }],
      ['POST', '/duplicate', { name: 'Copy' }],
      ['POST', '/archive', undefined],
      ['POST', '/pause', undefined],
      ['GET', '/sequence', undefined],
      ['PUT', '/sequence', { expectedVersion: 0, steps: GOOD_STEPS }],
    ] as const) {
      const reply = await w.call(method, `/v1/campaigns/${made.id}${suffix}`, stranger, body)
      expect(reply.status).toBe(404)
      expect(codeOf(reply.body)).toBe('campaign.not_found')
    }
    const untouched = await w.call('GET', `/v1/campaigns/${made.id}`, w.owner)
    expect(untouched.body.name).toBe('Q3 outreach')
  })
})

describe('list pages', () => {
  test('walks newest first by cursor without a repeat or a gap, and caps the page size', async () => {
    const w = await world()
    const made: string[] = []
    for (let i = 0; i < 5; i++) {
      made.push((await w.create(w.admin, `Campaign ${i}`)).id)
      w.t.deps.time.advance(1000)
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 5; pages++) {
      const path: string = `/v1/campaigns?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
      const page = await w.call('GET', path, w.admin)
      expect(page.status).toBe(200)
      seen.push(...(page.body.items as { id: string }[]).map((c) => c.id))
      cursor = page.body.nextCursor as string | null
      if (cursor === null) {
        break
      }
    }
    expect(seen).toEqual([...made].reverse())
    expect((await w.call('GET', '/v1/campaigns?limit=101', w.admin)).status).toBe(400)
    const bad = await w.call('GET', '/v1/campaigns?cursor=not-a-cursor', w.admin)
    expect(bad.status).toBe(400)
    expect(codeOf(bad.body)).toBe('request.invalid')
  })
})

describe('update', () => {
  test('changes the fields sent; an audience change moves the audience version', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    const reply = await w.call('PATCH', `/v1/campaigns/${made.id}`, w.rep, {
      name: 'Renamed',
      audience: { kind: 'filter', status: 'archived' },
    })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      name: 'Renamed',
      goal: made.goal,
      audienceVersion: made.audienceVersion + 1,
    })
    const same = await w.call('PATCH', `/v1/campaigns/${made.id}`, w.rep, { dailyCap: 20 })
    expect(same.body.audienceVersion).toBe(made.audienceVersion + 1)
    expect((await w.call('PATCH', `/v1/campaigns/${made.id}`, w.rep, {})).status).toBe(400)
  })

  test('an audience or window change returns a ready Campaign to draft; other changes do not', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    await w.force(made.id, { state: 'ready', previewedVersion: 1 })
    const cap = await w.call('PATCH', `/v1/campaigns/${made.id}`, w.rep, { dailyCap: 10 })
    expect(cap.body.state).toBe('ready')
    const window = await w.call('PATCH', `/v1/campaigns/${made.id}`, w.rep, {
      sendWindow: { ...WINDOW, startMinute: 600 },
    })
    expect(window.body.state).toBe('draft')
    await w.force(made.id, { state: 'ready' })
    const audience = await w.call('PATCH', `/v1/campaigns/${made.id}`, w.rep, {
      audience: { kind: 'filter', q: 'acme' },
    })
    expect(audience.body.state).toBe('draft')
  })

  test('an archived Campaign cannot change', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    await w.call('POST', `/v1/campaigns/${made.id}/archive`, w.admin)
    const reply = await w.call('PATCH', `/v1/campaigns/${made.id}`, w.rep, { name: 'Late' })
    expect(reply.status).toBe(409)
    expect(codeOf(reply.body)).toBe('campaign.invalid_state')
  })
})

describe('duplicate', () => {
  test('copies settings, audience and Sequence into a new draft owned by the caller', async () => {
    const w = await world()
    const made = await w.create(w.rep, 'Original')
    await w.call('PUT', `/v1/campaigns/${made.id}/sequence`, w.rep, {
      expectedVersion: 0,
      steps: GOOD_STEPS,
    })
    await w.force(made.id, {
      state: 'ready',
      previewedVersion: 1,
      previewedAt: '2026-01-01T00:00:00.000Z',
    })
    const key = 'duplicate-key-00000001'
    const copy = await w.call(
      'POST',
      `/v1/campaigns/${made.id}/duplicate`,
      w.manager,
      { name: 'Copy' },
      key
    )
    expect(copy.status).toBe(201)
    expect(copy.body).toMatchObject({
      name: 'Copy',
      state: 'draft',
      goal: made.goal,
      audience: made.audience,
      sequenceVersion: 1,
      previewedVersion: null,
      previewedAt: null,
      launchedAt: null,
      ownerMembershipId: membershipOf(w.manager.userId),
    })
    expect(copy.body.id).not.toBe(made.id)
    const steps = await w.call('GET', `/v1/campaigns/${copy.body.id}/sequence`, w.manager)
    expect(steps.body.steps).toEqual(GOOD_STEPS)
    const replay = await w.call(
      'POST',
      `/v1/campaigns/${made.id}/duplicate`,
      w.manager,
      { name: 'Copy' },
      key
    )
    expect(replay.status).toBe(200)
    expect(replay.body.id).toBe(copy.body.id)
    const reused = await w.call(
      'POST',
      `/v1/campaigns/${made.id}/duplicate`,
      w.manager,
      { name: 'Other' },
      key
    )
    expect(codeOf(reused.body)).toBe('request.idempotency_key_reused')
  })
})

describe('archive and pause', () => {
  test('only an Owner or Admin archives; archiving again answers 200 and changes nothing', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    const refused = await w.call('POST', `/v1/campaigns/${made.id}/archive`, w.rep)
    expect(refused.status).toBe(403)
    expect(codeOf(refused.body)).toBe('auth.forbidden')
    const first = await w.call('POST', `/v1/campaigns/${made.id}/archive`, w.admin)
    expect(first.status).toBe(200)
    expect(first.body.state).toBe('archived')
    expect(first.body.archivedAt).not.toBeNull()
    w.t.deps.time.advance(5000)
    const again = await w.call('POST', `/v1/campaigns/${made.id}/archive`, w.owner)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
  })

  test('pauses a running Campaign; a draft cannot be paused; pausing twice is fine', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    const early = await w.call('POST', `/v1/campaigns/${made.id}/pause`, w.rep)
    expect(early.status).toBe(409)
    expect(codeOf(early.body)).toBe('campaign.invalid_state')
    await w.force(made.id, { state: 'running', launchedAt: '2026-01-01T00:00:00.000Z' })
    const paused = await w.call('POST', `/v1/campaigns/${made.id}/pause`, w.rep)
    expect(paused.status).toBe(200)
    expect(paused.body.state).toBe('paused')
    const twice = await w.call('POST', `/v1/campaigns/${made.id}/pause`, w.rep)
    expect(twice.body.state).toBe('paused')
  })
})

describe('Sequence versions', () => {
  const put = (w: World, id: string, expectedVersion: number, steps: unknown, as = w.rep) =>
    w.call('PUT', `/v1/campaigns/${id}/sequence`, as, { expectedVersion, steps })

  test('an empty Sequence is version 0; a save makes version 1 and bumps the Campaign', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    const empty = await w.call('GET', `/v1/campaigns/${made.id}/sequence`, w.rep)
    expect(empty.body).toMatchObject({ campaignId: made.id, version: 0, steps: [] })
    const saved = await put(w, made.id, 0, GOOD_STEPS)
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ version: 1, steps: GOOD_STEPS })
    const campaign = await w.call('GET', `/v1/campaigns/${made.id}`, w.rep)
    expect(campaign.body.sequenceVersion).toBe(1)
  })

  test('an invalid graph is campaign.invalid_sequence and names the offending step', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    const unknown = await put(w, made.id, 0, [
      { kind: 'email', key: 'intro', goal: 'Hello', variants: null, next: 'nowhere' },
      { kind: 'end', key: 'bye' },
    ])
    expect(unknown.status).toBe(422)
    expect(codeOf(unknown.body)).toBe('campaign.invalid_sequence')
    const details = (unknown.body.error as { details: { problems: unknown[] } }).details
    expect(details.problems).toContainEqual({ code: 'unknown_target', stepKey: 'intro' })
    const loop = await put(w, made.id, 0, [
      { kind: 'email', key: 'a', goal: 'Hello', variants: null, next: 'b' },
      { kind: 'email', key: 'b', goal: 'Again', variants: null, next: 'a' },
      { kind: 'end', key: 'bye' },
    ])
    const loopDetails = (loop.body.error as { details: { problems: { code: string }[] } }).details
    expect(loopDetails.problems.map((p) => p.code)).toContain('cycle_without_wait')
    const nothing = await w.call('GET', `/v1/campaigns/${made.id}`, w.rep)
    expect(nothing.body.sequenceVersion).toBe(0)
  })

  test('a test whose weights do not add up to 100 is variant.invalid_weights', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    const variants = (weights: number[]) => ({
      variants: weights.map((weight, i) => ({
        key: `v${i}`,
        label: `Variant ${i}`,
        angle: 'Lead with a customer story',
        weight,
      })),
      promotion: { mode: 'manual' },
    })
    for (const weights of [[60, 30], [99], [20, 20, 20, 20, 20]]) {
      const reply = await put(w, made.id, 0, [
        { kind: 'email', key: 'intro', goal: 'Hello', variants: variants(weights), next: 'bye' },
        { kind: 'end', key: 'bye' },
      ])
      expect(codeOf(reply.body)).toBe('variant.invalid_weights')
    }
    const fine = await put(w, made.id, 0, [
      { kind: 'email', key: 'intro', goal: 'Hello', variants: variants([60, 40]), next: 'bye' },
      { kind: 'end', key: 'bye' },
    ])
    expect(fine.status).toBe(200)
    expect((fine.body.steps as { variants: unknown }[])[0]?.variants).toEqual(variants([60, 40]))
  })

  test('a stale expectedVersion is a conflict; the same body again changes nothing', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    await put(w, made.id, 0, GOOD_STEPS)
    const replay = await put(w, made.id, 0, GOOD_STEPS)
    expect(replay.status).toBe(200)
    expect(replay.body.version).toBe(1)
    const edited: Step[] = [...GOOD_STEPS.slice(0, 1), { kind: 'end', key: 'bye' }] as Step[]
    const stale = await put(w, made.id, 0, [
      { kind: 'email', key: 'intro', goal: 'Introduce us', variants: null, next: 'bye' },
      ...edited.slice(1),
    ])
    expect(stale.status).toBe(409)
    expect(codeOf(stale.body)).toBe('campaign.sequence_version_conflict')
    const next = await put(w, made.id, 1, [
      { kind: 'email', key: 'intro', goal: 'Introduce us', variants: null, next: 'bye' },
      { kind: 'end', key: 'bye' },
    ])
    expect(next.body.version).toBe(2)
  })

  test('a new version returns a ready Campaign to draft and needs a new preview', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    await put(w, made.id, 0, GOOD_STEPS)
    await w.force(made.id, {
      state: 'ready',
      previewedVersion: 1,
      previewedAt: '2026-01-01T00:00:00.000Z',
    })
    await put(w, made.id, 1, [
      { kind: 'email', key: 'intro', goal: 'Introduce us', variants: null, next: 'bye' },
      { kind: 'end', key: 'bye' },
    ])
    const after = await w.call('GET', `/v1/campaigns/${made.id}`, w.rep)
    expect(after.body).toMatchObject({ state: 'draft', sequenceVersion: 2, previewedVersion: 1 })
  })

  test('editing a running Campaign adds a version; the one Enrollments started on stays', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    await put(w, made.id, 0, GOOD_STEPS)
    await w.force(made.id, { state: 'running', launchedAt: '2026-01-01T00:00:00.000Z' })
    const shorter = [
      { kind: 'email', key: 'intro', goal: 'Introduce us', variants: null, next: 'bye' },
      { kind: 'end', key: 'bye' },
    ]
    const edited = await put(w, made.id, 1, shorter)
    expect(edited.status).toBe(200)
    expect(edited.body.version).toBe(2)
    const campaign = await w.call('GET', `/v1/campaigns/${made.id}`, w.rep)
    expect(campaign.body).toMatchObject({ state: 'running', sequenceVersion: 2 })
    const started = await w.t.deps.campaigns.store.readSequence(w.org, made.id as CampaignId, 1)
    expect(started?.steps).toEqual(GOOD_STEPS)
    const current = await w.call('GET', `/v1/campaigns/${made.id}/sequence`, w.rep)
    expect(current.body.steps).toEqual(shorter)
  })

  test('an archived Campaign refuses a new version', async () => {
    const w = await world()
    const made = await w.create(w.rep)
    await w.call('POST', `/v1/campaigns/${made.id}/archive`, w.admin)
    const reply = await put(w, made.id, 0, GOOD_STEPS)
    expect(reply.status).toBe(409)
    expect(codeOf(reply.body)).toBe('campaign.invalid_state')
  })
})
