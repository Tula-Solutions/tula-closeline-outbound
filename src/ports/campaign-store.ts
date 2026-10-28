import type {
  Campaign,
  CampaignId,
  MembershipId,
  OrganizationId,
  Sequence,
  Step,
  StepVariantResults,
  TeamId,
} from 'tula-closeline-contract'

/** Which Campaigns a list may return; every field narrows, none widens what the caller sees. */
export type CampaignFilter = {
  /** Only Campaigns owned by one of these; undefined means every owner (Owner and Admin). */
  visibleOwners?: readonly MembershipId[] | undefined
  state?: Campaign['state'] | undefined
  ownerMembershipId?: MembershipId | undefined
  teamId?: TeamId | undefined
}

/** Where a newest-first page resumes: after the Campaign with this creation time and id. */
export type CampaignPosition = { createdAt: string; id: CampaignId }

/** One page of Campaigns, newest first; `next` is set when more follow. */
export type CampaignPage = { items: Campaign[]; next: CampaignPosition | null }

/** What a Sequence change decides, given the Campaign and its current Sequence. */
export type SequenceDecision =
  | { kind: 'unchanged' }
  | {
      kind: 'save'
      /** The Campaign after the change; its `sequenceVersion` is the new version. */
      campaign: Campaign
      steps: readonly Step[]
      createdBy: MembershipId
    }

/** The winner chosen for the variants of a Step, how and when. */
export type Promotion = NonNullable<StepVariantResults['promotion']>

/** The store of Campaigns and their Sequence versions; every call is scoped to one Organization. */
export type CampaignStore = {
  /**
   * Writes the Campaign (and, when given, its first Sequence version, which is the Campaign's
   * `sequenceVersion`) unless one with that id exists; returns what is stored and whether it was
   * written now.
   */
  insertIfAbsent: (
    organizationId: OrganizationId,
    campaign: Campaign,
    steps: readonly Step[] | null,
    createdBy: MembershipId
  ) => Promise<{ campaign: Campaign; created: boolean }>
  /** The Campaign, or null when the Organization has none with this id. */
  find: (organizationId: OrganizationId, id: CampaignId) => Promise<Campaign | null>
  /** A newest-first page of at most `limit` Campaigns, resuming after `after`. */
  list: (
    organizationId: OrganizationId,
    filter: CampaignFilter,
    after: CampaignPosition | null,
    limit: number
  ) => Promise<CampaignPage>
  /**
   * Replaces the Campaign with what `change` returns while holding it, so two changes never
   * interleave. `change` is synchronous and may throw to refuse (nothing is written). Null when
   * the Campaign is not there.
   */
  modify: (
    organizationId: OrganizationId,
    id: CampaignId,
    change: (current: Campaign) => Campaign
  ) => Promise<Campaign | null>
  /** One saved version of the Sequence; null when it is not there (version 0 is never stored). */
  readSequence: (
    organizationId: OrganizationId,
    id: CampaignId,
    version: number
  ) => Promise<Sequence | null>
  /**
   * Holds the Campaign, shows `decide` its current Sequence, and writes the new version it asks
   * for together with the Campaign it returns, in one step. `decide` is synchronous and may throw
   * to refuse. Null when the Campaign is not there.
   */
  saveSequence: (
    organizationId: OrganizationId,
    id: CampaignId,
    decide: (campaign: Campaign, current: Sequence) => SequenceDecision
  ) => Promise<{ campaign: Campaign; sequence: Sequence } | null>
  /** The winner of the Step's test in this Sequence version, or null while none is chosen. */
  promotionOf: (
    organizationId: OrganizationId,
    id: CampaignId,
    version: number,
    stepKey: string
  ) => Promise<Promotion | null>
  /**
   * Records `promotion` as the winner of the Step's test unless one exists, holding the Step so
   * two promotions never interleave; returns the winner now stored and whether this call wrote it.
   * The caller has checked that the variant is part of the test.
   */
  promote: (
    organizationId: OrganizationId,
    id: CampaignId,
    version: number,
    stepKey: string,
    promotion: Promotion
  ) => Promise<{ promotion: Promotion; created: boolean }>
}
