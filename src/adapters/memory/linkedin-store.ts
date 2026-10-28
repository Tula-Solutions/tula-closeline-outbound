import type { LinkedinAccountId, OrganizationId } from 'tula-closeline-contract'
import type { ChannelState, LinkedinAccountRecord, LinkedinStore } from '~/ports/linkedin-store'

/** The memory store, with what a test needs to set up the channel. */
export type MemoryLinkedinStore = LinkedinStore & {
  /** Sets the Admin switch and the wording versions accepted (until the risk tickets own this). */
  setChannel: (
    organizationId: OrganizationId,
    state: { enabled: boolean; acceptedVersions: readonly string[] }
  ) => void
}

/** An in-process {@link LinkedinStore} for tests and local runs without Postgres. */
export function createMemoryLinkedinStore(): MemoryLinkedinStore {
  const accounts = new Map<string, LinkedinAccountRecord>()
  const channels = new Map<string, { enabled: boolean; acceptedVersions: readonly string[] }>()
  const key = (organizationId: OrganizationId, id: LinkedinAccountId) => `${organizationId}/${id}`
  const inOrg = (organizationId: OrganizationId) =>
    [...accounts.entries()].filter(([k]) => k.startsWith(`${organizationId}/`)).map(([, v]) => v)

  return {
    async connect(organizationId, record) {
      const existing = inOrg(organizationId).find((a) => a.membershipId === record.membershipId)
      const stored: LinkedinAccountRecord = {
        ...record,
        id: existing?.id ?? record.id,
        limits: existing?.limits ?? record.limits,
      }
      accounts.set(key(organizationId, stored.id), stored)
      return stored
    },

    async find(organizationId, id) {
      return accounts.get(key(organizationId, id)) ?? null
    },

    async list(organizationId, visibleOwners, after, limit) {
      const rows = inOrg(organizationId)
        .filter((a) => visibleOwners === undefined || visibleOwners.includes(a.membershipId))
        .sort((a, b) =>
          a.connectedAt !== b.connectedAt
            ? a.connectedAt < b.connectedAt
              ? 1
              : -1
            : a.id < b.id
              ? 1
              : -1
        )
        .filter(
          (a) =>
            after === null ||
            a.connectedAt < after.connectedAt ||
            (a.connectedAt === after.connectedAt && a.id < after.id)
        )
      const items = rows.slice(0, limit)
      const last = items[items.length - 1]
      return {
        items,
        next:
          rows.length > limit && last !== undefined
            ? { connectedAt: last.connectedAt, id: last.id }
            : null,
      }
    },

    async disconnect(organizationId, id, at) {
      const record = accounts.get(key(organizationId, id))
      if (record === undefined) {
        return null
      }
      if (record.status === 'disconnected') {
        return { record, changed: false }
      }
      const next: LinkedinAccountRecord = {
        ...record,
        status: 'disconnected',
        pauseReason: null,
        updatedAt: at,
      }
      accounts.set(key(organizationId, id), next)
      return { record: next, changed: true }
    },

    async channelState(organizationId, wordingVersion): Promise<ChannelState> {
      const channel = channels.get(organizationId)
      return {
        enabled: channel?.enabled ?? false,
        accepted: channel?.acceptedVersions.includes(wordingVersion) ?? false,
      }
    },

    setChannel(organizationId, state) {
      channels.set(organizationId, state)
    },
  }
}
