import type { Clock, ContactGuard, Logger } from 'tula-closeline-kit'
import type { MailboxDeps } from '~/modules/mailbox/deps'
import type { CampaignStore } from '~/ports/campaign-store'
import type { SendStore } from '~/ports/send-store'

/** What the send module needs from outside the process; a service function takes this first. */
export type SendDeps = {
  store: SendStore
  /** The Mailboxes to send through, and the one place a message leaves for a provider. */
  mailboxes: MailboxDeps
  campaigns: CampaignStore
  /** The Contact Check; fails closed, and nothing here can turn it off (ADR 0003). */
  guard: ContactGuard
  clock: Clock
  logger: Logger
  /** Signs and addresses the unsubscribe link of every message. */
  unsubscribe: { secret: string; url: string }
  /** Most messages an Organization sends in a UTC day, across all its Mailboxes. */
  organizationDailyCap: number
}
