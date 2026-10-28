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
  type Sent = {
    accountId: LinkedinAccountId
    kind: string
    day: string
    state: 'sending' | 'sent'
    at: string
  }
  const sends = new Map<string, Sent>()
  const usage = new Map<string, { connections: number; messages: number }>()
  const usageKey = (organizationId: OrganizationId, id: LinkedinAccountId, day: string) =>
    `${organizationId}/${id}/${day}`
  const weekOf = (
    organizationId: OrganizationId,
    id: LinkedinAccountId,
    from: string,
    to: string
  ) =>
    [...usage.entries()]
      .filter(([k]) => k.startsWith(`${organizationId}/${id}/`))
      .filter(([k]) => {
        const day = k.slice(k.lastIndexOf('/') + 1)
        return day >= from && day <= to
      })
      .reduce((sum, [, v]) => sum + v.connections, 0)
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

    // Nothing awaits between the check and the write, so concurrent callers take turns.
    async reserve(organizationId, input) {
      const account = accounts.get(key(organizationId, input.accountId))
      if (account === undefined) {
        throw new Error('reserve: no such account')
      }
      if (account.status !== 'connected') {
        return { status: 'not_connected' }
      }
      const sendKey = `${organizationId}/${input.sendKey}`
      const earlier = sends.get(sendKey)
      if (earlier !== undefined) {
        return { status: 'duplicate', state: earlier.state }
      }
      const row = usage.get(usageKey(organizationId, input.accountId, input.day)) ?? {
        connections: 0,
        messages: 0,
      }
      if (input.kind === 'message') {
        if (row.messages >= account.limits.dailyMessages) {
          return { status: 'over_limit', limit: 'daily' }
        }
        row.messages++
      } else {
        if (row.connections >= account.limits.dailyConnections) {
          return { status: 'over_limit', limit: 'daily' }
        }
        if (
          weekOf(organizationId, input.accountId, input.weekStart, input.day) >=
          account.limits.weeklyConnections
        ) {
          return { status: 'over_limit', limit: 'weekly' }
        }
        row.connections++
      }
      usage.set(usageKey(organizationId, input.accountId, input.day), row)
      sends.set(sendKey, {
        accountId: input.accountId,
        kind: input.kind,
        day: input.day,
        state: 'sending',
        at: input.at,
      })
      return { status: 'reserved' }
    },

    async markSent(organizationId, sendKey, at) {
      const row = sends.get(`${organizationId}/${sendKey}`)
      if (row !== undefined && row.state === 'sending') {
        sends.set(`${organizationId}/${sendKey}`, { ...row, state: 'sent', at })
      }
    },

    async release(organizationId, sendKey) {
      const row = sends.get(`${organizationId}/${sendKey}`)
      if (row === undefined || row.state !== 'sending') {
        return false
      }
      sends.delete(`${organizationId}/${sendKey}`)
      const used = usage.get(usageKey(organizationId, row.accountId, row.day))
      if (used !== undefined) {
        if (row.kind === 'message') {
          used.messages = Math.max(0, used.messages - 1)
        } else {
          used.connections = Math.max(0, used.connections - 1)
        }
      }
      return true
    },

    async pause(organizationId, id, status, reason, at) {
      const record = accounts.get(key(organizationId, id))
      if (record === undefined || record.status !== 'connected') {
        return null
      }
      const next: LinkedinAccountRecord = { ...record, status, pauseReason: reason, updatedAt: at }
      accounts.set(key(organizationId, id), next)
      return next
    },

    async setLimits(organizationId, id, limits, at) {
      const record = accounts.get(key(organizationId, id))
      if (record === undefined) {
        return null
      }
      const next: LinkedinAccountRecord = { ...record, limits, updatedAt: at }
      accounts.set(key(organizationId, id), next)
      return next
    },

    async usageOf(organizationId, id, day, weekStart) {
      const row = usage.get(usageKey(organizationId, id, day))
      return {
        connections: row?.connections ?? 0,
        messages: row?.messages ?? 0,
        weeklyConnections: weekOf(organizationId, id, weekStart, day),
      }
    },

    async lastSendAt(organizationId, id) {
      const times = [...sends.entries()]
        .filter(([k, v]) => k.startsWith(`${organizationId}/`) && v.accountId === id)
        .map(([, v]) => v.at)
      return times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b))
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
