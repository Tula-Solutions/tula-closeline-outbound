import { describe, expect, test } from 'bun:test'
import { membershipOf } from '~/adapters/memory/core'
import { MailTransportError } from '~/ports/mail-transport'
import {
  createTestApp,
  newOrganizationId,
  newUserId,
  type TestApp,
  type TestIdentity,
} from '~/testing'

type Reply = { status: number; body: Record<string, unknown> }

function codeOf(body: Record<string, unknown>): unknown {
  return (body.error as { code?: unknown } | undefined)?.code
}

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
  t.deps.core.setTeam(org, manager.userId, [rep.userId])
  let counter = 0
  const call = async (
    method: string,
    path: string,
    as: TestIdentity,
    body?: unknown,
    key?: string
  ): Promise<Reply> => {
    counter += 1
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(as)),
        'content-type': 'application/json',
        'idempotency-key': key ?? `key-${counter}-${crypto.randomUUID()}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  /** Starts a connection and plays the person consenting; returns the body `complete` takes. */
  const start = async (as: TestIdentity, body: Record<string, unknown> = { provider: 'gmail' }) => {
    const started = await call('POST', '/v1/mailboxes/connect', as, body)
    if (started.status !== 201) {
      return { started, completion: null }
    }
    const url = new URL(started.body.authorizationUrl as string)
    return {
      started,
      completion: {
        state: url.searchParams.get('state') as string,
        code: url.searchParams.get('code') as string,
      },
    }
  }
  const connect = async (
    as: TestIdentity,
    body: Record<string, unknown> = { provider: 'gmail' }
  ) => {
    const { completion } = await start(as, body)
    if (completion === null) {
      throw new Error('the connection did not start')
    }
    const done = await call('POST', '/v1/mailboxes/connect/complete', as, completion)
    expect(done.status).toBe(201)
    return done.body
  }
  return { t, org, owner, admin, manager, rep, otherRep, who, call, start, connect }
}

describe('connect and disconnect on the memory provider', () => {
  test('connects a personal Mailbox owned by the caller and disconnects it', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    expect(mailbox).toMatchObject({
      provider: 'gmail',
      kind: 'personal',
      state: 'warming',
      stateReason: null,
      ownerMembershipId: membershipOf(w.rep.userId),
    })
    const read = await w.call('GET', `/v1/mailboxes/${mailbox.id}`, w.rep)
    expect(read.status).toBe(200)
    const gone = await w.call('DELETE', `/v1/mailboxes/${mailbox.id}`, w.rep)
    expect(gone.status).toBe(200)
    expect(gone.body).toMatchObject({ state: 'disconnected', stateReason: 'disconnected_by_owner' })
    expect(w.t.deps.mail.revokedByUs()).toHaveLength(1)
    expect(w.t.deps.mailEvents).toHaveLength(1)
    expect(w.t.deps.mailEvents[0]?.event).toMatchObject({ from: 'warming', to: 'disconnected' })
    const again = await w.call('DELETE', `/v1/mailboxes/${mailbox.id}`, w.rep)
    expect(again.status).toBe(200)
    expect(w.t.deps.mailEvents).toHaveLength(1)
  })

  test('completing twice answers the same Mailbox with 200', async () => {
    const w = await world()
    const { completion } = await w.start(w.rep)
    const first = await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, completion)
    const second = await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, completion)
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.id).toBe(first.body.id)
  })

  test('a disconnected address connects again', async () => {
    const w = await world()
    const first = await w.connect(w.rep)
    await w.call('DELETE', `/v1/mailboxes/${first.id}`, w.rep)
    const again = await w.connect(w.rep)
    expect(again.state).toBe('warming')
  })

  test('a shared Mailbox is for an Owner or Admin only', async () => {
    const w = await world()
    const denied = await w.call('POST', '/v1/mailboxes/connect', w.rep, {
      provider: 'gmail',
      kind: 'shared',
    })
    expect(denied.status).toBe(403)
    const shared = await w.connect(w.admin, { provider: 'gmail', kind: 'shared' })
    expect(shared).toMatchObject({ kind: 'shared', ownerMembershipId: null })
  })

  test('a Rep cannot disconnect a Mailbox that is not theirs', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    expect((await w.call('DELETE', `/v1/mailboxes/${mailbox.id}`, w.otherRep)).status).toBe(404)
    // The Manager sees it but does not own it.
    const refused = await w.call('DELETE', `/v1/mailboxes/${mailbox.id}`, w.manager)
    expect(refused.status).toBe(403)
    expect((await w.call('DELETE', `/v1/mailboxes/${mailbox.id}`, w.admin)).status).toBe(200)
  })
})

describe('bad state and provider failures', () => {
  test('a forged, foreign or expired state is mailbox.oauth_state_invalid and stores nothing', async () => {
    const w = await world()
    const { completion } = await w.start(w.rep)
    const forged = await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, {
      ...completion,
      state: `${completion?.state}x`,
    })
    expect(codeOf(forged.body)).toBe('mailbox.oauth_state_invalid')
    const foreign = await w.call('POST', '/v1/mailboxes/connect/complete', w.otherRep, completion)
    expect(codeOf(foreign.body)).toBe('mailbox.oauth_state_invalid')
    await w.t.deps.time.advance(11 * 60 * 1000)
    const late = await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, completion)
    expect(codeOf(late.body)).toBe('mailbox.oauth_state_invalid')
    const list = await w.call('GET', '/v1/mailboxes', w.admin)
    expect(list.body.items).toEqual([])
  })

  test('a provider outage answers server.unavailable and stores nothing', async () => {
    const w = await world()
    const { completion } = await w.start(w.rep)
    w.t.deps.mail.failProvider(10)
    const down = await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, completion)
    expect(down.status).toBe(503)
    expect(codeOf(down.body)).toBe('server.unavailable')
    expect((await w.call('GET', '/v1/mailboxes', w.admin)).body.items).toEqual([])
  })

  test('connecting an address that is already connected is mailbox.already_connected', async () => {
    const w = await world()
    const first = await w.connect(w.rep)
    // The memory provider hands out a new account each time, so consent as the same person.
    const { completion } = await w.start(w.otherRep)
    const code = w.t.deps.mail.consent({
      address: first.address as string,
      displayName: 'Same person',
    })
    const clash = await w.call('POST', '/v1/mailboxes/connect/complete', w.otherRep, {
      ...completion,
      code,
    })
    expect(clash.status).toBe(409)
    expect(codeOf(clash.body)).toBe('mailbox.already_connected')
  })

  test('a revoked grant disconnects the Mailbox with auth_revoked and publishes the change', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    await w.t.deps.time.advance(2 * 60 * 60 * 1000)
    // Revoke at the provider whatever refresh token it holds.
    const Mailboxes = await import('./service')
    const tokens = await w.t.deps.mailboxes.store.readTokens(w.org, mailbox.id as never)
    expect(tokens).not.toBeNull()
    const refresh = await w.t.deps.mailboxes.secretBox.open(
      { keyId: tokens?.keyId as string, ciphertext: tokens?.refreshToken as Uint8Array },
      { organizationId: w.org, mailboxId: mailbox.id as never, purpose: 'refresh_token' }
    )
    w.t.deps.mail.revokeGrant(refresh)
    await expect(
      Mailboxes.accessTokenFor(w.t.deps.mailboxes, w.org, mailbox.id as never)
    ).rejects.toMatchObject({ code: 'mailbox.auth_revoked' })
    const read = await w.call('GET', `/v1/mailboxes/${mailbox.id}`, w.rep)
    expect(read.body).toMatchObject({ state: 'disconnected', stateReason: 'auth_revoked' })
    expect(w.t.deps.mailEvents.at(-1)?.event).toMatchObject({
      to: 'disconnected',
      reason: 'auth_revoked',
    })
  })

  test('an unconfigured secret box answers server.unavailable on start', async () => {
    const w = await world()
    w.t.deps.mailboxes.secretBox = { ...w.t.deps.mailboxes.secretBox, configured: false }
    const started = await w.call('POST', '/v1/mailboxes/connect', w.rep, { provider: 'gmail' })
    expect(started.status).toBe(503)
  })
})

describe('visibility', () => {
  test('a Rep sees their own, a Manager their Team, an Admin everything, another Organization nothing', async () => {
    const w = await world()
    const mine = await w.connect(w.rep)
    const theirs = await w.connect(w.otherRep)
    const shared = await w.connect(w.admin, { provider: 'gmail', kind: 'shared' })
    const ids = async (as: TestIdentity) =>
      ((await w.call('GET', '/v1/mailboxes', as)).body.items as { id: string }[]).map((m) => m.id)
    expect(await ids(w.rep)).toEqual([mine.id as string])
    expect(await ids(w.manager)).toEqual([mine.id as string])
    expect((await ids(w.admin)).sort()).toEqual([mine.id, theirs.id, shared.id].sort() as string[])
    const stranger = w.who('owner', newOrganizationId())
    expect(await ids(stranger)).toEqual([])
    expect((await w.call('GET', `/v1/mailboxes/${mine.id}`, stranger)).status).toBe(404)
    expect((await w.call('GET', `/v1/mailboxes/${theirs.id}`, w.rep)).status).toBe(404)
    expect((await w.call('DELETE', `/v1/mailboxes/${mine.id}`, stranger)).status).toBe(404)
  })

  test('a list pages by cursor', async () => {
    const w = await world()
    await w.connect(w.rep)
    await w.connect(w.rep)
    await w.connect(w.rep)
    const first = await w.call('GET', '/v1/mailboxes?limit=2', w.admin)
    expect((first.body.items as unknown[]).length).toBe(2)
    const next = await w.call(
      'GET',
      `/v1/mailboxes?limit=2&cursor=${first.body.nextCursor}`,
      w.admin
    )
    expect((next.body.items as unknown[]).length).toBe(1)
    expect(next.body.nextCursor).toBeNull()
    expect((await w.call('GET', '/v1/mailboxes?cursor=nonsense', w.admin)).status).toBe(400)
  })
})

describe('tokens never leave', () => {
  test('no response, log line or error report holds a token', async () => {
    const w = await world()
    const { started, completion } = await w.start(w.rep)
    const replies: Reply[] = [started]
    const done = await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, completion)
    replies.push(done)
    replies.push(await w.call('GET', '/v1/mailboxes', w.rep))
    replies.push(await w.call('GET', `/v1/mailboxes/${done.body.id}`, w.rep))
    // Make the provider fail once so the error paths are covered too.
    w.t.deps.mail.failProvider(1)
    replies.push(
      await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, { state: 'x', code: 'y' })
    )
    const tokens = await w.t.deps.mailboxes.store.readTokens(w.org, done.body.id as never)
    expect(tokens).not.toBeNull()
    replies.push(await w.call('DELETE', `/v1/mailboxes/${done.body.id}`, w.rep))
    const seen =
      JSON.stringify(replies) + w.t.deps.logLines.join('\n') + JSON.stringify(w.t.deps.reported)
    expect(seen).not.toMatch(/memory-access-/)
    expect(seen).not.toMatch(/memory-refresh-/)
    // The memory provider puts its code in the consent URL, as a real one does in its redirect;
    // the service itself must never write it down.
    expect(w.t.deps.logLines.join('\n') + JSON.stringify(w.t.deps.reported)).not.toContain(
      completion?.code as string
    )
    for (const reply of replies) {
      expect(Object.keys(reply.body)).not.toContain('accessToken')
      expect(Object.keys(reply.body)).not.toContain('refreshToken')
    }
  })

  test('tokens at rest are sealed, not plain', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const tokens = await w.t.deps.mailboxes.store.readTokens(w.org, mailbox.id as never)
    expect(new TextDecoder().decode(tokens?.accessToken)).not.toContain('memory-access-')
    expect(new TextDecoder().decode(tokens?.refreshToken)).not.toContain('memory-refresh-')
  })
})

describe('sending through a Mailbox', () => {
  test('sends through the provider and a revoked grant is surfaced as mailbox.auth_revoked', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const Mailboxes = await import('./service')
    const sent = await Mailboxes.sendThrough(
      w.t.deps.mailboxes,
      w.org,
      mailbox.id as never,
      {
        to: 'buyer@example.com',
        from: { address: mailbox.address as string, name: 'Rep' },
        subject: 'Hello',
        text: 'Hi there',
        messageId: '<m1@example.com>',
      } as never
    )
    expect(sent.providerMessageId).toBeTruthy()
    expect(w.t.deps.mail.accepted()).toHaveLength(1)
    expect(MailTransportError).toBeDefined()
  })
})

describe('Outlook through the same module', () => {
  test('connects, sends through the Outlook transport, and disconnects', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep, { provider: 'outlook' })
    expect(mailbox).toMatchObject({ provider: 'outlook', state: 'warming' })
    const Mailboxes = await import('./service')
    const sent = await Mailboxes.sendThrough(
      w.t.deps.mailboxes,
      w.org,
      mailbox.id as never,
      {
        to: 'buyer@example.com',
        from: { address: mailbox.address as string, name: 'Rep' },
        subject: 'Hello',
        text: 'Hi there',
        messageId: '<m2@example.com>',
      } as never
    )
    expect(sent.providerMessageId).toBeTruthy()
    expect(w.t.deps.outlookMail.accepted()).toHaveLength(1)
    expect(w.t.deps.mail.accepted()).toHaveLength(0)
    const gone = await w.call('DELETE', `/v1/mailboxes/${mailbox.id}`, w.rep)
    expect(gone.body).toMatchObject({ state: 'disconnected' })
    expect(w.t.deps.outlookMail.revokedByUs()).toHaveLength(1)
  })

  test('a rotated refresh token is stored, so the next refresh still works', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep, { provider: 'outlook' })
    w.t.deps.outlookMail.rotateRefreshTokens(true)
    const Mailboxes = await import('./service')
    for (let round = 0; round < 3; round += 1) {
      await w.t.deps.time.advance(2 * 60 * 60 * 1000)
      await Mailboxes.accessTokenFor(w.t.deps.mailboxes, w.org, mailbox.id as never)
    }
    const read = await w.call('GET', `/v1/mailboxes/${mailbox.id}`, w.rep)
    expect(read.body).toMatchObject({ state: 'warming' })
  })

  test('a revoked Outlook grant disconnects the Mailbox with auth_revoked', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep, { provider: 'outlook' })
    await w.t.deps.time.advance(2 * 60 * 60 * 1000)
    const Mailboxes = await import('./service')
    const tokens = await w.t.deps.mailboxes.store.readTokens(w.org, mailbox.id as never)
    const refresh = await w.t.deps.mailboxes.secretBox.open(
      { keyId: tokens?.keyId as string, ciphertext: tokens?.refreshToken as Uint8Array },
      { organizationId: w.org, mailboxId: mailbox.id as never, purpose: 'refresh_token' }
    )
    w.t.deps.outlookMail.revokeGrant(refresh)
    await expect(
      Mailboxes.accessTokenFor(w.t.deps.mailboxes, w.org, mailbox.id as never)
    ).rejects.toMatchObject({ code: 'mailbox.auth_revoked' })
    const read = await w.call('GET', `/v1/mailboxes/${mailbox.id}`, w.rep)
    expect(read.body).toMatchObject({ state: 'disconnected', stateReason: 'auth_revoked' })
  })
})

describe('a connect link is used once', () => {
  test('a link whose completion already ran is burned, even if that run failed', async () => {
    const w = await world()
    const { completion } = await w.start(w.rep)
    w.t.deps.mail.failProvider(1)
    const failed = await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, completion)
    expect(codeOf(failed.body)).toBe('server.unavailable')
    const retry = await w.call('POST', '/v1/mailboxes/connect/complete', w.rep, completion)
    expect(codeOf(retry.body)).toBe('mailbox.oauth_state_invalid')
  })

  test('a link that was never started here is refused', async () => {
    const w = await world()
    const { completion } = await w.start(w.rep)
    const fresh = await world()
    const done = await fresh.call('POST', '/v1/mailboxes/connect/complete', fresh.rep, completion)
    expect(codeOf(done.body)).toBe('mailbox.oauth_state_invalid')
  })
})

describe('test send', () => {
  const path = (id: unknown) => `/v1/mailboxes/${id}/test-send`

  test('sends the fixed text from the Mailbox and replays under the same key', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const first = await w.call(
      'POST',
      path(mailbox.id),
      w.rep,
      { to: 'me@example.com' },
      'test-send-key-0001'
    )
    expect(first.status).toBe(200)
    expect(first.body.providerMessageId).toBeTruthy()
    const accepted = w.t.deps.mail.accepted()
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({
      to: 'me@example.com',
      from: { address: mailbox.address },
    })
    const again = await w.call(
      'POST',
      path(mailbox.id),
      w.rep,
      { to: 'me@example.com' },
      'test-send-key-0001'
    )
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(w.t.deps.mail.accepted()).toHaveLength(1)
  })

  test('a custom subject is used', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    await w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com', subject: 'Hi' })
    expect(w.t.deps.mail.accepted()[0]?.subject).toBe('Hi')
  })

  test('another Organization and another Rep cannot use it', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const stranger = w.who('owner', newOrganizationId())
    const foreign = await w.call('POST', path(mailbox.id), stranger, { to: 'a@example.com' })
    expect(codeOf(foreign.body)).toBe('mailbox.not_found')
    const peer = await w.call('POST', path(mailbox.id), w.otherRep, { to: 'a@example.com' })
    expect(codeOf(peer.body)).toBe('mailbox.not_found')
    const manager = await w.call('POST', path(mailbox.id), w.manager, { to: 'a@example.com' })
    expect(manager.status).toBe(403)
    expect(w.t.deps.mail.accepted()).toHaveLength(0)
    const admin = await w.call('POST', path(mailbox.id), w.admin, { to: 'a@example.com' })
    expect(admin.status).toBe(200)
  })

  test('two requests with the same new key send once', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const key = 'test-send-key-race1'
    const [a, b] = await Promise.all([
      w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com' }, key),
      w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com' }, key),
    ])
    expect(w.t.deps.mail.accepted()).toHaveLength(1)
    // The second is either a replay (200) or told the first is still running (409).
    for (const r of [a, b]) {
      expect(r.status === 200 || codeOf(r.body) === 'request.idempotency_in_progress').toBe(true)
    }
    const after = await w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com' }, key)
    expect(after.status).toBe(200)
    expect(w.t.deps.mail.accepted()).toHaveLength(1)
  })

  test('a reused key with another recipient or subject is request.idempotency_key_reused', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const key = 'test-send-key-reuse'
    await w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com' }, key)
    const other = await w.call('POST', path(mailbox.id), w.rep, { to: 'you@example.com' }, key)
    expect(codeOf(other.body)).toBe('request.idempotency_key_reused')
    const subject = await w.call(
      'POST',
      path(mailbox.id),
      w.rep,
      { to: 'me@example.com', subject: 'Hi' },
      key
    )
    expect(codeOf(subject.body)).toBe('request.idempotency_key_reused')
    expect(w.t.deps.mail.accepted()).toHaveLength(1)
  })

  test('a failed send releases the key so a retry can send', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const key = 'test-send-key-fail1'
    w.t.deps.mail.failProvider(1)
    const failed = await w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com' }, key)
    expect(failed.status).toBe(503)
    const retry = await w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com' }, key)
    expect(retry.status).toBe(200)
    expect(w.t.deps.mail.accepted()).toHaveLength(1)
  })

  test('a failure after the provider accepted the mail keeps the claim, so a retry does not resend', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const store = w.t.deps.mailboxes.store
    const finish = store.finishTestSend
    store.finishTestSend = async () => {
      throw new Error('store down')
    }
    const key = 'test-send-key-fin01'
    const failed = await w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com' }, key)
    expect(failed.status).toBe(500)
    store.finishTestSend = finish
    const retry = await w.call('POST', path(mailbox.id), w.rep, { to: 'me@example.com' }, key)
    expect(codeOf(retry.body)).toBe('request.idempotency_in_progress')
    expect(w.t.deps.mail.accepted()).toHaveLength(1)
  })

  test('a disconnected Mailbox is not connected, a revoked one is auth_revoked', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    await w.call('DELETE', `/v1/mailboxes/${mailbox.id}`, w.rep)
    const gone = await w.call('POST', path(mailbox.id), w.rep, { to: 'a@example.com' })
    expect(codeOf(gone.body)).toBe('mailbox.not_connected')
    const other = await w.connect(w.rep, { provider: 'gmail' })
    const Mailboxes = await import('./service')
    await w.t.deps.mailboxes.store.disconnect(
      w.org,
      other.id as never,
      'auth_revoked',
      new Date().toISOString()
    )
    void Mailboxes
    const revoked = await w.call('POST', path(other.id), w.rep, { to: 'a@example.com' })
    expect(codeOf(revoked.body)).toBe('mailbox.auth_revoked')
  })

  test('is rate limited per Mailbox, with Retry-After, and the window slides', async () => {
    const w = await world()
    const mailbox = await w.connect(w.rep)
    const { TEST_SENDS_PER_HOUR } = await import('./service')
    for (let i = 0; i < TEST_SENDS_PER_HOUR; i++) {
      const ok = await w.call('POST', path(mailbox.id), w.rep, { to: 'a@example.com' })
      expect(ok.status).toBe(200)
    }
    const over = await w.call('POST', path(mailbox.id), w.rep, { to: 'a@example.com' })
    expect(over.status).toBe(429)
    expect(codeOf(over.body)).toBe('rate.limited')
    await w.t.deps.time.advance(61 * 60 * 1000)
    const later = await w.call('POST', path(mailbox.id), w.rep, { to: 'a@example.com' })
    expect(later.status).toBe(200)
  })
})
