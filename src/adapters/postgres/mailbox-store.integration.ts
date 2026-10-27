import { afterAll } from 'bun:test'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { describeMailboxStore } from '~/ports/mailbox-store.behaviour'
import { createPostgresMailboxStore } from './mailbox-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

describeMailboxStore('postgres', () =>
  createPostgresMailboxStore((organizationId, fn) =>
    withOrganization(database.db, organizationId, fn)
  )
)
