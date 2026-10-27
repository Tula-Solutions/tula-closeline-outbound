import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MailTransportError, type OutgoingMessage } from '~/ports/mail-transport'
import { describeMailTransport } from '~/ports/mail-transport.behaviour'
import { buildRfc822, createGmailMailTransport, type GmailFetch } from './mail-transport'

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
const json = (name: string, status = 200): Response =>
  new Response(fixture(name), { status, headers: { 'content-type': 'application/json' } })

const BASE = {
  clientId: 'client-id',
  clientSecret: 'client-secret-value',
  redirectUri: 'https://portal.test/mailboxes/callback',
  authUrl: 'https://accounts.test/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth.test/token',
  revokeUrl: 'https://oauth.test/revoke',
  apiBaseUrl: 'https://gmail.test',
  timeoutMs: 1000,
  maxTries: 3,
  retryBaseMs: 10,
}

/** A stateful Google built from the recorded fixtures. */
function fakeGoogle() {
  const accepted: OutgoingMessage[] = []
  const codes = new Map<string, { challenge: string; email: string; name: string }>()
  const refreshTokens = new Map<string, boolean>()
  const access = new Set<string>()
  let failures = 0
  const calls: string[] = []

  const fetch: GmailFetch = async (input, init) => {
    calls.push(new URL(input).pathname)
    if (failures > 0) {
      failures -= 1
      return json('unavailable.json', 503)
    }
    const url = new URL(input)
    if (url.pathname === '/token') {
      const form = new URLSearchParams(String(init.body))
      if (form.get('grant_type') === 'authorization_code') {
        const entry = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        if (
          entry === undefined ||
          createHash('sha256').update(verifier).digest('base64url') !== entry.challenge
        ) {
          return json('invalid-grant.json', 400)
        }
        const claims = Buffer.from(
          JSON.stringify({
            sub: 'sub-1',
            email: entry.email,
            email_verified: true,
            name: entry.name,
          })
        ).toString('base64url')
        const refresh = `1//refresh-${randomUUID()}`
        const accessToken = `ya29.access-${randomUUID()}`
        refreshTokens.set(refresh, true)
        access.add(accessToken)
        return Response.json({
          access_token: accessToken,
          refresh_token: refresh,
          expires_in: 3599,
          id_token: `h.${claims}.s`,
        })
      }
      const refresh = form.get('refresh_token') ?? ''
      if (refreshTokens.get(refresh) !== true) {
        return json('invalid-grant.json', 400)
      }
      const accessToken = `ya29.access-${randomUUID()}`
      access.add(accessToken)
      return Response.json({ access_token: accessToken, expires_in: 3599 })
    }
    if (url.pathname === '/revoke') {
      const token = new URLSearchParams(String(init.body)).get('token') ?? ''
      if (refreshTokens.get(token) === true) {
        refreshTokens.set(token, false)
        return new Response('{}', { status: 200 })
      }
      return json('invalid-grant.json', 400)
    }
    if (url.pathname === '/gmail/v1/users/me/messages/send') {
      const bearer = String((init.headers as Record<string, string>).authorization).replace(
        'Bearer ',
        ''
      )
      if (!access.has(bearer)) {
        return json('unauthenticated.json', 401)
      }
      const payload = JSON.parse(String(init.body)) as { raw: string }
      const text = Buffer.from(payload.raw, 'base64url').toString('utf8')
      accepted.push({
        from: { address: /^From: .*<(.+)>$/m.exec(text)?.[1] ?? '', name: 'Riley Rep' },
        to: /^To: (.+)$/m.exec(text)?.[1]?.trim() ?? '',
        subject: /^Subject: (.+)$/m.exec(text)?.[1]?.trim() ?? '',
        text: Buffer.from(text.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8'),
        headers: { 'List-Unsubscribe': /^List-Unsubscribe: (.+)$/m.exec(text)?.[1]?.trim() ?? '' },
      })
      return json('send.json')
    }
    return new Response('{}', { status: 404 })
  }
  return {
    fetch,
    calls,
    accepted,
    consent(account: { address: string; displayName: string }, challenge?: string) {
      const code = `4/code-${randomUUID()}`
      codes.set(code, {
        challenge: challenge ?? createHash('sha256').update('a'.repeat(64)).digest('base64url'),
        email: account.address,
        name: account.displayName,
      })
      return code
    },
    revokeGrant: (refresh: string) => refreshTokens.set(refresh, false),
    failProvider: (times: number) => {
      failures = times
    },
  }
}

const sleeps: number[] = []
const make = (google: ReturnType<typeof fakeGoogle>) =>
  createGmailMailTransport({
    ...BASE,
    fetch: google.fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
  })

describeMailTransport('gmail (recorded fixtures)', () => {
  const google = fakeGoogle()
  return {
    transport: make(google),
    consent: (account) => google.consent(account),
    revokeGrant: google.revokeGrant,
    failProvider: google.failProvider,
    accepted: () => google.accepted,
  }
})

describe('gmail adapter', () => {
  test('the authorization URL asks for offline access with PKCE and the send scope', () => {
    const url = new URL(
      make(fakeGoogle()).authorizationUrl({ state: 's'.repeat(20), codeChallenge: 'chal' })
    )
    expect(url.origin + url.pathname).toBe(BASE.authUrl)
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(BASE.redirectUri)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('gmail.send')
    expect(url.searchParams.get('client_secret')).toBeNull()
  })

  test('a 503 is retried with jittered backoff, then succeeds', async () => {
    sleeps.length = 0
    const google = fakeGoogle()
    const transport = make(google)
    const { tokens } = await transport.exchangeCode({
      code: google.consent({ address: 'a@b.test', displayName: 'A' }),
      codeVerifier: 'a'.repeat(64),
    })
    google.failProvider(2)
    await transport.refresh(tokens.refreshToken)
    expect(sleeps).toEqual([10, 20])
  })

  test('gives up after the bounded tries as unavailable', async () => {
    const google = fakeGoogle()
    google.failProvider(10)
    const before = google.calls.length
    const error = await make(google)
      .refresh('1//x')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailTransportError)
    expect((error as MailTransportError).failure).toBe('unavailable')
    expect(google.calls.length - before).toBe(3)
  })

  test('a timeout on send is never retried, so a message cannot go twice', async () => {
    let calls = 0
    const transport = createGmailMailTransport({
      ...BASE,
      fetch: async () => {
        calls += 1
        throw new DOMException('timed out', 'TimeoutError')
      },
      sleep: async () => {},
    })
    const error = await transport
      .send('ya29.x', {
        from: { address: 'a@b.test', name: 'A' },
        to: 'c@d.test',
        subject: 's',
        text: 't',
      })
      .catch((e: unknown) => e)
    expect((error as MailTransportError).failure).toBe('timeout')
    expect(calls).toBe(1)
  })

  test('a 429 on send is retried', async () => {
    let calls = 0
    const transport = createGmailMailTransport({
      ...BASE,
      fetch: async () => {
        calls += 1
        return calls === 1 ? json('rate-limited.json', 429) : json('send.json')
      },
      sleep: async () => {},
    })
    const sent = await transport.send('ya29.x', {
      from: { address: 'a@b.test', name: 'A' },
      to: 'c@d.test',
      subject: 's',
      text: 't',
    })
    expect(sent.providerMessageId).toBe('18f0c0ffee000001')
    expect(calls).toBe(2)
  })

  test('a code answered without a refresh token is an invalid grant', async () => {
    const transport = createGmailMailTransport({
      ...BASE,
      fetch: async () => Response.json({ access_token: 'ya29.x', expires_in: 10 }),
    })
    const error = await transport
      .exchangeCode({ code: 'c', codeVerifier: 'v' })
      .catch((e: unknown) => e)
    expect((error as MailTransportError).failure).toBe('grant_invalid')
  })

  test('the recorded token fixture maps to the account', async () => {
    const transport = createGmailMailTransport({ ...BASE, fetch: async () => json('token.json') })
    const { account } = await transport.exchangeCode({ code: 'c', codeVerifier: 'v' })
    expect(account).toEqual({
      address: 'rep@example.com',
      displayName: 'Riley Rep',
      providerAccountId: '1130000000000000001',
    })
  })

  test('the access token expires expires_in seconds after the injected clock', async () => {
    const transport = createGmailMailTransport({
      ...BASE,
      fetch: async () => json('token.json'),
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    })
    const { tokens } = await transport.exchangeCode({ code: 'c', codeVerifier: 'v' })
    expect(tokens.expiresAt).toBe(
      new Date(Date.parse('2030-01-01T00:00:00.000Z') + 3599_000).toISOString()
    )
  })

  test('errors never carry the client secret, a token or the provider body', async () => {
    const transport = createGmailMailTransport({
      ...BASE,
      fetch: async () => json('invalid-grant.json', 400),
    })
    const error = (await transport.refresh('1//secret-refresh').catch((e: unknown) => e)) as Error
    const text = `${error.message} ${JSON.stringify(error)} ${error.stack ?? ''}`
    for (const secret of ['1//secret-refresh', 'client-secret-value', 'expired or revoked']) {
      expect(text).not.toContain(secret)
    }
  })

  test('a header with a line break is refused, not sent', () => {
    const message: OutgoingMessage = {
      from: { address: 'a@b.test', name: 'A' },
      to: 'c@d.test',
      subject: 'hi\r\nBcc: evil@x.test',
      text: 't',
    }
    expect(() => buildRfc822(message)).toThrow(MailTransportError)
    expect(() => buildRfc822({ ...message, subject: 's', to: 'c@d.test\nBcc: x@y.test' })).toThrow()
    expect(() => buildRfc822({ ...message, subject: 's', headers: { Bcc: 'x@y.test' } })).toThrow()
  })

  test('a non-ASCII subject is encoded and the body is base64 UTF-8', () => {
    const raw = buildRfc822({
      from: { address: 'a@b.test', name: 'Zoë' },
      to: 'c@d.test',
      subject: 'Café',
      text: 'héllo',
    })
    expect(raw).toContain('Subject: =?UTF-8?B?')
    expect(raw).toContain('From: =?UTF-8?B?')
    expect(Buffer.from(raw.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8')).toBe('héllo')
  })
})

describe.skipIf(process.env.GMAIL_LIVE_REFRESH_TOKEN === undefined)('gmail live (opt in)', () => {
  test('a real refresh token still refreshes', async () => {
    const env = process.env
    const transport = createGmailMailTransport({
      ...BASE,
      clientId: env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      revokeUrl: 'https://oauth2.googleapis.com/revoke',
      apiBaseUrl: 'https://gmail.googleapis.com',
    })
    const refreshed = await transport.refresh(env.GMAIL_LIVE_REFRESH_TOKEN ?? '')
    expect(refreshed.accessToken.length).toBeGreaterThan(0)
  })
})
