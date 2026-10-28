import { describe, expect, test } from 'bun:test'
import { formatId, type MailboxId, type OrganizationId } from 'tula-closeline-contract'
import type { MailEventStore, NewMailEvent } from './mail-event-store'

/** What a {@link MailEventStore} suite needs: the store and a way to make a Mailbox that exists. */
export type MailEventStoreHarness = {
  store: MailEventStore
  /** Makes a Mailbox in the Organization (a foreign key in Postgres) and returns its id. */
  mailbox: (organizationId: OrganizationId) => Promise<MailboxId>
}

/** An event for a Mailbox; the provider message id is unique unless given. */
function event(mailboxId: MailboxId, overrides: Partial<NewMailEvent> = {}): NewMailEvent {
  return {
    id: formatId('mev', crypto.randomUUID()),
    mailboxId,
    kind: 'soft_bounce',
    sendId: null,
    prospectId: formatId('prs', crypto.randomUUID()),
    enrollmentId: formatId('enr', crypto.randomUUID()),
    providerMessageId: `m-${crypto.randomUUID()}`,
    occurredAt: '2026-03-10T12:00:00.000Z',
    ...overrides,
  }
}

/** The behaviour every {@link MailEventStore} adapter must show. */
export function describeMailEventStore(name: string, harness: () => MailEventStoreHarness) {
  describe(`MailEventStore (${name})`, () => {
    test('a replayed provider message is logged once', async () => {
      const { store, mailbox } = harness()
      const org = formatId('org', crypto.randomUUID())
      const mbx = await mailbox(org)
      const first = event(mbx, { providerMessageId: 'same' })
      expect(await store.record(org, first)).toBe(true)
      expect(await store.record(org, { ...first, id: formatId('mev', crypto.randomUUID()) })).toBe(
        false
      )
    })

    test('counts the soft bounces of one Enrollment only', async () => {
      const { store, mailbox } = harness()
      const org = formatId('org', crypto.randomUUID())
      const mbx = await mailbox(org)
      const enrollmentId = formatId('enr', crypto.randomUUID())
      await store.record(org, event(mbx, { enrollmentId }))
      await store.record(org, event(mbx, { enrollmentId }))
      await store.record(org, event(mbx, { enrollmentId, kind: 'reply' }))
      await store.record(org, event(mbx))
      expect(await store.countSoftBounces(org, enrollmentId)).toBe(2)
    })

    test('leaves out the named provider message', async () => {
      const { store, mailbox } = harness()
      const org = formatId('org', crypto.randomUUID())
      const mbx = await mailbox(org)
      const enrollmentId = formatId('enr', crypto.randomUUID())
      const first = event(mbx, { enrollmentId })
      await store.record(org, first)
      await store.record(org, event(mbx, { enrollmentId }))
      expect(await store.countSoftBounces(org, enrollmentId, first.providerMessageId)).toBe(1)
    })

    test('another Organization sees none of it', async () => {
      const { store, mailbox } = harness()
      const org = formatId('org', crypto.randomUUID())
      const other = formatId('org', crypto.randomUUID())
      const mbx = await mailbox(org)
      const enrollmentId = formatId('enr', crypto.randomUUID())
      await store.record(org, event(mbx, { enrollmentId }))
      expect(await store.countSoftBounces(other, enrollmentId)).toBe(0)
    })
  })
}
