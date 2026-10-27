import type {
  MailboxId,
  MailboxKind,
  MailboxLimits,
  MailboxProvider,
  MailboxState,
  MailboxStateReason,
  MembershipId,
  OrganizationId,
  TeamId,
} from 'tula-closeline-contract'

/** A Mailbox as stored: everything but its tokens. The ramp and effective limits are computed from it. */
export type MailboxRecord = {
  id: MailboxId
  provider: MailboxProvider
  kind: MailboxKind
  /** Lower-cased. */
  address: string
  displayName: string
  providerAccountId: string
  /** Null for a shared Mailbox. */
  ownerMembershipId: MembershipId | null
  /** The Teams a shared Mailbox is opened to; empty for a personal one. */
  teamIds: readonly TeamId[]
  state: MailboxState
  stateReason: MailboxStateReason | null
  stateChangedAt: string
  limits: MailboxLimits
  health: {
    score: number | null
    effect: 'none' | 'limit_halved' | 'paused'
    scoredAt: string | null
  }
  rampStartedAt: string
  connectedAt: string
  lastSyncedAt: string | null
}

/** The sealed tokens of one Mailbox. Both are sealed under `keyId`; a plain token never reaches a store. */
export type StoredTokens = {
  keyId: string
  accessToken: Uint8Array
  /** When the access token stops working (ISO 8601). */
  accessTokenExpiresAt: string
  refreshToken: Uint8Array
}

/** Which Mailboxes a list may return; every field narrows, none widens what the caller sees. */
export type MailboxFilter = {
  /**
   * Personal Mailboxes of these owners only; undefined means every Mailbox, shared ones included
   * (Owner and Admin).
   */
  visibleOwners?: readonly MembershipId[] | undefined
  state?: MailboxState | undefined
  provider?: MailboxProvider | undefined
  kind?: MailboxKind | undefined
  ownerMembershipId?: MembershipId | undefined
}

/** Where an oldest-first page resumes: after the Mailbox with this connection time and id. */
export type MailboxPosition = { connectedAt: string; id: MailboxId }

/** One page of Mailboxes, oldest connection first; `next` is set when more follow. */
export type MailboxPage = { items: MailboxRecord[]; next: MailboxPosition | null }

/** What {@link MailboxStore.connect} did. */
export type ConnectResult =
  | { kind: 'connected'; record: MailboxRecord }
  | { kind: 'already_connected' }

/** The store of Mailboxes and their sealed tokens; every call is scoped to one Organization. */
export type MailboxStore = {
  /**
   * Stores a newly connected Mailbox with its tokens. A disconnected Mailbox at the same
   * (provider, address) is reused, keeping its id; one that is still connected is `already_connected`.
   */
  connect: (
    organizationId: OrganizationId,
    record: MailboxRecord,
    tokens: StoredTokens
  ) => Promise<ConnectResult>
  /** One Mailbox, or null. */
  find: (organizationId: OrganizationId, id: MailboxId) => Promise<MailboxRecord | null>
  /** The Mailbox at this address, connected or not, or null. */
  findByAddress: (
    organizationId: OrganizationId,
    provider: MailboxProvider,
    address: string
  ) => Promise<MailboxRecord | null>
  /** One page, oldest connection first, at most `limit`. */
  list: (
    organizationId: OrganizationId,
    filter: MailboxFilter,
    after: MailboxPosition | null,
    limit: number
  ) => Promise<MailboxPage>
  /** The sealed tokens, or null for a Mailbox that is disconnected or not there. */
  readTokens: (organizationId: OrganizationId, id: MailboxId) => Promise<StoredTokens | null>
  /** Replaces the tokens; false when the Mailbox is disconnected or not there (a token is never put back). */
  writeTokens: (
    organizationId: OrganizationId,
    id: MailboxId,
    tokens: StoredTokens
  ) => Promise<boolean>
  /**
   * Disconnects: deletes the tokens and sets the state and reason in one step. `changed` is false
   * when it was already disconnected; null when the Mailbox is not there.
   */
  disconnect: (
    organizationId: OrganizationId,
    id: MailboxId,
    reason: 'disconnected_by_owner' | 'auth_revoked',
    at: string
  ) => Promise<{ record: MailboxRecord; changed: boolean } | null>
}
