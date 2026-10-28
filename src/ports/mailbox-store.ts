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
  UserId,
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
  /** Where reading the inbox resumes: the provider's own cursor, opaque to the service. */
  syncCursor: string | null
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

/** A connect attempt as stored: only the hash of its `state`, never the state itself. */
export type StoredAttempt = {
  id: string
  userId: UserId
  /** SHA-256 of the `state`, 64 hex characters. */
  stateHash: string
  createdAt: string
  expiresAt: string
}

/** A test send as stored: an opaque `marker` the service writes (pending, then final) and when it was claimed. */
export type StoredTestSend = { marker: string; sentAt: string }

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
  /**
   * Pauses a Mailbox that is sending (warming, healthy or limited) with a reason; `changed` is
   * false when it was already paused or disconnected. Null when the Mailbox is not there.
   */
  pause: (
    organizationId: OrganizationId,
    id: MailboxId,
    reason: 'complaint_spike' | 'bounce_spike',
    at: string
  ) => Promise<{ record: MailboxRecord; before: MailboxState; changed: boolean } | null>
  /**
   * Records when the inbox was last read and the cursor the next read resumes from, but only if the
   * stored cursor is still `expected` (the one the caller read); false when a concurrent poll moved it.
   */
  markSynced: (
    organizationId: OrganizationId,
    id: MailboxId,
    at: string,
    expected: string | null,
    cursor: string | null
  ) => Promise<boolean>
  /** Records a connect attempt; a repeat of the same `stateHash` changes nothing. */
  registerAttempt: (organizationId: OrganizationId, attempt: StoredAttempt) => Promise<void>
  /**
   * Uses an attempt up: true once for a registered, unexpired, unused attempt of this user, false
   * for every later call and for any other state.
   */
  consumeAttempt: (
    organizationId: OrganizationId,
    userId: UserId,
    stateHash: string,
    at: string
  ) => Promise<boolean>
  /** How many test sends the Mailbox made at or after `since`. */
  countTestSends: (organizationId: OrganizationId, id: MailboxId, since: string) => Promise<number>
  /**
   * Claims a key for a test send: `{ claimed: true }` for the first caller, otherwise the claim
   * already there (pending or final). Atomic per key.
   */
  claimTestSend: (
    organizationId: OrganizationId,
    id: MailboxId,
    keyHash: string,
    claim: StoredTestSend
  ) => Promise<{ claimed: true } | { claimed: false; existing: StoredTestSend }>
  /** Writes the final marker onto a claim. */
  finishTestSend: (
    organizationId: OrganizationId,
    id: MailboxId,
    keyHash: string,
    marker: string
  ) => Promise<void>
  /** Deletes a claim so the key can be tried again (the send failed). */
  releaseTestSend: (organizationId: OrganizationId, id: MailboxId, keyHash: string) => Promise<void>
}
