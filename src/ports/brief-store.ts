import type { BriefId, OrganizationId, ProspectId, ResearchBrief } from 'tula-closeline-contract'

/** A Research Brief with the fingerprint of the input it was built from (the Prospect's values and fresh Signals). */
export type StoredBrief = { brief: ResearchBrief; fingerprint: string }

/** What building a Brief answered: the Brief, and whether this call made it. */
export type BriefOutcome = { brief: ResearchBrief; created: boolean }

/** The store of Research Briefs; every call is scoped to one Organization and a Brief never changes. */
export type BriefStore = {
  /** The newest Brief of a Prospect, or null. */
  newest: (organizationId: OrganizationId, prospectId: ProspectId) => Promise<StoredBrief | null>
  /**
   * Runs `build` at most once per Idempotency-Key: a concurrent or later call under the key gets the
   * same outcome; a failed build is not remembered. `reused` when the key was first used for a
   * different request (`requestHash`).
   */
  once: (
    organizationId: OrganizationId,
    key: string,
    requestHash: string,
    build: () => Promise<BriefOutcome>
  ) => Promise<BriefOutcome | 'reused'>
  /** Adds a Brief. */
  insert: (organizationId: OrganizationId, stored: StoredBrief) => Promise<void>
  /** One Brief, or null. */
  get: (organizationId: OrganizationId, briefId: BriefId) => Promise<ResearchBrief | null>
  /** A newest-first page of a Prospect's Briefs strictly after `after` in that order (from the start when null). */
  list: (
    organizationId: OrganizationId,
    prospectId: ProspectId,
    after: { createdAt: string; id: string } | null,
    limit: number
  ) => Promise<ResearchBrief[]>
}
