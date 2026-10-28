import { afterAll } from 'bun:test'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { describeMailEventStore } from '~/ports/mail-event-store.behaviour'
import { newMailboxRecord, newStoredTokens } from '~/ports/mailbox-store.behaviour'
import { createPostgresMailEventStore } from './mail-event-store'
import { createPostgresMailboxStore } from './mailbox-store'
import type { InOrganization } from './store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const inOrganization: InOrganization = (organizationId, fn) =>
  withOrganization(database.db, organizationId, fn)
const mailboxes = createPostgresMailboxStore(inOrganization)
const store = createPostgresMailEventStore(inOrganization)

describeMailEventStore('postgres', () => ({
  store,
  mailbox: async (organizationId) => {
    const record = newMailboxRecord()
    await mailboxes.connect(organizationId, record, newStoredTokens())
    return record.id
  },
}))
