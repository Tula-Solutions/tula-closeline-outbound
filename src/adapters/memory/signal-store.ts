import type { SignalKindSetting } from 'tula-closeline-contract'
import type { SealedSecret } from '~/ports/secret-box'
import {
  SettingsVersionConflictError,
  type SignalStore,
  type StoredSettings,
  type StoredSignal,
} from '~/ports/signal-store'

type OrganizationState = {
  kinds: SignalKindSetting[]
  version: number
  updatedAt: string | null
  sealed: SealedSecret | null
  rotatedAt: string | null
  signals: Map<string, StoredSignal>
  events: Map<string, string>
}

/** The Signal store in process memory, for tests and local runs of one instance. */
export function createMemorySignalStore(): SignalStore {
  const organizations = new Map<string, OrganizationState>()
  const stateOf = (organizationId: string) => {
    let found = organizations.get(organizationId)
    if (found === undefined) {
      found = {
        kinds: [],
        version: 0,
        updatedAt: null,
        sealed: null,
        rotatedAt: null,
        signals: new Map(),
        events: new Map(),
      }
      organizations.set(organizationId, found)
    }
    return found
  }
  const settingsOf = (state: OrganizationState): StoredSettings => ({
    kinds: structuredClone(state.kinds),
    version: state.version,
    updatedAt: state.updatedAt,
    webhook: { sealed: structuredClone(state.sealed), rotatedAt: state.rotatedAt },
  })
  return {
    async settings(organizationId) {
      return settingsOf(stateOf(organizationId))
    },
    async saveSettings(organizationId, kinds, expectedVersion, at) {
      const state = stateOf(organizationId)
      if (state.version !== expectedVersion) {
        throw new SettingsVersionConflictError()
      }
      state.kinds = structuredClone(kinds)
      state.version += 1
      state.updatedAt = at
      return settingsOf(state)
    },
    async setWebhookSecret(organizationId, sealed, at) {
      const state = stateOf(organizationId)
      state.sealed = structuredClone(sealed)
      state.rotatedAt = at
    },
    async record(organizationId, signal, eventId) {
      const state = stateOf(organizationId)
      const existingId = state.signals.has(signal.id)
        ? signal.id
        : eventId === null
          ? undefined
          : state.events.get(eventId)
      const existing = existingId === undefined ? undefined : state.signals.get(existingId)
      if (existing !== undefined) {
        return { signal: structuredClone(existing), duplicate: true }
      }
      state.signals.set(signal.id, structuredClone(signal))
      if (eventId !== null) {
        state.events.set(eventId, signal.id)
      }
      return { signal: structuredClone(signal), duplicate: false }
    },
    async list(organizationId, prospectId, filter) {
      const rest = [...stateOf(organizationId).signals.values()]
        .filter((signal) => signal.prospectId === prospectId)
        .filter((signal) => filter.kind === undefined || signal.kind === filter.kind)
        .filter((signal) => filter.expiresAfter === null || signal.expiresAt > filter.expiresAfter)
        .sort(
          (a, b) =>
            (a.observedAt === b.observedAt ? 0 : a.observedAt < b.observedAt ? 1 : -1) ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
        )
        .filter((signal) => {
          const after = filter.after
          return (
            after === null ||
            signal.observedAt < after.observedAt ||
            (signal.observedAt === after.observedAt && signal.id < after.id)
          )
        })
      const items = rest.slice(0, filter.limit).map((signal) => structuredClone(signal))
      const last = items.at(-1)
      return {
        items,
        next:
          rest.length > filter.limit && last !== undefined
            ? { observedAt: last.observedAt, id: last.id }
            : null,
      }
    },
    async get(organizationId, signalId) {
      const found = stateOf(organizationId).signals.get(signalId)
      return found === undefined ? null : structuredClone(found)
    },
  }
}
