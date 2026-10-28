import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import type { MailTransportError, OutgoingMessage } from '~/ports/mail-transport'
import { describeMailTransport } from '~/ports/mail-transport.behaviour'
import { createGraphMailTransport, type GraphFetch } from './mail-transport'

const BASE = {
  clientId: 'client-id',
  clientSecret: 'client-secret-value',
  redirectUri: 'https://portal.test/mailboxes/callback',
  authUrl: 'https://login.test/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.test/common/oauth2/v2.0/token',
  apiBaseUrl: 'https://graph.test',
  timeoutMs: 1000,
  maxTries: 3,
  retryBaseMs: 10,
}
const MESSAGE: OutgoingMessage = {
  from: { address: 'a@b.test', name: 'A' },
  to: 'c@d.test',
  subject: 's',
  text: 't',
}
const invalidGrant = () =>
  Response.json(
    { error: 'invalid_grant', error_description: 'AADSTS70000 the refresh token was revoked' },
    { status: 400 }
  )
const unavailable = () =>
  Response.json({ error: { code: 'serviceNotAvailable', message: 'down' } }, { status: 503 })

/** A stateful Microsoft built from the documented response shapes. */
function fakeMicrosoft() {
  const accepted: OutgoingMessage[] = []
  const codes = new Map<string, { challenge: string; email: string; name: string }>()
  const refreshTokens = new Map<string, boolean>()
  const access = new Map<string, { email: string; name: string }>()
  const drafts = new Map<string, OutgoingMessage>()
  let failures = 0
  let rotate = false
  const calls: string[] = []
  const identityOf = new Map<string, { email: string; name: string }>()

  const fetch: GraphFetch = async (input, init) => {
    const url = new URL(input)
    calls.push(`${init.method} ${url.pathname}`)
    if (failures > 0) {
      failures -= 1
      return unavailable()
    }
    if (url.pathname.endsWith('/token')) {
      const form = new URLSearchParams(String(init.body))
      if (form.get('grant_type') === 'authorization_code') {
        const entry = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        if (
          entry === undefined ||
          createHash('sha256').update(verifier).digest('base64url') !== entry.challenge
        ) {
          return invalidGrant()
        }
        const refresh = `0.AAA-refresh-${randomUUID()}`
        const accessToken = `eyJ0.access-${randomUUID()}`
        refreshTokens.set(refresh, true)
        access.set(accessToken, entry)
        identityOf.set(refresh, entry)
        return Response.json({
          token_type: 'Bearer',
          access_token: accessToken,
          refresh_token: refresh,
          expires_in: 3599,
        })
      }
      const refresh = form.get('refresh_token') ?? ''
      const who = identityOf.get(refresh)
      if (refreshTokens.get(refresh) !== true || who === undefined) {
        return invalidGrant()
      }
      const accessToken = `eyJ0.access-${randomUUID()}`
      access.set(accessToken, who)
      if (!rotate) {
        return Response.json({ access_token: accessToken, expires_in: 3599 })
      }
      const next = `0.AAA-rotated-${randomUUID()}`
      refreshTokens.set(refresh, false)
      refreshTokens.set(next, true)
      identityOf.set(next, who)
      return Response.json({ access_token: accessToken, refresh_token: next, expires_in: 3599 })
    }
    const headers = init.headers as Record<string, string>
    const who = access.get((headers.authorization ?? '').replace('Bearer ', ''))
    if (who === undefined) {
      return Response.json(
        { error: { code: 'InvalidAuthenticationToken', message: 'expired' } },
        { status: 401 }
      )
    }
    if (url.pathname === '/v1.0/me') {
      return Response.json({
        id: 'oid-1',
        displayName: who.name,
        mail: null,
        userPrincipalName: who.email.toUpperCase(),
      })
    }
    if (url.pathname === '/v1.0/me/messages' && init.method === 'POST') {
      const text = Buffer.from(String(init.body), 'base64').toString('utf8')
      const id = `AAMk-${randomUUID()}`
      drafts.set(id, {
        from: { address: /^From: .*<(.+)>$/m.exec(text)?.[1] ?? '', name: 'Riley Rep' },
        to: /^To: (.+)$/m.exec(text)?.[1]?.trim() ?? '',
        subject: /^Subject: (.+)$/m.exec(text)?.[1]?.trim() ?? '',
        text: Buffer.from(text.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8'),
        headers: { 'List-Unsubscribe': /^List-Unsubscribe: (.+)$/m.exec(text)?.[1]?.trim() ?? '' },
      })
      return Response.json({ id, conversationId: 'AAQk-conv-1' }, { status: 201 })
    }
    const sendOf = /^\/v1\.0\/me\/messages\/(.+)\/send$/.exec(url.pathname)
    if (sendOf?.[1] !== undefined) {
      const draft = drafts.get(decodeURIComponent(sendOf[1]))
      if (draft === undefined) {
        return new Response('{}', { status: 404 })
      }
      accepted.push(draft)
      return new Response(null, { status: 202 })
    }
    return new Response('{}', { status: 404 })
  }
  return {
    fetch,
    calls,
    accepted,
    consent(account: { address: string; displayName: string }) {
      const code = `M.C5-code-${randomUUID()}`
      codes.set(code, {
        challenge: createHash('sha256').update('a'.repeat(64)).digest('base64url'),
        email: account.address,
        name: account.displayName,
      })
      return code
    },
    revokeGrant: (refresh: string) => refreshTokens.set(refresh, false),
    failProvider: (times: number) => {
      failures = times
    },
    rotateOnRefresh: () => {
      rotate = true
    },
  }
}

const sleeps: number[] = []
const make = (ms: ReturnType<typeof fakeMicrosoft>) =>
  createGraphMailTransport({
    ...BASE,
    fetch: ms.fetch,
    sleep: async (n) => {
      sleeps.push(n)
    },
    random: () => 0.5,
  })

describeMailTransport('outlook (scripted Graph)', () => {
  const ms = fakeMicrosoft()
  return {
    transport: make(ms),
    consent: (account) => ms.consent(account),
    revokeGrant: ms.revokeGrant,
    failProvider: ms.failProvider,
    accepted: () => ms.accepted,
    revokeEndsGrant: false,
  }
})

describe('graph adapter', () => {
  test('the authorization URL asks for the Graph scopes with PKCE and no secret', () => {
    const url = new URL(
      make(fakeMicrosoft()).authorizationUrl({ state: 's'.repeat(20), codeChallenge: 'chal' })
    )
    expect(url.origin + url.pathname).toBe(BASE.authUrl)
    expect(url.searchParams.get('scope')).toContain('Mail.Send')
    expect(url.searchParams.get('scope')).toContain('offline_access')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_secret')).toBeNull()
  })

  test('the account is the Graph profile, with the UPN when there is no mail', async () => {
    const ms = fakeMicrosoft()
    const { account } = await make(ms).exchangeCode({
      code: ms.consent({ address: 'Rep@Contoso.test', displayName: 'Riley' }),
      codeVerifier: 'a'.repeat(64),
    })
    expect(account).toEqual({
      address: 'rep@contoso.test',
      displayName: 'Riley',
      providerAccountId: 'oid-1',
    })
  })

  test('a refresh that rotates the refresh token hands the new one back, and the old one dies', async () => {
    const ms = fakeMicrosoft()
    const transport = make(ms)
    const { tokens } = await transport.exchangeCode({
      code: ms.consent({ address: 'a@b.test', displayName: 'A' }),
      codeVerifier: 'a'.repeat(64),
    })
    expect((await transport.refresh(tokens.refreshToken)).refreshToken).toBeUndefined()
    ms.rotateOnRefresh()
    const rotated = await transport.refresh(tokens.refreshToken)
    expect(rotated.refreshToken).toMatch(/^0\.AAA-rotated-/)
    expect(await transport.refresh(rotated.refreshToken as string)).toHaveProperty('accessToken')
  })

  test('a 503 is retried with jittered backoff, then succeeds', async () => {
    sleeps.length = 0
    const ms = fakeMicrosoft()
    const transport = make(ms)
    const { tokens } = await transport.exchangeCode({
      code: ms.consent({ address: 'a@b.test', displayName: 'A' }),
      codeVerifier: 'a'.repeat(64),
    })
    ms.failProvider(2)
    await transport.refresh(tokens.refreshToken)
    expect(sleeps).toEqual([10, 20])
  })

  test('gives up after the bounded tries as unavailable', async () => {
    const ms = fakeMicrosoft()
    ms.failProvider(10)
    const error = await make(ms)
      .refresh('0.AAA-x')
      .catch((e: unknown) => e)
    expect((error as MailTransportError).failure).toBe('unavailable')
    expect(ms.calls.length).toBe(3)
  })

  test('a 4xx limits at once: no retry', async () => {
    let calls = 0
    const transport = createGraphMailTransport({
      ...BASE,
      fetch: async () => {
        calls += 1
        return Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: 403 })
      },
      sleep: async () => {},
    })
    const error = await transport.send('tok', MESSAGE).catch((e: unknown) => e)
    expect((error as MailTransportError).failure).toBe('rejected')
    expect(calls).toBe(1)
  })

  test('a timeout while sending is never retried, so a message cannot go twice', async () => {
    const seen: string[] = []
    const transport = createGraphMailTransport({
      ...BASE,
      fetch: async (input) => {
        seen.push(new URL(input).pathname)
        if (input.endsWith('/send')) {
          throw new DOMException('timed out', 'TimeoutError')
        }
        return Response.json({ id: 'D1', conversationId: 'C1' }, { status: 201 })
      },
      sleep: async () => {},
    })
    const error = await transport.send('tok', MESSAGE).catch((e: unknown) => e)
    expect((error as MailTransportError).failure).toBe('timeout')
    expect(seen).toEqual(['/v1.0/me/messages', '/v1.0/me/messages/D1/send'])
  })

  test('a 5xx other than 503 on the send step is not retried; a 429 is', async () => {
    for (const [status, expected] of [
      [500, 1],
      [429, 2],
    ] as const) {
      let sends = 0
      const transport = createGraphMailTransport({
        ...BASE,
        fetch: async (input) => {
          if (!input.endsWith('/send')) {
            return Response.json({ id: 'D1', conversationId: 'C1' }, { status: 201 })
          }
          sends += 1
          return sends === 1 ? new Response('{}', { status }) : new Response(null, { status: 202 })
        },
        sleep: async () => {},
      })
      await transport.send('tok', MESSAGE).catch(() => {})
      expect(sends).toBe(expected)
    }
  })

  test('a 404 on the send step after a 429 may mean the first try went through: unknown outcome', async () => {
    let sends = 0
    const transport = createGraphMailTransport({
      ...BASE,
      fetch: async (input) => {
        if (!input.endsWith('/send')) {
          return Response.json({ id: 'D1', conversationId: 'C1' }, { status: 201 })
        }
        sends += 1
        return new Response('{}', { status: sends === 1 ? 429 : 404 })
      },
      sleep: async () => {},
    })
    const error = await transport.send('tok', MESSAGE).catch((e: unknown) => e)
    expect((error as MailTransportError).failure).toBe('timeout')
    expect(sends).toBe(2)
  })

  test('a definite refusal on the send step deletes the draft; an unknown outcome keeps it', async () => {
    const run = async (sendStatus: number | 'timeout') => {
      const deleted: string[] = []
      const transport = createGraphMailTransport({
        ...BASE,
        fetch: async (input, init) => {
          if (init.method === 'DELETE') {
            deleted.push(new URL(input).pathname)
            return new Response('boom', { status: 500 })
          }
          if (!input.endsWith('/send')) {
            return Response.json({ id: 'D1', conversationId: 'C1' }, { status: 201 })
          }
          if (sendStatus === 'timeout') {
            throw new DOMException('timed out', 'TimeoutError')
          }
          return new Response('{}', { status: sendStatus })
        },
        sleep: async () => {},
      })
      const error = await transport.send('tok', MESSAGE).catch((e: unknown) => e)
      return { deleted, failure: (error as MailTransportError).failure }
    }
    expect(await run(400)).toEqual({ deleted: ['/v1.0/me/messages/D1'], failure: 'rejected' })
    expect(await run(401)).toEqual({ deleted: ['/v1.0/me/messages/D1'], failure: 'token_expired' })
    expect((await run('timeout')).deleted).toEqual([])
    expect((await run(500)).deleted).toEqual([])
  })

  test('creating the draft is retried on a 5xx', async () => {
    let creates = 0
    const transport = createGraphMailTransport({
      ...BASE,
      fetch: async (input) => {
        if (input.endsWith('/send')) {
          return new Response(null, { status: 202 })
        }
        creates += 1
        return creates === 1
          ? unavailable()
          : Response.json({ id: 'D1', conversationId: 'C1' }, { status: 201 })
      },
      sleep: async () => {},
    })
    expect(await transport.send('tok', MESSAGE)).toEqual({
      providerMessageId: 'D1',
      threadId: 'C1',
    })
    expect(creates).toBe(2)
  })

  test('a line break in a field is refused before any call', async () => {
    let calls = 0
    const transport = createGraphMailTransport({
      ...BASE,
      fetch: async () => {
        calls += 1
        return new Response('{}')
      },
    })
    const error = await transport
      .send('tok', { ...MESSAGE, subject: 'hi\r\nBcc: evil@x.test' })
      .catch((e: unknown) => e)
    expect((error as MailTransportError).failure).toBe('rejected')
    expect(calls).toBe(0)
  })

  test('a revoked or consent-required refresh is an invalid grant, other 400s are rejected', async () => {
    const answer = (error: string) =>
      createGraphMailTransport({
        ...BASE,
        fetch: async () => Response.json({ error }, { status: 400 }),
      })
    for (const error of ['invalid_grant', 'interaction_required']) {
      const failure = await answer(error)
        .refresh('r')
        .catch((e: unknown) => e)
      expect((failure as MailTransportError).failure).toBe('grant_invalid')
    }
    const other = await answer('invalid_client')
      .refresh('r')
      .catch((e: unknown) => e)
    expect((other as MailTransportError).failure).toBe('rejected')
  })

  test('errors never carry the secret, a token or the provider body', async () => {
    const transport = createGraphMailTransport({ ...BASE, fetch: async () => invalidGrant() })
    const error = (await transport
      .refresh('0.AAA-secret-refresh')
      .catch((e: unknown) => e)) as Error
    const text = `${error.message} ${JSON.stringify(error)} ${error.stack ?? ''}`
    for (const secret of ['0.AAA-secret-refresh', 'client-secret-value', 'AADSTS70000']) {
      expect(text).not.toContain(secret)
    }
  })
})
