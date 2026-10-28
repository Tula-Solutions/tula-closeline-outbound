import { formatId } from 'tula-closeline-contract'
import { describeSendStore } from '~/ports/send-store.behaviour'
import { createMemorySendStore } from './send-store'

describeSendStore('memory', () => ({
  store: createMemorySendStore(),
  mailbox: async () => formatId('mbx', crypto.randomUUID()),
}))
