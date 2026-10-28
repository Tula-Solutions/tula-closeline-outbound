import type {
  LinkedinAccountId,
  LinkedinLimits,
  LinkedinRiskAcceptanceId,
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

/** A risk acceptance as stored: append-only, and the only change is `revokedAt`, set once. */
export type RiskAcceptanceRecord = {
  id: LinkedinRiskAcceptanceId
  wordingVersion: string
  acceptedByMembershipId: MembershipId
  typedFullName: string
  acceptedAt: string
  revokedAt: string | null
}

/** Where a newest-first page of acceptances resumes: after the one with this time and id. */
export type AcceptancePosition = { acceptedAt: string; id: LinkedinRiskAcceptanceId }

/** One page of acceptances, newest first; `next` is set when more follow. */
export type AcceptancePage = { items: RiskAcceptanceRecord[]; next: AcceptancePosition | null }

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
  /**
   * Records an acceptance. When a non-revoked acceptance of the same wording version exists it is
   * returned unchanged (`created` false) and nothing is written; concurrent calls record one.
   */
  acceptRisk: (
    organizationId: OrganizationId,
    record: RiskAcceptanceRecord
  ) => Promise<{ record: RiskAcceptanceRecord; created: boolean }>
  /** Revokes every non-revoked acceptance at `at`; the count is 0 when there was none. */
  revokeRisk: (organizationId: OrganizationId, at: string) => Promise<number>
  /** The non-revoked acceptance of this wording version, or null. */
  activeAcceptance: (
    organizationId: OrganizationId,
    wordingVersion: string
  ) => Promise<RiskAcceptanceRecord | null>
  /** One page of acceptances, newest first, at most `limit`. */
  listAcceptances: (
    organizationId: OrganizationId,
    after: AcceptancePosition | null,
    limit: number
  ) => Promise<AcceptancePage>
  /** Sets the Admin switch (one row per Organization) and answers what it was before. */
  setEnabled: (
    organizationId: OrganizationId,
    enabled: boolean,
    byMembershipId: MembershipId,
    at: string
  ) => Promise<{ previous: boolean }>
}
