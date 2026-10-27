import type {
  MailboxId,
  MailboxProvider,
  MailboxState,
  MailboxStateReason,
  MembershipId,
  OrganizationId,
} from 'tula-closeline-contract'
import type { Clock, Logger } from 'tula-closeline-kit'
import type { CoreAccess } from '~/ports/core'
import type { MailTransport } from '~/ports/mail-transport'
import type { MailboxStore } from '~/ports/mailbox-store'
import type { SecretBox } from '~/ports/secret-box'

/** The `mailbox.state_changed` v1 payload: a Mailbox moved from one state to another. */
export type MailboxStateChanged = {
  mailboxId: MailboxId
  ownerMembershipId: MembershipId | null
  from: MailboxState
  to: MailboxState
  reason: MailboxStateReason | null
  changedAt: string
}

/** What the mailbox module needs from outside the process; a service function takes this first. */
export type MailboxDeps = {
  store: MailboxStore
  /** Who the caller is as a Membership, and which Reps are on a Manager's Team. */
  access: CoreAccess
  clock: Clock
  /** Seals tokens at rest; unconfigured means connecting answers `server.unavailable`. */
  secretBox: SecretBox
  /** The provider transports that are configured; a provider missing here cannot be connected. */
  transports: Partial<Record<MailboxProvider, MailTransport>>
  /** Signs connect attempts (the `MAIL_STATE_SECRET`). */
  stateSecret: string
  /** Publishes a domain event; the Organization is the one the event happened in. */
  events: (organizationId: OrganizationId, event: MailboxStateChanged) => Promise<void>
  logger: Logger
}
