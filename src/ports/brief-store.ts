import type { BriefId, OrganizationId, ProspectId, ResearchBrief } from 'tula-closeline-contract'

/** What building a Brief answered: the Brief, and whether this call made it. */
export type BriefOutcome = { brief: ResearchBrief; created: boolean }

/** The store of Research Briefs; every call is scoped to one Organization and a Brief never changes. */
export type BriefStore = {
  /** The newest Brief of a Prospect, or null. */
  newest: (organizationId: OrganizationId, prospectId: ProspectId) => Promise<ResearchBrief | null>
  /** The Brief built under an Idempotency-Key, or null when the key has built none. */
  byRequestKey: (organizationId: OrganizationId, key: string) => Promise<ResearchBrief | null>
  /**
   * Adds a Brief under its Idempotency-Key. Two requests racing on one key cannot both win: the loser
   * gets the winner's Brief with `created` false and its own is dropped.
   */
  insert: (
    organizationId: OrganizationId,
    brief: ResearchBrief,
    requestKey: string
  ) => Promise<BriefOutcome>
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
