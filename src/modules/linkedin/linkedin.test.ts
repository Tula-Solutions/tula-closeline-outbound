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
import { assertChannelOpen, completeConnection, revokeRisk } from './service'

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
    key: string = crypto.randomUUID(),
    body?: unknown
  ): Promise<Reply> => {
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(as)),
        'idempotency-key': key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

describe('linkedin risk acceptance and the channel switch', () => {
  const accept = (w: Awaited<ReturnType<typeof world>>, as: TestIdentity, name = 'Ada Admin') =>
    w.call('POST', '/v1/linkedin/risk-acceptance', as, undefined, {
      wordingVersion: LINKEDIN_RISK_WORDING_VERSION,
      typedFullName: name,
    })
  const fresh = async () => {
    const w = await world()
    // The shared world starts open; these tests start from a closed channel.
    w.t.deps.linkedinStore.setChannel(w.org, { enabled: false, acceptedVersions: [] })
    return w
  }
  const patch = (w: Awaited<ReturnType<typeof world>>, as: TestIdentity, enabled: boolean) =>
    w.call('PATCH', '/v1/linkedin/settings', as, undefined, { enabled })

  test('every role reads the statement; only Owner and Admin accept', async () => {
    const w = await fresh()
    const read = await w.call('GET', '/v1/linkedin/risk-statement', w.rep)
    expect(read.body.version).toBe(LINKEDIN_RISK_WORDING_VERSION)
    expect(typeof read.body.text).toBe('string')
    for (const who of [w.rep, w.manager]) {
      expect((await accept(w, who)).status).toBe(403)
    }
    const done = await accept(w, w.admin)
    expect(done.status).toBe(201)
    expect(done.body.typedFullName).toBe('Ada Admin')
    expect(done.body.revokedAt).toBeNull()
    expect(typeof done.body.acceptedByMembershipId).toBe('string')
    expect((await accept(w, w.owner, 'Olive Owner')).status).toBe(201)
  })

  test('accepting needs the current wording and a real name', async () => {
    const w = await fresh()
    const old = await w.call('POST', '/v1/linkedin/risk-acceptance', w.admin, undefined, {
      wordingVersion: '2020-1-1',
      typedFullName: 'Ada Admin',
    })
    expect(old.status).toBe(400)
    expect((await accept(w, w.admin, 'A')).status).toBe(400)
  })

  test('accepting again returns the same acceptance', async () => {
    const w = await fresh()
    const first = await accept(w, w.admin)
    const second = await accept(w, w.admin)
    expect(second.body.id).toBe(first.body.id)
    const list = await w.call('GET', '/v1/linkedin/risk-acceptances', w.admin)
    expect((list.body.items as unknown[]).length).toBe(1)
  })

  test('the switch needs an acceptance, and the settings tell the truth', async () => {
    const w = await fresh()
    const refused = await patch(w, w.admin, true)
    expect(refused.status).toBe(409)
    expect(codeOf(refused.body)).toBe('linkedin.risk_not_accepted')
    expect((await patch(w, w.rep, false)).status).toBe(403)
    await accept(w, w.admin)
    const on = await patch(w, w.admin, true)
    expect(on.status).toBe(200)
    expect(on.body).toMatchObject({
      enabled: true,
      effectivelyEnabled: true,
      currentWordingVersion: LINKEDIN_RISK_WORDING_VERSION,
    })
    expect(typeof on.body.acceptedAt).toBe('string')
    expect((await w.call('GET', '/v1/linkedin/settings', w.rep)).body.effectivelyEnabled).toBe(true)
  })

  test('an acceptance of an older wording does not open the channel', async () => {
    const w = await fresh()
    w.t.deps.linkedinStore.setChannel(w.org, { enabled: true, acceptedVersions: ['older'] })
    const settings = await w.call('GET', '/v1/linkedin/settings', w.admin)
    expect(settings.body).toMatchObject({
      enabled: true,
      acceptedAt: null,
      effectivelyEnabled: false,
    })
    await expect(assertChannelOpen(w.t.deps.linkedin, w.org)).rejects.toMatchObject({
      code: 'linkedin.risk_not_accepted',
    })
  })

  test('revoking stops LinkedIn at the next check, publishes once, and leaves the rest alone', async () => {
    const w = await fresh()
    await accept(w, w.admin)
    await patch(w, w.admin, true)
    await expect(assertChannelOpen(w.t.deps.linkedin, w.org)).resolves.toBeUndefined()
    expect((await w.call('DELETE', '/v1/linkedin/risk-acceptance', w.rep)).status).toBe(403)
    expect((await w.call('DELETE', '/v1/linkedin/risk-acceptance', w.admin)).status).toBe(204)
    await expect(assertChannelOpen(w.t.deps.linkedin, w.org)).rejects.toMatchObject({
      code: 'linkedin.risk_not_accepted',
    })
    const start = await w.call('POST', '/v1/linkedin/accounts/connection', w.rep)
    expect(codeOf(start.body)).toBe('linkedin.risk_not_accepted')
    // Revoking again is a no-op and publishes nothing more.
    expect((await w.call('DELETE', '/v1/linkedin/risk-acceptance', w.admin)).status).toBe(204)
    expect(w.t.deps.linkedinEvents.map((e) => e.event.reason)).toEqual(['acceptance_revoked'])
    expect(w.t.deps.linkedinEvents[0]?.organizationId).toBe(w.org)
    // The history keeps the revoked row.
    const list = await w.call('GET', '/v1/linkedin/risk-acceptances', w.owner)
    expect((list.body.items as { revokedAt: string | null }[])[0]?.revokedAt).not.toBeNull()
    // Email is another channel and never asks the LinkedIn check: its routes still answer.
    expect((await w.call('GET', '/v1/mailboxes', w.admin)).status).toBe(200)
  })

  test('switching off stops LinkedIn, publishes once, and a repeat does not publish', async () => {
    const w = await fresh()
    await accept(w, w.admin)
    await patch(w, w.admin, true)
    const off = await patch(w, w.admin, false)
    expect(off.body.effectivelyEnabled).toBe(false)
    await patch(w, w.admin, false)
    await expect(assertChannelOpen(w.t.deps.linkedin, w.org)).rejects.toMatchObject({
      code: 'linkedin.channel_disabled',
    })
    expect(w.t.deps.linkedinEvents.map((e) => e.event.reason)).toEqual(['admin_switch'])
  })

  test('the history is paged, shows who and when, and only Owner and Admin read it', async () => {
    const w = await fresh()
    await accept(w, w.admin)
    await w.call('DELETE', '/v1/linkedin/risk-acceptance', w.admin)
    w.t.deps.clock.advance('1s')
    await accept(w, w.owner, 'Olive Owner')
    expect((await w.call('GET', '/v1/linkedin/risk-acceptances', w.manager)).status).toBe(403)
    const first = await w.call('GET', '/v1/linkedin/risk-acceptances?limit=1', w.admin)
    expect((first.body.items as { typedFullName: string }[])[0]?.typedFullName).toBe('Olive Owner')
    const second = await w.call(
      'GET',
      `/v1/linkedin/risk-acceptances?limit=1&cursor=${first.body.nextCursor}`,
      w.admin
    )
    expect((second.body.items as { typedFullName: string }[])[0]?.typedFullName).toBe('Ada Admin')
    expect(second.body.nextCursor).toBeNull()
    const bad = await w.call('GET', '/v1/linkedin/risk-acceptances?cursor=nonsense', w.admin)
    expect(bad.status).toBe(400)
  })

  test('a second Organization cannot see or use the acceptance', async () => {
    const w = await fresh()
    await accept(w, w.admin)
    await patch(w, w.admin, true)
    const other = newOrganizationId()
    const theirAdmin: TestIdentity = { userId: newUserId(), organizationId: other, role: 'admin' }
    const theirs = await w.call('GET', '/v1/linkedin/settings', theirAdmin)
    expect(theirs.body).toMatchObject({
      enabled: false,
      acceptedAt: null,
      effectivelyEnabled: false,
    })
    const theirList = await w.call('GET', '/v1/linkedin/risk-acceptances', theirAdmin)
    expect(theirList.body.items).toEqual([])
    await expect(assertChannelOpen(w.t.deps.linkedin, other)).rejects.toBeDefined()
    // Revoking in the other Organization leaves the first one open.
    await w.call('DELETE', '/v1/linkedin/risk-acceptance', theirAdmin)
    await expect(assertChannelOpen(w.t.deps.linkedin, w.org)).resolves.toBeUndefined()
  })

  test('a failed membership lookup revokes nothing, so a retry still publishes the event', async () => {
    const w = await fresh()
    await accept(w, w.admin)
    await patch(w, w.admin, true)
    const real = w.t.deps.linkedin
    let failures = 1
    const flaky = {
      ...real,
      access: {
        ...real.access,
        membershipIdOf: (...args: Parameters<typeof real.access.membershipIdOf>) => {
          if (failures-- > 0) {
            return Promise.reject(new Error('core unavailable'))
          }
          return real.access.membershipIdOf(...args)
        },
      },
    }
    const caller = { organizationId: w.org, userId: w.admin.userId, role: 'admin' as const }
    await expect(revokeRisk(flaky, caller)).rejects.toThrow('core unavailable')
    await expect(assertChannelOpen(real, w.org)).resolves.toBeUndefined()
    await revokeRisk(flaky, caller)
    expect(w.t.deps.linkedinEvents.map((e) => e.event.reason)).toEqual(['acceptance_revoked'])
  })
})

describe('linkedin account limits', () => {
  const lower = { dailyConnections: 5, dailyMessages: 10, weeklyConnections: 20 }
  const patch = (
    w: Awaited<ReturnType<typeof world>>,
    id: string,
    as: TestIdentity,
    body: unknown = lower
  ) => w.call('PATCH', `/v1/linkedin/accounts/${id}/limits`, as, undefined, body)

  test('an Admin lowers the limits of an account', async () => {
    const w = await world()
    const { account } = await w.connect(w.rep)
    const reply = await patch(w, account.id, w.admin)
    expect(reply.status).toBe(200)
    expect(reply.body.limits).toEqual(lower)
    expect((await w.call('GET', `/v1/linkedin/accounts/${account.id}`, w.rep)).body.limits).toEqual(
      lower
    )
  })

  test('a limit above the ceiling is refused', async () => {
    const w = await world()
    const { account } = await w.connect(w.rep)
    const reply = await patch(w, account.id, w.admin, { ...lower, dailyConnections: 21 })
    expect(reply.status).toBe(422)
    expect(codeOf(reply.body)).toBe('linkedin.limit_above_ceiling')
    expect(
      (await w.call('GET', `/v1/linkedin/accounts/${account.id}`, w.rep)).body.limits
    ).not.toEqual(lower)
  })

  test('a Rep may not change limits, and another Organization cannot see the account', async () => {
    const w = await world()
    const { account } = await w.connect(w.rep)
    expect((await patch(w, account.id, w.rep)).status).toBe(403)
    const foreign = { ...w.admin, organizationId: w.outsider.organizationId }
    expect((await patch(w, account.id, foreign)).status).toBe(404)
  })
})
