import type { MailboxProvider } from 'tula-closeline-contract'

/** Why a call to the mail provider produced no usable answer. Fixed words only, never a body or a token. */
export type MailTransportFailure =
  /** The code or the refresh token is no longer good: used, expired, or the person revoked the grant. */
  | 'grant_invalid'
  /** The access token is no longer accepted; refresh it and send again. */
  | 'token_expired'
  /** The provider could not be reached or answered 5xx or 429 on every try. */
  | 'unavailable'
  /** The provider did not answer within the bound on every try. */
  | 'timeout'
  /** The provider refused the request for a reason a retry will not change. */
  | 'rejected'

/** The only error a {@link MailTransport} throws; its message is built from fixed words. */
export class MailTransportError extends Error {
  /** What went wrong, for the caller to branch on. */
  readonly failure: MailTransportFailure
  /** The HTTP status the provider answered with, when it answered. */
  readonly status: number | undefined

  /** Builds the error from the failure kind and status alone: nothing the provider said is kept. */
  constructor(failure: MailTransportFailure, status?: number) {
    super(`mail provider call failed: ${failure}${status === undefined ? '' : ` (${status})`}`)
    this.name = 'MailTransportError'
    this.failure = failure
    this.status = status
  }
}

/** The tokens of one grant. `expiresAt` is when the access token stops working (ISO 8601). */
export type GrantTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: string
}

/** The account a person consented with, as the provider names it. */
export type ConnectedAccount = {
  /** The email address, lower-cased. */
  address: string
  displayName: string
  /** The provider's own stable id for the account. */
  providerAccountId: string
}

/** One email to send. Text only; the transport builds the wire format. */
export type OutgoingMessage = {
  from: { address: string; name: string }
  to: string
  subject: string
  text: string
  /** Extra headers such as `List-Unsubscribe`; names and values may not contain a line break. */
  headers?: Record<string, string>
  /** The provider's thread to add to, for a follow-up. */
  threadId?: string
  /** The `Message-ID` this replies to, for threading in the recipient's client. */
  inReplyTo?: string
}

/** The ids the provider gave a message it accepted. */
export type SentMessage = { providerMessageId: string; threadId: string }

/** One mail provider's OAuth grant and send API (Gmail now, Microsoft Graph next). */
export interface MailTransport {
  /** The provider this transport talks to. */
  readonly provider: MailboxProvider
  /** The URL to send the person to for consent; `codeChallenge` is the S256 PKCE challenge. */
  authorizationUrl(input: { state: string; codeChallenge: string }): string
  /** Trades the single-use code for tokens and names the account. Throws `grant_invalid` for a bad code. */
  exchangeCode(input: {
    code: string
    codeVerifier: string
  }): Promise<{ tokens: GrantTokens; account: ConnectedAccount }>
  /** A new access token for the grant. Throws `grant_invalid` when the grant was revoked. */
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: string }>
  /** Revokes the grant at the provider; revoking one already revoked is not an error. */
  revoke(token: string): Promise<void>
  /** Sends one email. Never retried after an unknown outcome: a timeout may have sent it. */
  send(accessToken: string, message: OutgoingMessage): Promise<SentMessage>
}
