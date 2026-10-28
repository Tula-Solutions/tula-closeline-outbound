import { afterAll } from 'bun:test'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { newMailboxRecord, newStoredTokens } from '~/ports/mailbox-store.behaviour'
import { describeSendStore } from '~/ports/send-store.behaviour'
import { createPostgresMailboxStore } from './mailbox-store'
import { createPostgresSendStore } from './send-store'
import type { InOrganization } from './store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const inOrganization: InOrganization = (organizationId, fn) =>
  withOrganization(database.db, organizationId, fn)
const mailboxes = createPostgresMailboxStore(inOrganization)
const store = createPostgresSendStore(inOrganization)

describeSendStore('postgres', () => ({
  store,
  mailbox: async (organizationId) => {
    const record = newMailboxRecord()
    await mailboxes.connect(organizationId, record, newStoredTokens())
    return record.id
  },
}))
