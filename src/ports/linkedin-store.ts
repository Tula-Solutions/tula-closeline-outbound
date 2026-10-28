import type {
  LinkedinAccountId,
  LinkedinLimits,
  MembershipId,
  OrganizationId,
} from 'tula-closeline-contract'

/** The states of an account, as the contract lists them. */
export type LinkedinAccountStatus =
  | 'connected'
  | 'needs_login'
  | 'paused'
  | 'restricted'
  | 'disconnected'

/** A LinkedIn account as stored, with the provider's reference (which never leaves the service). */
export type LinkedinAccountRecord = {
  id: LinkedinAccountId
  membershipId: MembershipId
  providerAccountId: string
  status: LinkedinAccountStatus
  pauseReason:
    | 'restricted'
    | 'checkpoint'
    | 'provider_unavailable'
    | 'admin'
    | 'rate_limited'
    | null
  limits: LinkedinLimits
  connectedAt: string
  updatedAt: string
}

/** Where a newest-first page resumes: after the account with this connection time and id. */
export type LinkedinPosition = { connectedAt: string; id: LinkedinAccountId }

/** One page of accounts, newest connection first; `next` is set when more follow. */
export type LinkedinAccountPage = { items: LinkedinAccountRecord[]; next: LinkedinPosition | null }

/** The channel as the connection start needs it: the Admin switch and whether the wording is accepted. */
export type ChannelState = { enabled: boolean; accepted: boolean }

/** The store of LinkedIn accounts; every call is scoped to one Organization. */
export type LinkedinStore = {
  /**
   * Stores a connected account. An account of the same Membership (connected or not) is reused:
   * it keeps its id and its limits and takes the new reference and status.
   */
  connect: (
    organizationId: OrganizationId,
    record: LinkedinAccountRecord
  ) => Promise<LinkedinAccountRecord>
  /** One account, or null. */
  find: (
    organizationId: OrganizationId,
    id: LinkedinAccountId
  ) => Promise<LinkedinAccountRecord | null>
  /** One page, newest connection first, at most `limit`; `visibleOwners` undefined means all. */
  list: (
    organizationId: OrganizationId,
    visibleOwners: readonly MembershipId[] | undefined,
    after: LinkedinPosition | null,
    limit: number
  ) => Promise<LinkedinAccountPage>
  /** Marks the account disconnected; `changed` is false when it already was. Null when not there. */
  disconnect: (
    organizationId: OrganizationId,
    id: LinkedinAccountId,
    at: string
  ) => Promise<{ record: LinkedinAccountRecord; changed: boolean } | null>
  /** The Admin switch and whether a non-revoked acceptance of this wording version exists. */
  channelState: (organizationId: OrganizationId, wordingVersion: string) => Promise<ChannelState>
}
