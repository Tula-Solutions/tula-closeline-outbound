import { describe, expect, test } from 'bun:test'
import {
  type CallId,
  type DealRecordId,
  type DocumentId,
  formatId,
  playSchema,
} from 'tula-closeline-contract'
import { ModelBudgetExceededError } from '~/ports/model'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'
import { BUILTIN_PLAYS } from './builtin'
import { EVIDENCE_NOTE_HEADER } from './router'

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
type Any = any
type Reply = { status: number; body: Record<string, Any>; note: string | null }
const codeOf = (r: Reply) => r.body.error?.code

const STEPS = [
  { kind: 'email', key: 'intro', goal: 'Say hello', variants: null, next: 'bye' },
  { kind: 'end', key: 'bye' },
]

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
    return {
      status: response.status,
      body: (await response.json()) as Record<string, Any>,
      note: response.headers.get(EVIDENCE_NOTE_HEADER),
    }
  }
  const moment = (
    as: TestIdentity,
    text = 'A short call that named the cost of waiting won it.'
  ) => {
    const callId = formatId('call', crypto.randomUUID()) as unknown as CallId
    const dealRecordId = formatId('deal', crypto.randomUUID()) as unknown as DealRecordId
    t.deps.researchPlaybook.seed(as.organizationId, [
      { kind: 'moment', callId, dealRecordId, text, score: 0.9 },
    ])
    return { callId, dealRecordId }
  }
  const propose = (as: TestIdentity, body: unknown = { intent: 'cold_intro' }, key?: string) =>
    call('POST', '/v1/plays/propose', as, body, key)
  const candidate = (sourceIds: string[], steps: unknown = STEPS, name = 'Open with the cost') => ({
    name,
    goal: 'Start a conversation',
    steps,
    sourceIds,
  })
  return { t, admin, other, rep, call, moment, propose, candidate }
}

describe('built-in plays', () => {
  test('are valid Plays, one per intent, none with evidence', () => {
    expect(BUILTIN_PLAYS).toHaveLength(4)
    for (const play of BUILTIN_PLAYS) {
      expect(playSchema.safeParse(play).success).toBe(true)
      expect(play.noEvidence).toBe(true)
    }
  })
})

describe('propose', () => {
  test('with an empty Playbook offers only built-in plays and says there is no evidence', async () => {
    const w = await world()
    const reply = await w.propose(w.admin)
    expect(reply.status).toBe(200)
    expect(reply.note).toBe('no evidence in your history')
    expect(reply.body.plays.map((p: Any) => p.source)).toEqual(['builtin'])
    expect(reply.body.plays[0].noEvidence).toBe(true)
    expect(w.t.deps.researchModel.requests).toHaveLength(0)
  })

  test('every proposed Step cites only items the Playbook returned', async () => {
    const w = await world()
    const seen = w.moment(w.admin)
    w.t.deps.researchModel.script({
      candidates: [
        w.candidate(['c1']),
        w.candidate(['c1', 'c9'], STEPS, 'Cites a source it was not given'),
      ],
    })
    const reply = await w.propose(w.admin)
    expect(reply.note).toBeNull()
    expect(reply.body.plays).toHaveLength(1)
    const [play] = reply.body.plays
    expect(play).toMatchObject({ source: 'seeded', status: 'proposed', noEvidence: false })
    expect(play.citations).toEqual([{ kind: 'moment', ...seen }])
    expect(play.evidenceCount).toBe(1)
  })

  test('discards model output that fails the Step schema', async () => {
    const w = await world()
    w.moment(w.admin)
    const loop = [{ kind: 'email', key: 'a', goal: 'x', variants: null, next: 'a' }]
    w.t.deps.researchModel.script({
      candidates: [
        w.candidate(['c1'], [{ kind: 'carrier_pigeon', key: 'a' }]),
        w.candidate(['c1'], loop),
        w.candidate([], STEPS),
        'not an object',
        w.candidate(['c1']),
      ],
    })
    const reply = await w.propose(w.admin, { intent: 'cold_intro', count: 5 })
    expect(reply.body.plays).toHaveLength(1)
    expect(reply.body.plays[0].source).toBe('seeded')
  })

  test('falls back to built-in plays when every candidate is discarded', async () => {
    const w = await world()
    w.moment(w.admin)
    w.t.deps.researchModel.script({ candidates: [w.candidate(['c9'])] })
    const reply = await w.propose(w.admin)
    expect(reply.body.plays.map((p: Any) => p.source)).toEqual(['builtin'])
    // The Playbook did have evidence, so the "no evidence in your history" note would be false.
    expect(reply.note).toBeNull()
  })

  test('a spent model budget is draft.budget_exceeded, not server.unavailable', async () => {
    const w = await world()
    w.moment(w.admin)
    w.t.deps.researchModel.script(new ModelBudgetExceededError())
    expect(codeOf(await w.propose(w.admin))).toBe('draft.budget_exceeded')
  })

  test('never cites another Organization', async () => {
    const w = await world()
    const mine = w.moment(w.admin)
    w.t.deps.researchModel.script({ candidates: [w.candidate(['c1'])] })
    const theirs = w.moment(w.other, 'Their secret win')
    const document = formatId('doc', crypto.randomUUID()) as unknown as DocumentId
    w.t.deps.researchPlaybook.seed(w.other.organizationId, [
      { kind: 'document', documentId: document, page: 3, text: 'Their handbook', score: 0.8 },
    ])
    const reply = await w.propose(w.admin)
    const text = JSON.stringify(reply.body)
    expect(text).toContain(mine.callId)
    expect(text).not.toContain(theirs.callId)
    expect(text).not.toContain(theirs.dealRecordId)
    expect(text).not.toContain(document)
    for (const request of w.t.deps.researchModel.requests) {
      expect(JSON.stringify(request.sources)).not.toContain('Their')
    }
  })

  test('a replay of the Idempotency-Key returns the same proposals; another intent is refused', async () => {
    const w = await world()
    w.moment(w.admin)
    w.t.deps.researchModel.script({ candidates: [w.candidate(['c1'])] })
    const key = 'propose-key-0123456789'
    const first = await w.propose(w.admin, { intent: 'nurture' }, key)
    const again = await w.propose(w.admin, { intent: 'nurture' }, key)
    expect(again.body).toEqual(first.body)
    expect(w.t.deps.researchModel.requests).toHaveLength(1)
    const other = await w.propose(w.admin, { intent: 'cold_intro' }, key)
    expect(codeOf(other)).toBe('request.idempotency_key_reused')
  })

  test('a model failure is draft.model_unavailable and stores nothing', async () => {
    const w = await world()
    w.moment(w.admin)
    w.t.deps.researchModel.script(new Error('boom'))
    const reply = await w.propose(w.admin)
    expect(codeOf(reply)).toBe('draft.model_unavailable')
    expect((await w.call('GET', '/v1/plays?source=seeded', w.admin)).body.items).toEqual([])
  })

  test('a Rep may not propose', async () => {
    const w = await world()
    expect(codeOf(await w.propose(w.rep))).toBe('auth.forbidden')
  })
})

describe('accept, edit and discard', () => {
  const proposed = async () => {
    const w = await world()
    w.moment(w.admin)
    w.t.deps.researchModel.script({ candidates: [w.candidate(['c1'])] })
    const [play] = (await w.propose(w.admin)).body.plays
    return { w, play }
  }

  test('nothing is usable until accepted: a Rep cannot see a proposed Play', async () => {
    const { w, play } = await proposed()
    expect(codeOf(await w.call('GET', `/v1/plays/${play.id}`, w.rep))).toBe('play.not_found')
    expect(
      (await w.call('GET', '/v1/plays', w.rep)).body.items.map((p: Any) => p.id)
    ).not.toContain(play.id)
    await w.call('POST', `/v1/plays/${play.id}/accept`, w.admin, {})
    expect((await w.call('GET', `/v1/plays/${play.id}`, w.rep)).status).toBe(200)
  })

  test('accepting is idempotent; a discarded Play cannot be accepted or edited', async () => {
    const { w, play } = await proposed()
    const accepted = await w.call('POST', `/v1/plays/${play.id}/accept`, w.admin, {})
    expect(accepted.body.status).toBe('accepted')
    expect((await w.call('POST', `/v1/plays/${play.id}/accept`, w.admin, {})).status).toBe(200)
    const discarded = await w.call('POST', `/v1/plays/${play.id}/discard`, w.admin)
    expect(discarded.body.status).toBe('discarded')
    expect((await w.call('POST', `/v1/plays/${play.id}/discard`, w.admin)).status).toBe(200)
    expect(codeOf(await w.call('POST', `/v1/plays/${play.id}/accept`, w.admin, {}))).toBe(
      'play.invalid_state'
    )
    expect(codeOf(await w.call('PATCH', `/v1/plays/${play.id}`, w.admin, { name: 'x' }))).toBe(
      'play.invalid_state'
    )
  })

  test('edits the name, goal and Steps, and refuses invalid Steps', async () => {
    const { w, play } = await proposed()
    const edited = await w.call('PATCH', `/v1/plays/${play.id}`, w.admin, { name: 'Renamed' })
    expect(edited.body.name).toBe('Renamed')
    expect(edited.body.citations).toEqual(play.citations)
    const bad = await w.call('PATCH', `/v1/plays/${play.id}`, w.admin, {
      steps: [{ kind: 'wait', key: 'a', waitHours: 1, next: 'a' }],
    })
    expect(codeOf(bad)).toBe('request.invalid')
  })

  test('a Play with no evidence needs the acknowledgement', async () => {
    const w = await world()
    const created = await w.call('POST', '/v1/plays', w.admin, {
      name: 'Mine',
      intent: 'nurture',
      goal: 'Stay in touch',
      steps: STEPS,
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ source: 'custom', status: 'accepted', noEvidence: true })
    // An evidence-free proposal cannot be stored today, so drive the rule through the store.
    const stored = await w.t.deps.plays.store.insertIfAbsent(w.admin.organizationId, {
      ...created.body,
      id: formatId('ply', crypto.randomUUID()),
      status: 'proposed',
    } as never)
    const url = `/v1/plays/${stored.play.id}/accept`
    expect(codeOf(await w.call('POST', url, w.admin, {}))).toBe('play.no_evidence')
    expect((await w.call('POST', url, w.admin, { acknowledgeNoEvidence: true })).status).toBe(200)
  })

  test('built-in plays are read-only but readable by anyone', async () => {
    const w = await world()
    const id = BUILTIN_PLAYS[0]?.id
    expect((await w.call('GET', `/v1/plays/${id}`, w.rep)).status).toBe(200)
    for (const [method, path, body] of [
      ['PATCH', `/v1/plays/${id}`, { name: 'x' }],
      ['POST', `/v1/plays/${id}/accept`, {}],
      ['POST', `/v1/plays/${id}/discard`, undefined],
    ] as const) {
      expect(codeOf(await w.call(method, path, w.admin, body))).toBe('play.read_only')
    }
  })

  test("another Organization's Play is not found", async () => {
    const { w, play } = await proposed()
    expect(codeOf(await w.call('POST', `/v1/plays/${play.id}/discard`, w.other))).toBe(
      'play.not_found'
    )
  })

  test('create replays by key and refuses the key for another body', async () => {
    const w = await world()
    const body = { name: 'Mine', intent: 'nurture', goal: 'Stay in touch', steps: STEPS }
    const first = await w.call('POST', '/v1/plays', w.admin, body, 'same-key-0123456789')
    const again = await w.call('POST', '/v1/plays', w.admin, body, 'same-key-0123456789')
    expect(again.status).toBe(200)
    expect(again.body.id).toBe(first.body.id)
    const reused = await w.call(
      'POST',
      '/v1/plays',
      w.admin,
      { ...body, name: 'Other' },
      'same-key-0123456789'
    )
    expect(codeOf(reused)).toBe('request.idempotency_key_reused')
  })
})

describe('list', () => {
  test('pages stored plays then built-in plays, newest first, with a cursor', async () => {
    const w = await world()
    for (const name of ['One', 'Two']) {
      await w.call('POST', '/v1/plays', w.admin, {
        name,
        intent: 'nurture',
        goal: 'g',
        steps: STEPS,
      })
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const reply: Reply = await w.call(
        'GET',
        `/v1/plays?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`,
        w.admin
      )
      expect(reply.body.items.length).toBeLessThanOrEqual(2)
      seen.push(...reply.body.items.map((p: Any) => p.id))
      cursor = reply.body.nextCursor
      if (cursor === null) {
        break
      }
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
    expect(seen.slice(2).sort()).toEqual(BUILTIN_PLAYS.map((p) => p.id).sort())
  })

  test('filters by intent and source, and a Rep sees accepted plays only', async () => {
    const w = await world()
    const reply = await w.call('GET', '/v1/plays?intent=nurture&source=builtin', w.rep)
    expect(reply.body.items.map((p: Any) => p.intent)).toEqual(['nurture'])
    expect((await w.call('GET', '/v1/plays?status=proposed', w.rep)).body.items).toEqual([])
    expect(codeOf(await w.call('GET', '/v1/plays?cursor=nope', w.admin))).toBe('request.invalid')
  })
})
