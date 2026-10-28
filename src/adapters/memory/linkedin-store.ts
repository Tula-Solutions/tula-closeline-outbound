import {
  formatId,
  type LinkedinAccountId,
  type LinkedinRiskAcceptanceId,
  type MembershipId,
  type OrganizationId,
} from 'tula-closeline-contract'
import type {
  ChannelState,
  LinkedinAccountRecord,
  LinkedinStore,
  RiskAcceptanceRecord,
} from '~/ports/linkedin-store'

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
  const switches = new Map<string, boolean>()
  const acceptances = new Map<string, RiskAcceptanceRecord[]>()
  const key = (organizationId: OrganizationId, id: LinkedinAccountId) => `${organizationId}/${id}`
  const inOrg = (organizationId: OrganizationId) =>
    [...accounts.entries()].filter(([k]) => k.startsWith(`${organizationId}/`)).map(([, v]) => v)

  const active = (organizationId: OrganizationId, wordingVersion: string) =>
    (acceptances.get(organizationId) ?? []).find(
      (a) => a.wordingVersion === wordingVersion && a.revokedAt === null
    )

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
      return {
        enabled: switches.get(organizationId) ?? false,
        accepted: active(organizationId, wordingVersion) !== undefined,
      }
    },

    async acceptRisk(organizationId, record) {
      const existing = active(organizationId, record.wordingVersion)
      if (existing !== undefined) {
        return { record: existing, created: false }
      }
      acceptances.set(organizationId, [...(acceptances.get(organizationId) ?? []), record])
      return { record, created: true }
    },

    async revokeRisk(organizationId, at) {
      let count = 0
      acceptances.set(
        organizationId,
        (acceptances.get(organizationId) ?? []).map((a) => {
          if (a.revokedAt !== null) {
            return a
          }
          count++
          return { ...a, revokedAt: at }
        })
      )
      return count
    },

    async activeAcceptance(organizationId, wordingVersion) {
      return active(organizationId, wordingVersion) ?? null
    },

    async listAcceptances(organizationId, after, limit) {
      const rows = (acceptances.get(organizationId) ?? [])
        .toSorted((a, b) =>
          a.acceptedAt !== b.acceptedAt
            ? a.acceptedAt < b.acceptedAt
              ? 1
              : -1
            : a.id < b.id
              ? 1
              : -1
        )
        .filter(
          (a) =>
            after === null ||
            a.acceptedAt < after.acceptedAt ||
            (a.acceptedAt === after.acceptedAt && a.id < after.id)
        )
      const items = rows.slice(0, limit)
      const last = items[items.length - 1]
      return {
        items,
        next:
          rows.length > limit && last !== undefined
            ? { acceptedAt: last.acceptedAt, id: last.id }
            : null,
      }
    },

    async setEnabled(organizationId, enabled) {
      const previous = switches.get(organizationId) ?? false
      switches.set(organizationId, enabled)
      return { previous }
    },

    setChannel(organizationId, state) {
      switches.set(organizationId, state.enabled)
      acceptances.set(
        organizationId,
        state.acceptedVersions.map((wordingVersion) => ({
          id: formatId('lra', crypto.randomUUID()) as LinkedinRiskAcceptanceId,
          wordingVersion,
          acceptedByMembershipId: formatId('mem', crypto.randomUUID()) as MembershipId,
          typedFullName: 'Test Admin',
          acceptedAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null,
        }))
      )
    },
  }
}
