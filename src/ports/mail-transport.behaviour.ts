import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { type MailTransport, MailTransportError, type OutgoingMessage } from './mail-transport'

/** What a transport test needs beyond the port: to play the person and the provider. */
export type MailTransportHarness = {
  transport: MailTransport
  /** The person consents as `account`; returns the code the provider sends back. */
  consent(account: { address: string; displayName: string }): string
  /** The provider revokes the grant behind this refresh token. */
  revokeGrant(refreshToken: string): void
  /** The next `times` calls to the provider fail on the provider's side (5xx). */
  failProvider(times: number): void
  /** Messages the provider accepted, oldest first. */
  accepted(): readonly OutgoingMessage[]
}

const VERIFIER = 'a'.repeat(64)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const ACCOUNT = { address: 'Rep@Example.com', displayName: 'Riley Rep' }
const MESSAGE: OutgoingMessage = {
  from: { address: 'rep@example.com', name: 'Riley Rep' },
  to: 'prospect@acme.test',
  subject: 'Quick question about onboarding',
  text: 'Hi Pat,\n\nWorth a chat?\n\nRiley',
  headers: { 'List-Unsubscribe': '<https://u.example.test/abc>' },
}

async function failureOf(call: Promise<unknown>): Promise<MailTransportError> {
  try {
    await call
  } catch (error) {
    if (error instanceof MailTransportError) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to fail')
}

/** The behaviour every {@link MailTransport} adapter must show. */
export function describeMailTransport(label: string, make: () => MailTransportHarness): void {
  describe(`MailTransport: ${label}`, () => {
    test('the authorization URL carries the state and the challenge', () => {
      const { transport } = make()
      const url = new URL(
        transport.authorizationUrl({ state: 'state-value', codeChallenge: CHALLENGE })
      )
      expect(url.searchParams.get('state')).toBe('state-value')
      expect(['http:', 'https:']).toContain(url.protocol)
    })

    test('a code gives tokens and names the account, lower-cased', async () => {
      const harness = make()
      const code = harness.consent(ACCOUNT)
      const { tokens, account } = await harness.transport.exchangeCode({
        code,
        codeVerifier: VERIFIER,
      })
      expect(tokens.accessToken.length).toBeGreaterThan(0)
      expect(tokens.refreshToken.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(tokens.expiresAt))).toBe(false)
      expect(account.address).toBe('rep@example.com')
      expect(account.displayName).toBe('Riley Rep')
      expect(account.providerAccountId.length).toBeGreaterThan(0)
    })

    test('a code works once', async () => {
      const harness = make()
      const code = harness.consent(ACCOUNT)
      await harness.transport.exchangeCode({ code, codeVerifier: VERIFIER })
      const failure = await failureOf(
        harness.transport.exchangeCode({ code, codeVerifier: VERIFIER })
      )
      expect(failure.failure).toBe('grant_invalid')
    })

    test('an unknown code is an invalid grant', async () => {
      const { transport } = make()
      const failure = await failureOf(
        transport.exchangeCode({ code: 'not-a-code', codeVerifier: VERIFIER })
      )
      expect(failure.failure).toBe('grant_invalid')
    })

    test('refresh gives a new access token', async () => {
      const harness = make()
      const { tokens } = await harness.transport.exchangeCode({
        code: harness.consent(ACCOUNT),
        codeVerifier: VERIFIER,
      })
      const refreshed = await harness.transport.refresh(tokens.refreshToken)
      expect(refreshed.accessToken.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(refreshed.expiresAt))).toBe(false)
    })

    test('refresh after the provider revoked the grant is an invalid grant', async () => {
      const harness = make()
      const { tokens } = await harness.transport.exchangeCode({
        code: harness.consent(ACCOUNT),
        codeVerifier: VERIFIER,
      })
      harness.revokeGrant(tokens.refreshToken)
      const failure = await failureOf(harness.transport.refresh(tokens.refreshToken))
      expect(failure.failure).toBe('grant_invalid')
    })

    test('revoke ends the grant, and revoking twice is fine', async () => {
      const harness = make()
      const { tokens } = await harness.transport.exchangeCode({
        code: harness.consent(ACCOUNT),
        codeVerifier: VERIFIER,
      })
      await harness.transport.revoke(tokens.refreshToken)
      await harness.transport.revoke(tokens.refreshToken)
      const failure = await failureOf(harness.transport.refresh(tokens.refreshToken))
      expect(failure.failure).toBe('grant_invalid')
    })

    test('send returns the provider ids and hands over the message', async () => {
      const harness = make()
      const { tokens } = await harness.transport.exchangeCode({
        code: harness.consent(ACCOUNT),
        codeVerifier: VERIFIER,
      })
      const sent = await harness.transport.send(tokens.accessToken, MESSAGE)
      expect(sent.providerMessageId.length).toBeGreaterThan(0)
      expect(sent.threadId.length).toBeGreaterThan(0)
      expect(harness.accepted().map((m) => [m.to, m.subject])).toEqual([
        [MESSAGE.to, MESSAGE.subject],
      ])
    })

    test('send with a token the provider does not accept says the token expired', async () => {
      const harness = make()
      const failure = await failureOf(harness.transport.send('stale-access-token', MESSAGE))
      expect(failure.failure).toBe('token_expired')
      expect(harness.accepted()).toEqual([])
    })

    test('a provider outage is unavailable, and carries no token', async () => {
      const harness = make()
      const { tokens } = await harness.transport.exchangeCode({
        code: harness.consent(ACCOUNT),
        codeVerifier: VERIFIER,
      })
      harness.failProvider(50)
      const failure = await failureOf(harness.transport.refresh(tokens.refreshToken))
      expect(failure.failure).toBe('unavailable')
      expect(failure.message).not.toContain(tokens.refreshToken)
      expect(failure.message).not.toContain(tokens.accessToken)
    })
  })
}
