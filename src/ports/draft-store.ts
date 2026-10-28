import type { DraftId, OrganizationId, OutreachDraft } from 'tula-closeline-contract'

/** A Draft with the variant of its Campaign Step it was written for (null when none). */
export type StoredDraft = { draft: OutreachDraft; variantKey: string | null }

/** What writing a Draft answered: the Draft, its variant, and whether this call wrote it. */
export type DraftOutcome = StoredDraft & { created: boolean }

/** The store of Drafts with their Citations and checks; every call is scoped to one Organization. */
export type DraftStore = {
  /** One Draft, or null. */
  get: (organizationId: OrganizationId, draftId: DraftId) => Promise<OutreachDraft | null>
  /** The Draft written under an Idempotency-Key, or null when the key has written none. */
  byRequestKey: (organizationId: OrganizationId, key: string) => Promise<StoredDraft | null>
  /** The Draft when one of its latest regenerations ran under this key, or null. */
  regeneratedBy: (
    organizationId: OrganizationId,
    draftId: DraftId,
    key: string
  ) => Promise<OutreachDraft | null>
  /**
   * Adds a Draft under its Idempotency-Key. Two requests racing on one key cannot both win: the loser
   * gets the winner's Draft with `created` false; `reused` when the winner is a Draft of another Prospect.
   */
  insert: (
    organizationId: OrganizationId,
    draft: OutreachDraft,
    requestKey: string,
    variantKey: string | null
  ) => Promise<DraftOutcome | 'reused'>
  /**
   * Replaces a Draft's text, Citations and checks with `next`, whose revision must be the stored one plus
   * one, and records the key. A key among the latest regenerations answers the Draft as it is with
   * `created` false; `stale` when the revision moved, `missing` when there is no such Draft.
   */
  revise: (
    organizationId: OrganizationId,
    next: OutreachDraft,
    regenerateKey: string
  ) => Promise<DraftOutcome | 'stale' | 'missing'>
}
