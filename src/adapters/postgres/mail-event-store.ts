import { and, count, eq, ne } from 'drizzle-orm'
import { mailEvents } from 'tula-closeline-db/schema'
import type { MailEventStore } from '~/ports/mail-event-store'
import type { InOrganization } from './store'

/** The Postgres {@link MailEventStore}; the unique (Organization, Mailbox, provider message) index is the replay guard. */
export function createPostgresMailEventStore(inOrganization: InOrganization): MailEventStore {
  return {
    async record(organizationId, event) {
      const rows = await inOrganization(organizationId, (tx) =>
        tx
          .insert(mailEvents)
          .values({
            id: event.id,
            organizationId,
            mailboxId: event.mailboxId,
            kind: event.kind,
            sendId: event.sendId,
            prospectId: event.prospectId,
            enrollmentId: event.enrollmentId,
            providerMessageId: event.providerMessageId,
            occurredAt: new Date(event.occurredAt),
          })
          .onConflictDoNothing()
          .returning({ id: mailEvents.id })
      )
      return rows.length > 0
    },

    async countSoftBounces(organizationId, enrollmentId, except) {
      const [row] = await inOrganization(organizationId, (tx) =>
        tx
          .select({ n: count() })
          .from(mailEvents)
          .where(
            and(
              eq(mailEvents.organizationId, organizationId),
              eq(mailEvents.enrollmentId, enrollmentId),
              eq(mailEvents.kind, 'soft_bounce'),
              except === undefined ? undefined : ne(mailEvents.providerMessageId, except)
            )
          )
      )
      return row?.n ?? 0
    },
  }
}
