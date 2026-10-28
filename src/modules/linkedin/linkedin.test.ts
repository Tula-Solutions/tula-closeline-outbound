import { describe, expect, test } from 'bun:test'
import { LINKEDIN_RISK_WORDING_VERSION, type MembershipId } from 'tula-closeline-contract'
import { membershipOf } from '~/adapters/memory/core'
import {
  createTestApp,
  newOrganizationId,
  newUserId,
  type TestApp,
  type TestIdentity,
} from '~/testing'
import { completeConnection } from './service'

type Reply = { status: number; body: Record<string, unknown> }

const codeOf = (body: Record<string, unknown>) =>
  (body.error as { code?: unknown } | undefined)?.code

async function world() {
  const t: TestApp = await createTestApp()
  const org = newOrganizationId()
  const who = (role: TestIdentity['role'], organizationId = org): TestIdentity => ({
    userId: newUserId(),
    organizationId,
    role,
  })
  const owner = who('owner')
  const admin = who('admin')
  const manager = who('manager')
  const rep = who('rep')
  const otherRep = who('rep')
  const outsider = who('rep', newOrganizationId())
  t.deps.core.setTeam(org, manager.userId, [rep.userId])
  t.deps.linkedinStore.setChannel(org, {
    enabled: true,
    acceptedVersions: [LINKEDIN_RISK_WORDING_VERSION],
  })
  const call = async (
    method: string,
    path: string,
    as: TestIdentity,
    key: string = crypto.randomUUID()
  ): Promise<Reply> => {
    const response = await t.app.request(path, {
      method,
      headers: { ...(await t.bearer(as)), 'idempotency-key': key },
    })
    const text = await response.text()
    return { status: response.status, body: text === '' ? {} : JSON.parse(text) }
  }
  /** The Rep starts, finishes the hosted login, and the connection is recorded. */
  const connect = async (as: TestIdentity) => {
    const started = await call('POST', '/v1/linkedin/accounts/connection', as)
    const ref = t.deps.linkedinProvider.completeLogin(started.body.hostedLoginUrl as string)
    const account = await completeConnection(
      t.deps.linkedin,
      as.organizationId,
      membershipOf(as.userId) as MembershipId,
      ref
    )
    return { started, ref, account }
  }
  return { t, org, owner, admin, manager, rep, otherRep, outsider, call, connect }
}

describe('linkedin accounts', () => {
  test('a Rep connects, sees connected, disconnects', async () => {
    const w = await world()
    const { account, ref } = await w.connect(w.rep)
    const got = await w.call('GET', `/v1/linkedin/accounts/${account.id}`, w.rep)
    expect(got.status).toBe(200)
    expect(got.body.status).toBe('connected')
    expect(JSON.stringify(got.body)).not.toContain(ref)
    const gone = await w.call('DELETE', `/v1/linkedin/accounts/${account.id}`, w.rep)
    expect(gone.status).toBe(204)
    expect((await w.call('GET', `/v1/linkedin/accounts/${account.id}`, w.rep)).body.status).toBe(
      'disconnected'
    )
    expect(w.t.deps.linkedinProvider.removed()).toEqual([ref])
    // Disconnecting again changes nothing.
    expect((await w.call('DELETE', `/v1/linkedin/accounts/${account.id}`, w.rep)).status).toBe(204)
    expect(w.t.deps.linkedinProvider.removed()).toEqual([ref])
  })

  test('a second Rep cannot disconnect it; an Admin can', async () => {
    const w = await world()
    const { account } = await w.connect(w.rep)
    const refused = await w.call('DELETE', `/v1/linkedin/accounts/${account.id}`, w.otherRep)
    expect(refused.status).toBe(403)
    expect(codeOf(refused.body)).toBe('linkedin.not_account_owner')
    const manager = await w.call('DELETE', `/v1/linkedin/accounts/${account.id}`, w.manager)
    expect(codeOf(manager.body)).toBe('linkedin.not_account_owner')
    expect((await w.call('DELETE', `/v1/linkedin/accounts/${account.id}`, w.admin)).status).toBe(
      204
    )
  })

  test('only a Rep may start a connection', async () => {
    const w = await world()
    for (const who of [w.admin, w.owner, w.manager]) {
      const reply = await w.call('POST', '/v1/linkedin/accounts/connection', who)
      expect(reply.status).toBe(403)
      expect(codeOf(reply.body)).toBe('auth.forbidden')
    }
  })

  test('the channel must be on and the wording accepted', async () => {
    const w = await world()
    w.t.deps.linkedinStore.setChannel(w.org, { enabled: false, acceptedVersions: [] })
    const off = await w.call('POST', '/v1/linkedin/accounts/connection', w.rep)
    expect(off.status).toBe(409)
    expect(codeOf(off.body)).toBe('linkedin.channel_disabled')
    w.t.deps.linkedinStore.setChannel(w.org, { enabled: true, acceptedVersions: ['older'] })
    const stale = await w.call('POST', '/v1/linkedin/accounts/connection', w.rep)
    expect(codeOf(stale.body)).toBe('linkedin.risk_not_accepted')
  })

  test('the same idempotency key answers the same login', async () => {
    const w = await world()
    const k1 = crypto.randomUUID()
    const a = await w.call('POST', '/v1/linkedin/accounts/connection', w.rep, k1)
    const b = await w.call('POST', '/v1/linkedin/accounts/connection', w.rep, k1)
    const c = await w.call('POST', '/v1/linkedin/accounts/connection', w.rep, crypto.randomUUID())
    expect(b.body.hostedLoginUrl).toBe(a.body.hostedLoginUrl as string)
    expect(c.body.hostedLoginUrl).not.toBe(a.body.hostedLoginUrl as string)
  })

  test('a provider outage is server.unavailable', async () => {
    const w = await world()
    w.t.deps.linkedinProvider.setDown(true)
    const reply = await w.call('POST', '/v1/linkedin/accounts/connection', w.rep)
    expect(reply.status).toBe(503)
    expect(codeOf(reply.body)).toBe('server.unavailable')
  })

  test('another Organization cannot read or act on the account', async () => {
    const w = await world()
    const { account } = await w.connect(w.rep)
    for (const method of ['GET', 'DELETE']) {
      const reply = await w.call(method, `/v1/linkedin/accounts/${account.id}`, w.outsider)
      expect(reply.status).toBe(404)
      expect(codeOf(reply.body)).toBe('request.not_found')
    }
    expect((await w.call('GET', '/v1/linkedin/accounts', w.outsider)).body.items).toEqual([])
    expect((await w.call('GET', `/v1/linkedin/accounts/${account.id}`, w.rep)).body.status).toBe(
      'connected'
    )
  })

  test('lists follow the caller view and page by cursor', async () => {
    const w = await world()
    const mine = await w.connect(w.rep)
    const theirs = await w.connect(w.otherRep)
    const repView = await w.call('GET', '/v1/linkedin/accounts', w.rep)
    expect((repView.body.items as { id: string }[]).map((i) => i.id)).toEqual([mine.account.id])
    const hidden = await w.call('GET', `/v1/linkedin/accounts/${theirs.account.id}`, w.rep)
    expect(hidden.status).toBe(404)
    const managerView = await w.call('GET', '/v1/linkedin/accounts', w.manager)
    expect((managerView.body.items as { id: string }[]).map((i) => i.id)).toEqual([mine.account.id])
    const first = await w.call('GET', '/v1/linkedin/accounts?limit=1', w.admin)
    expect((first.body.items as unknown[]).length).toBe(1)
    expect(typeof first.body.nextCursor).toBe('string')
    const second = await w.call(
      'GET',
      `/v1/linkedin/accounts?limit=1&cursor=${first.body.nextCursor}`,
      w.admin
    )
    expect((second.body.items as unknown[]).length).toBe(1)
    expect(second.body.nextCursor).toBeNull()
    const bad = await w.call('GET', '/v1/linkedin/accounts?cursor=nonsense', w.admin)
    expect(bad.status).toBe(400)
  })

  test('a reconnect reuses the account', async () => {
    const w = await world()
    const first = await w.connect(w.rep)
    await w.call('DELETE', `/v1/linkedin/accounts/${first.account.id}`, w.rep)
    const again = await w.connect(w.rep)
    expect(again.account.id).toBe(first.account.id)
    expect(again.account.status).toBe('connected')
  })

  test('logs carry no provider reference', async () => {
    const w = await world()
    const { ref, account } = await w.connect(w.rep)
    w.t.deps.linkedinProvider.setDown(true)
    await w.call('DELETE', `/v1/linkedin/accounts/${account.id}`, w.rep)
    expect(w.t.deps.logLines.join('\n')).not.toContain(ref)
  })
})
