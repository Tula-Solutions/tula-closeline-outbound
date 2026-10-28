import type { Clock, Logger } from 'tula-closeline-kit'
import type { MailboxDeps } from '~/modules/mailbox/deps'
import type { CoreProspects } from '~/ports/core'
import type { CoreSuppression } from '~/ports/core-suppression'
import type { EnrollmentStore } from '~/ports/enrollment-store'
import type { MailEventStore } from '~/ports/mail-event-store'
import type { SendStore } from '~/ports/send-store'

/** The ids every message event names; only ids, never text. */
type Ids = {
  mailboxId: string
  prospectId: string
  sendId: string
  campaignId: string
  enrollmentId: string
  providerMessageId: string
}

/** An event this repo publishes about mail that came back; the sequence engine and the health score consume them. */
export type MailEvent =
  | { name: 'mail.bounced'; payload: Ids & { kind: 'hard' | 'soft'; bouncedAt: string } }
  | { name: 'mail.complained'; payload: Ids & { complainedAt: string } }
  | { name: 'mail.replied'; payload: Ids & { repliedAt: string } }
  | {
      name: 'mail.out_of_office'
      payload: Ids & { returnDate: string | null; receivedAt: string }
    }
  | {
      name: 'mail.unsubscribed'
      payload: {
        prospectId: string
        mailboxId: string | null
        sendId: string | null
        enrollmentId: string | null
        source: 'link' | 'one_click'
        unsubscribedAt: string
      }
    }

/** What the mail event module needs from outside the process; a service function takes this first. */
export type MailEventDeps = {
  /** Reads a Mailbox's inbox through its transport and pauses it. */
  mailboxes: MailboxDeps
  sends: SendStore
  enrollments: EnrollmentStore
  log: MailEventStore
  prospects: CoreProspects
  suppression: CoreSuppression
  clock: Clock
  logger: Logger
  /** Signs the unsubscribe token and the webhook state (the `MAIL_STATE_SECRET`). */
  secret: string
  /** Publishes an event for the Organization. */
  publish: (organizationId: string, event: MailEvent) => Promise<void>
}
