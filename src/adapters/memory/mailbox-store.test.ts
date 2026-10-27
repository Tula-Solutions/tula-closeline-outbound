import { describeMailboxStore } from '~/ports/mailbox-store.behaviour'
import { createMemoryMailboxStore } from './mailbox-store'

describeMailboxStore('memory', createMemoryMailboxStore)
