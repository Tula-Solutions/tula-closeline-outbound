import type { BrandVoice, OrganizationId } from 'tula-closeline-contract'

/** What a save decides, given the Organization's current Brand Voice (null when none exists). */
export type BrandVoiceDecision = { kind: 'unchanged' } | { kind: 'save'; voice: BrandVoice }

/** One newest-first page of versions; `next` is the version to resume below, or null at the end. */
export type BrandVoicePage = { items: BrandVoice[]; next: number | null }

/** The store of an Organization's Brand Voice versions; every call is scoped to one Organization. */
export type BrandVoiceStore = {
  /** The newest version, or null when the Organization has none. */
  current: (organizationId: OrganizationId) => Promise<BrandVoice | null>
  /**
   * Holds the Organization's versions, shows `decide` the newest, and writes the version it asks
   * for in the same step, so two saves never interleave. `decide` is synchronous and may throw to
   * refuse (nothing is written). Returns the voice now current.
   */
  save: (
    organizationId: OrganizationId,
    decide: (current: BrandVoice | null) => BrandVoiceDecision
  ) => Promise<BrandVoice>
  /** A newest-first page of at most `limit` versions strictly below `before` (all when null). */
  list: (
    organizationId: OrganizationId,
    before: number | null,
    limit: number
  ) => Promise<BrandVoicePage>
}
