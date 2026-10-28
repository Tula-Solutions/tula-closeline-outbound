import { describe, expect, test } from 'bun:test'
import { encodeCursor } from 'tula-closeline-contract'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'

type Reply = { status: number; body: Record<string, unknown> }

const codeOf = (body: Record<string, unknown>) =>
  (body.error as { code?: unknown } | undefined)?.code

const VOICE = {
  tone: 'Warm and direct, never pushy',
  preferredWords: ['simple', 'together'],
  bannedPhrases: ['synergy', 'circle back'],
  signOff: 'Best, the team',
  maxLengthCharacters: 1200,
}

async function world() {
  const t = await createTestApp()
  const who = (role: TestIdentity['role'], organizationId = newOrganizationId()): TestIdentity => ({
    userId: newUserId(),
    organizationId,
    role,
  })
  const owner = who('owner')
  const inOrg = (role: TestIdentity['role']) => who(role, owner.organizationId)
  let n = 0
  const call = async (
    method: string,
    path: string,
    as: TestIdentity,
    body?: unknown
  ): Promise<Reply> => {
    n += 1
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(as)),
        'content-type': 'application/json',
        'idempotency-key': `key-${n}-${crypto.randomUUID()}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const save = (as: TestIdentity, expectedVersion: number, extra: Record<string, unknown> = {}) =>
    call('PUT', '/v1/brand-voice', as, { ...VOICE, expectedVersion, ...extra })
  return {
    t,
    owner,
    admin: inOrg('admin'),
    manager: inOrg('manager'),
    rep: inOrg('rep'),
    call,
    save,
    who,
  }
}

describe('brand voice', () => {
  test('a missing voice is voice.not_found', async () => {
    const w = await world()
    const reply = await w.call('GET', '/v1/brand-voice', w.rep)
    expect(reply.status).toBe(404)
    expect(codeOf(reply.body)).toBe('voice.not_found')
  })

  test('saving creates a new version and the previous one stays readable', async () => {
    const w = await world()
    const first = await w.save(w.admin, 0)
    expect(first.status).toBe(200)
    expect(first.body.version).toBe(1)
    const second = await w.save(w.owner, 1, { tone: 'Crisp and formal' })
    expect(second.status).toBe(200)
    expect(second.body.version).toBe(2)
    expect(second.body.id).not.toBe(first.body.id)

    const current = await w.call('GET', '/v1/brand-voice', w.rep)
    expect(current.body.version).toBe(2)
    expect(current.body.tone).toBe('Crisp and formal')

    const versions = await w.call('GET', '/v1/brand-voice/versions', w.admin)
    const items = versions.body.items as { version: number; tone: string }[]
    expect(items.map((v) => v.version)).toEqual([2, 1])
    expect(items[1]?.tone).toBe(VOICE.tone)
  })

  test('versions page with a cursor', async () => {
    const w = await world()
    await w.save(w.admin, 0)
    await w.save(w.admin, 1, { tone: 'two' })
    await w.save(w.admin, 2, { tone: 'three' })
    const page = await w.call('GET', '/v1/brand-voice/versions?limit=2', w.admin)
    expect((page.body.items as unknown[]).length).toBe(2)
    const next = await w.call(
      'GET',
      `/v1/brand-voice/versions?limit=2&cursor=${page.body.nextCursor}`,
      w.admin
    )
    expect((next.body.items as { version: number }[]).map((v) => v.version)).toEqual([1])
    expect(next.body.nextCursor).toBeNull()
    const bad = await w.call('GET', '/v1/brand-voice/versions?cursor=garbage', w.admin)
    expect(codeOf(bad.body)).toBe('request.invalid')
    const huge = encodeCursor({ before: 99_999_999_999 })
    const tooBig = await w.call('GET', `/v1/brand-voice/versions?cursor=${huge}`, w.admin)
    expect(codeOf(tooBig.body)).toBe('request.invalid')
  })

  test('a stale expectedVersion is voice.version_conflict; a retry of the last save is not', async () => {
    const w = await world()
    await w.save(w.admin, 0)
    const stale = await w.save(w.admin, 0, { tone: 'different' })
    expect(stale.status).toBe(409)
    expect(codeOf(stale.body)).toBe('voice.version_conflict')
    const retry = await w.save(w.admin, 0)
    expect(retry.status).toBe(200)
    expect(retry.body.version).toBe(1)
    const versions = await w.call('GET', '/v1/brand-voice/versions', w.admin)
    expect((versions.body.items as unknown[]).length).toBe(1)
  })

  test.each([
    ['empty tone', { tone: '' }],
    ['oversized tone', { tone: 'x'.repeat(501) }],
    ['too many banned phrases', { bannedPhrases: Array.from({ length: 101 }, (_, i) => `p${i}`) }],
    ['length limit too large', { maxLengthCharacters: 5001 }],
    ['unknown field', { surprise: 1 }],
    ['a banned phrase that is also preferred', { bannedPhrases: ['Simple'] }],
  ])('invalid voice (%s) is voice.invalid and saves nothing', async (_name, extra) => {
    const w = await world()
    const reply = await w.save(w.admin, 0, extra)
    expect(reply.status).toBe(422)
    expect(codeOf(reply.body)).toBe('voice.invalid')
    expect((await w.call('GET', '/v1/brand-voice', w.admin)).status).toBe(404)
  })

  test('a body with no settings at all is voice.invalid', async () => {
    const w = await world()
    const reply = await w.call('PUT', '/v1/brand-voice', w.admin, { expectedVersion: 0 })
    expect(codeOf(reply.body)).toBe('voice.invalid')
  })

  test('a Rep and a Manager can read but not write, and a Rep cannot list versions', async () => {
    const w = await world()
    await w.save(w.admin, 0)
    for (const who of [w.rep, w.manager]) {
      expect((await w.call('GET', '/v1/brand-voice', who)).status).toBe(200)
      const refused = await w.save(who, 1)
      expect(refused.status).toBe(403)
      expect(codeOf(refused.body)).toBe('auth.forbidden')
      expect(codeOf((await w.call('GET', '/v1/brand-voice/versions', who)).body)).toBe(
        'auth.forbidden'
      )
    }
    expect(
      ((await w.call('GET', '/v1/brand-voice', w.owner)).body as { version: number }).version
    ).toBe(1)
  })

  test('a second Organization sees neither the voice nor its versions', async () => {
    const w = await world()
    await w.save(w.admin, 0)
    const other = w.who('admin')
    expect((await w.call('GET', '/v1/brand-voice', other)).status).toBe(404)
    const versions = await w.call('GET', '/v1/brand-voice/versions', other)
    expect(versions.body.items).toEqual([])
    const own = await w.save(other, 0, { tone: 'Theirs' })
    expect(own.body.version).toBe(1)
    expect(((await w.call('GET', '/v1/brand-voice', w.admin)).body as { tone: string }).tone).toBe(
      VOICE.tone
    )
  })

  test('the author is recorded and the key is required', async () => {
    const w = await world()
    const saved = await w.save(w.admin, 0)
    expect(String(saved.body.createdByMembershipId)).toStartWith('mem_')
    const response = await w.t.app.request('/v1/brand-voice', {
      method: 'PUT',
      headers: { ...(await w.t.bearer(w.admin)), 'content-type': 'application/json' },
      body: JSON.stringify({ ...VOICE, expectedVersion: 1 }),
    })
    expect(response.status).toBe(400)
  })
})
