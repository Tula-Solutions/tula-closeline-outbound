import type {
  DraftId,
  LimitDetails,
  MailboxId,
  OrganizationId,
  SendCheck,
  SendId,
  SendRecord,
} from 'tula-closeline-contract'

/** A send decision as stored: the contract's record plus the key and the provider's ids. */
export type StoredSend = SendRecord & {
  /** `enrollmentId:step:attemptEpoch`, unique per Organization. */
  key: string
  draftId: DraftId | null
  providerMessageId: string | null
  providerThreadId: string | null
  updatedAt: string
}

/** What the limits check reads for one reserve; counts cover `sending` and `sent` rows. */
export type ReserveLimits = {
  mailboxId: MailboxId
  perDay: number
  perHour: number
  minGapSeconds: number
  /** Start of the UTC day and of the UTC hour that `now` falls in (ISO 8601). */
  dayStart: string
  hourStart: string
  now: string
  organizationDailyCap: number
}

/** What {@link SendStore.reserve} did. */
export type ReserveResult =
  | { kind: 'reserved'; send: StoredSend }
  | { kind: 'exists'; send: StoredSend }
  | { kind: 'blocked'; limit: LimitDetails['limit']; lastAt: string | null }

/** What {@link SendStore.record} did. */
export type RecordResult =
  | { kind: 'recorded'; send: StoredSend }
  | { kind: 'exists'; send: StoredSend }

/** What has been sent (or is being sent) since the start of the day and hour. */
export type SendUsage = {
  mailboxes: Record<string, { today: number; thisHour: number; lastAt: string | null }>
  organizationToday: number
}

/** The checks a decision ran and whether each passed. */
export type CheckResults = { check: SendCheck; passed: boolean }[]

/** A decision to write: a `sending` row (via reserve) or a refusal or deferral (via record). */
export type NewSend = Omit<
  StoredSend,
  'updatedAt' | 'sentAt' | 'providerMessageId' | 'providerThreadId'
> & {
  id: SendId
}

/** The send log; every call is scoped to one Organization and each write is atomic. */
export type SendStore = {
  /** The decision under this key, or null. */
  find: (organizationId: OrganizationId, key: string) => Promise<StoredSend | null>
  /**
   * Writes a `sending` row for the Mailbox unless the key already has a decision (a `deferred`
   * one is replaced), and only when the Mailbox and the Organization are under their limits at
   * this moment; the count and the write are one atomic step.
   */
  reserve: (
    organizationId: OrganizationId,
    send: NewSend,
    limits: ReserveLimits
  ) => Promise<ReserveResult>
  /** Writes a refusal or deferral unless the key already has a decision (a `deferred` one is replaced). */
  record: (organizationId: OrganizationId, send: NewSend) => Promise<RecordResult>
  /** Moves a `sending` row to `sent` or `failed`; null when it is not `sending` (already settled). */
  settle: (
    organizationId: OrganizationId,
    id: SendId,
    outcome:
      | {
          state: 'sent'
          at: string
          providerMessageId: string | null
          providerThreadId: string | null
        }
      | { state: 'failed'; at: string }
  ) => Promise<StoredSend | null>
  /** What the given Mailboxes and the Organization have sent since the day and hour started. */
  usage: (
    organizationId: OrganizationId,
    mailboxIds: readonly MailboxId[],
    dayStart: string,
    hourStart: string
  ) => Promise<SendUsage>
  /** The Mailbox and thread of the latest message sent in an Enrollment, or null when none was. */
  lastOfEnrollment: (
    organizationId: OrganizationId,
    enrollmentId: string
  ) => Promise<{ mailboxId: MailboxId; providerThreadId: string | null } | null>
  /** `sending` rows decided before `before`, oldest first, at most `limit`. */
  listStale: (
    organizationId: OrganizationId,
    before: string,
    limit: number
  ) => Promise<StoredSend[]>
}
