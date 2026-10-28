import { createHash, randomUUID } from 'node:crypto'
import type { MailboxProvider } from 'tula-closeline-contract'
import type { Clock } from 'tula-closeline-kit'
import {
  type ConnectedAccount,
  type InboundNotice,
  type MailTransport,
  MailTransportError,
  type OutgoingMessage,
  type SentMessage,
} from '~/ports/mail-transport'

/** How long a memory access token lives, in ms. */
const ACCESS_TOKEN_MS = 3_600_000

/** A memory provider plus the controls a test uses to play the person and the provider. */
export type MemoryMailTransport = MailTransport & {
  /** The person consents as `account`; returns the code the provider would send back. */
  consent(account: { address: string; displayName: string }): string
  /** The provider revokes the grant behind this refresh token. */
  revokeGrant(refreshToken: string): void
  /** While on, each refresh hands out a new refresh token and ends the old one, as Microsoft does. */
  rotateRefreshTokens(on: boolean): void
  /** The next `times` provider calls fail as unavailable. */
  failProvider(times: number): void
  /** The provider receives an inbound message (a reply, bounce or complaint) in the inbox. */
  receive(notice: InboundNotice): void
  /** Messages the provider accepted, oldest first. */
  accepted(): readonly OutgoingMessage[]
  /** Grants that were revoked at the provider by `revoke`, as refresh tokens, for a test to assert. */
  revokedByUs(): readonly string[]
}

/** Options for {@link createMemoryMailTransport}. */
export type MemoryMailTransportOptions = {
  clock: Clock
  /** Where the authorization URL sends the person back to; the memory provider consents at once. */
  redirectUri?: string
  /** Which provider this stands in for; defaults to Gmail. */
  provider?: MailboxProvider
}

type Grant = { account: ConnectedAccount; revoked: boolean }

/**
 * A Gmail stand-in that lives in this process: it needs no network, consents on the spot when the
 * authorization URL is opened (a local run without Google), and shows the same failures the real
 * one does. The shared behaviour suite holds it and the Gmail adapter to one contract.
 */
export function createMemoryMailTransport(
  options: MemoryMailTransportOptions
): MemoryMailTransport {
  const codes = new Map<string, { account: ConnectedAccount; challenge: string | null }>()
  const grants = new Map<string, Grant>()
  const accessTokens = new Map<string, { refreshToken: string; expiresAt: number }>()
  const accepted: OutgoingMessage[] = []
  const inbox: InboundNotice[] = []
  const revokedByUs: string[] = []
  let failures = 0
  let accounts = 0
  let rotate = false

  const guard = () => {
    if (failures > 0) {
      failures -= 1
      throw new MailTransportError('unavailable', 503)
    }
  }
  const newAccount = (address: string, displayName: string): ConnectedAccount => ({
    address: address.toLowerCase(),
    displayName,
    providerAccountId: `memory-${createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 16)}`,
  })
  const issue = (refreshToken: string) => {
    const accessToken = `memory-access-${randomUUID()}`
    const expiresAt = options.clock.now().getTime() + ACCESS_TOKEN_MS
    accessTokens.set(accessToken, { refreshToken, expiresAt })
    return { accessToken, expiresAt: new Date(expiresAt).toISOString() }
  }
  const consent = (
    account: { address: string; displayName: string },
    challenge: string | null = null
  ) => {
    const code = `memory-code-${randomUUID()}`
    codes.set(code, { account: newAccount(account.address, account.displayName), challenge })
    return code
  }

  return {
    provider: options.provider ?? 'gmail',
    consent: (account) => consent(account),
    revokeGrant(refreshToken) {
      const grant = grants.get(refreshToken)
      if (grant !== undefined) {
        grant.revoked = true
      }
    },
    rotateRefreshTokens(on) {
      rotate = on
    },
    failProvider(times) {
      failures = times
    },
    receive: (notice) => {
      inbox.push(notice)
    },
    accepted: () => accepted,
    revokedByUs: () => revokedByUs,

    authorizationUrl({ state, codeChallenge }) {
      accounts += 1
      const code = consent(
        { address: `mailbox-${accounts}@memory.test`, displayName: `Mailbox ${accounts}` },
        codeChallenge
      )
      const url = new URL(options.redirectUri ?? 'https://portal.memory.test/mailboxes/callback')
      url.searchParams.set('state', state)
      url.searchParams.set('code', code)
      return url.toString()
    },

    async exchangeCode({ code, codeVerifier }) {
      guard()
      const entry = codes.get(code)
      codes.delete(code)
      if (entry === undefined) {
        throw new MailTransportError('grant_invalid', 400)
      }
      if (
        entry.challenge !== null &&
        createHash('sha256').update(codeVerifier).digest('base64url') !== entry.challenge
      ) {
        throw new MailTransportError('grant_invalid', 400)
      }
      const refreshToken = `memory-refresh-${randomUUID()}`
      grants.set(refreshToken, { account: entry.account, revoked: false })
      return { tokens: { ...issue(refreshToken), refreshToken }, account: entry.account }
    },

    async refresh(refreshToken) {
      guard()
      const grant = grants.get(refreshToken)
      if (grant === undefined || grant.revoked) {
        throw new MailTransportError('grant_invalid', 400)
      }
      if (!rotate) {
        return issue(refreshToken)
      }
      const next = `memory-refresh-${randomUUID()}`
      grant.revoked = true
      grants.set(next, { account: grant.account, revoked: false })
      return { ...issue(next), refreshToken: next }
    },

    async revoke(token) {
      guard()
      const refreshToken = accessTokens.get(token)?.refreshToken ?? token
      const grant = grants.get(refreshToken)
      if (grant !== undefined && !grant.revoked) {
        grant.revoked = true
        revokedByUs.push(refreshToken)
      }
    },

    async send(accessToken, message): Promise<SentMessage> {
      guard()
      const token = accessTokens.get(accessToken)
      const grant = token === undefined ? undefined : grants.get(token.refreshToken)
      if (
        token === undefined ||
        grant === undefined ||
        grant.revoked ||
        token.expiresAt <= options.clock.now().getTime()
      ) {
        throw new MailTransportError('token_expired', 401)
      }
      accepted.push(message)
      const id = randomUUID().replaceAll('-', '').slice(0, 16)
      return { providerMessageId: id, threadId: message.threadId ?? id }
    },

    async fetchInbound(accessToken, { since }) {
      guard()
      const token = accessTokens.get(accessToken)
      if (token === undefined || token.expiresAt <= options.clock.now().getTime()) {
        throw new MailTransportError('token_expired', 401)
      }
      return inbox.filter((n) => n.receivedAt >= since).slice(0, 50)
    },
  }
}
