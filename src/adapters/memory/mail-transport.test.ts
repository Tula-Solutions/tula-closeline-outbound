import { createFixedClock } from 'tula-closeline-kit'
import { describeMailTransport } from '~/ports/mail-transport.behaviour'
import { createMemoryMailTransport } from './mail-transport'

describeMailTransport('memory', () => {
  const transport = createMemoryMailTransport({
    clock: createFixedClock(new Date('2026-01-01T00:00:00Z')),
  })
  return { ...transport, transport }
})
