import type {
  OrganizationId,
  ProspectId,
  SignalId,
  SignalKind,
  SignalKindSetting,
  SignalSource,
} from 'tula-closeline-contract'
import type { SealedSecret } from '~/ports/secret-box'

/** A Signal as kept: the contract's fields except `fresh`, which is read against the clock. */
export type StoredSignal = {
  id: SignalId
  prospectId: ProspectId
  kind: SignalKind
  source: SignalSource
  observedAt: string
  recordedAt: string
  expiresAt: string
  /** The kind-specific fields, already validated by the contract; data, never an instruction. */
  detail: Record<string, unknown>
}

/** An Organization's signal settings as kept; `kinds` is empty until the first save (the defaults then apply). */
export type StoredSettings = {
  kinds: SignalKindSetting[]
  /** 0 until the first save. */
  version: number
  updatedAt: string | null
  /** The sealed signing secret of the webhook, or null when none was made. */
  webhook: { sealed: SealedSecret | null; rotatedAt: string | null }
}

/** Where a Prospect's timeline resumes: the last item of the previous page. */
export type SignalPosition = { observedAt: string; id: string }

/** The settings were saved by someone else since the caller read them. */
export class SettingsVersionConflictError extends Error {
  constructor() {
    super('the signal settings changed since they were read')
    this.name = 'SettingsVersionConflictError'
  }
}

/** The store of an Organization's Signals and Signal settings; every call is scoped to one Organization. */
export type SignalStore = {
  /** The settings, with `version` 0 and no kinds when none were saved. */
  settings: (organizationId: OrganizationId) => Promise<StoredSettings>
  /** Saves every kind and moves the version on; throws {@link SettingsVersionConflictError} unless `expectedVersion` is the current one. */
  saveSettings: (
    organizationId: OrganizationId,
    kinds: SignalKindSetting[],
    expectedVersion: number,
    at: string
  ) => Promise<StoredSettings>
  /** Replaces the webhook signing secret; the old one stops working at once. */
  setWebhookSecret: (
    organizationId: OrganizationId,
    sealed: SealedSecret,
    at: string
  ) => Promise<void>
  /**
   * Keeps a Signal once. A Signal with the same id, or the same `eventId` when it has one, is a
   * duplicate: nothing is written and the Signal already kept is returned.
   */
  record: (
    organizationId: OrganizationId,
    signal: StoredSignal,
    eventId: string | null
  ) => Promise<{ signal: StoredSignal; duplicate: boolean }>
  /** A newest-first page (by observedAt, then id) of one Prospect's Signals, at most `limit`. */
  list: (
    organizationId: OrganizationId,
    prospectId: ProspectId,
    filter: {
      kind?: SignalKind | undefined
      /** Only Signals that expire after this instant; null for all. */
      expiresAfter: string | null
      after: SignalPosition | null
      limit: number
    }
  ) => Promise<{ items: StoredSignal[]; next: SignalPosition | null }>
  /** One Signal, or null. */
  get: (organizationId: OrganizationId, signalId: SignalId) => Promise<StoredSignal | null>
}
