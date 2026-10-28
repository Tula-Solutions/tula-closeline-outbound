import type { MembershipId, OrganizationId } from 'tula-closeline-contract'

/** The hosted login a Rep opens to connect their own LinkedIn account; Closeline never sees the password. */
export type HostedLogin = { hostedLoginUrl: string; expiresAt: string }

/** What the provider says about an account it holds. */
export type ProviderAccountStatus = 'connected' | 'needs_login' | 'restricted' | 'disconnected'

/**
 * The provider failed or refused. `unavailable` means the call was not processed and may be retried;
 * `rejected` may not; `unknown` means the outcome is not known (a timeout), so it must never be resent.
 */
export class LinkedInProviderError extends Error {
  readonly reason: 'unavailable' | 'rejected' | 'unknown'

  constructor(reason: 'unavailable' | 'rejected' | 'unknown') {
    super(`linkedin provider: ${reason}`)
    this.name = 'LinkedInProviderError'
    this.reason = reason
  }
}

/** What the provider answers to a send: delivered, or why the account may not send now. */
export type SendOutcome = 'sent' | 'restricted' | 'checkpoint' | 'rate_limited'

/** One send to a LinkedIn member: a connection request (with an optional note) or a message. */
export type ProviderSend = {
  kind: 'connection' | 'message'
  accountRef: string
  /** The recipient's reference at the provider; never logged. */
  recipient: string
  /** The note or message body; never logged. */
  text: string | null
  /** The provider answers the same key with the same result and does not send twice. */
  idempotencyKey: string
}

/**
 * The LinkedIn provider behind the channel. The connection and send sides exist (webhooks come
 * later). `accountRef` is the provider's account reference: it is
 * stored, never returned by a route and never logged.
 */
export type LinkedInProvider = {
  /** Starts the hosted login for a Rep; the same `idempotencyKey` answers the same login. */
  startConnection: (input: {
    organizationId: OrganizationId
    membershipId: MembershipId
    idempotencyKey: string
  }) => Promise<HostedLogin>
  /** The provider's view of an account. */
  readAccount: (accountRef: string) => Promise<{ status: ProviderAccountStatus }>
  /** Removes the account at the provider; removing one that is gone is a no-op. */
  disconnect: (accountRef: string) => Promise<void>
  /** Sends one connection request or message; the same `idempotencyKey` never sends twice. */
  send: (input: ProviderSend) => Promise<SendOutcome>
}
