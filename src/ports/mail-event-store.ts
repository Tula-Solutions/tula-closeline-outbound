import type {
  EnrollmentId,
  MailboxId,
  OrganizationId,
  ProspectId,
  SendId,
} from 'tula-closeline-contract'

/** What happened to a message or a Prospect's mail, as the log keeps it (no message text). */
export type MailEventKind =
  | 'hard_bounce'
  | 'soft_bounce'
  | 'complaint'
  | 'reply'
  | 'out_of_office'
  | 'unsubscribe'

/** One entry of the mail event log. */
export type NewMailEvent = {
  id: string
  mailboxId: MailboxId
  kind: MailEventKind
  sendId: SendId | null
  prospectId: ProspectId | null
  enrollmentId: EnrollmentId | null
  /** The provider's id of the notice; with the Mailbox it makes a replay a no-op. */
  providerMessageId: string
  occurredAt: string
}

/** The mail event log; every call is scoped to one Organization. */
export type MailEventStore = {
  /** Writes the event unless this Mailbox already logged this provider message; true when written now. */
  record: (organizationId: OrganizationId, event: NewMailEvent) => Promise<boolean>
  /** How many soft bounces the Enrollment has logged, not counting `exceptProviderMessageId`: the bound on retrying. */
  countSoftBounces: (
    organizationId: OrganizationId,
    enrollmentId: EnrollmentId,
    exceptProviderMessageId?: string
  ) => Promise<number>
}
