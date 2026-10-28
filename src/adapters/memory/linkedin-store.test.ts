import { describeLinkedinStore } from '~/ports/linkedin-store.behaviour'
import { createMemoryLinkedinStore } from './linkedin-store'

describeLinkedinStore('memory', () => {
  const store = createMemoryLinkedinStore()
  return {
    store,
    seedChannel: async (organizationId, { enabled, acceptedVersion }) =>
      store.setChannel(organizationId, {
        enabled,
        acceptedVersions: acceptedVersion === null ? [] : [acceptedVersion],
      }),
  }
})
