import { formatId } from 'tula-closeline-contract'
import { describeMailEventStore } from '~/ports/mail-event-store.behaviour'
import { createMemoryMailEventStore } from './mail-event-store'

describeMailEventStore('memory', () => ({
  store: createMemoryMailEventStore(),
  mailbox: async () => formatId('mbx', crypto.randomUUID()),
}))
