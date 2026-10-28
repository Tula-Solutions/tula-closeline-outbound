import type { MailEventStore, NewMailEvent } from '~/ports/mail-event-store'

/** An in-memory {@link MailEventStore} for tests and the local stack. */
export function createMemoryMailEventStore(): MailEventStore {
  const events = new Map<string, NewMailEvent & { organizationId: string }>()
  return {
    async record(organizationId, event) {
      const key = `${organizationId}|${event.mailboxId}|${event.providerMessageId}`
      if (events.has(key)) {
        return false
      }
      events.set(key, { ...event, organizationId })
      return true
    },
    async countSoftBounces(organizationId, enrollmentId, except) {
      return [...events.values()].filter(
        (e) =>
          e.organizationId === organizationId &&
          e.enrollmentId === enrollmentId &&
          e.kind === 'soft_bounce' &&
          e.providerMessageId !== except
      ).length
    },
  }
}
