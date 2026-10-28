import type { MembershipId, OrganizationId } from 'tula-closeline-contract'

/** The hosted login a Rep opens to connect their own LinkedIn account; Closeline never sees the password. */
export type HostedLogin = { hostedLoginUrl: string; expiresAt: string }

/** What the provider says about an account it holds. */
export type ProviderAccountStatus = 'connected' | 'needs_login' | 'restricted' | 'disconnected'

/** The provider failed or refused; `unavailable` may be retried later, `rejected` may not. */
export class LinkedInProviderError extends Error {
  readonly reason: 'unavailable' | 'rejected'

  constructor(reason: 'unavailable' | 'rejected') {
    super(`linkedin provider: ${reason}`)
    this.name = 'LinkedInProviderError'
    this.reason = reason
  }
}

/**
 * The LinkedIn provider behind the channel. Only the connection side exists so far (sending and
 * webhooks come with the send tickets). `accountRef` is the provider's account reference: it is
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
}
