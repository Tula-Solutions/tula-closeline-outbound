import type {
  CampaignId,
  Enrollment,
  EnrollmentEvent,
  EnrollmentId,
  EnrollmentStopReason,
  MembershipId,
  OrganizationId,
  ProspectId,
} from 'tula-closeline-contract'

/** Which Enrollments of a Campaign a list may return. */
export type EnrollmentFilter = {
  state?: Enrollment['state'] | undefined
  stopReason?: EnrollmentStopReason | undefined
  prospectId?: ProspectId | undefined
}

/** Where a newest-first page of Enrollments resumes: after this enrolment time and id. */
export type EnrollmentPosition = { enrolledAt: string; id: EnrollmentId }

/** Where a newest-first page of an Enrollment's log resumes: after this time and id. */
export type ActivityPosition = { occurredAt: string; id: EnrollmentEvent['id'] }

/** One page of a newest-first list; `next` is set when more follow. */
export type Paged<Item, Position> = { items: Item[]; next: Position | null }

/** Where an Enrollment goes next: another (or the same) Step at a time, or to the end. */
export type Transition =
  | {
      state: 'active'
      currentStepKey: string
      currentStep: number
      attemptEpoch: number
      nextDueAt: string
    }
  | { state: 'completed'; at: string }

/** What happened to the sends of one variant: the raw counts behind a variant's results. */
export type VariantCount = {
  variantKey: string
  sent: number
  replied: number
  bounced: number
  unsubscribed: number
}

/** The store of Enrollments and their logs; every call is scoped to one Organization. */
export type EnrollmentStore = {
  /**
   * Writes the Enrollment and its log entries unless this Campaign already holds the Prospect (in
   * any state); returns what is stored and whether it was written now. Never a second row.
   */
  insertIfAbsent: (
    organizationId: OrganizationId,
    enrollment: Enrollment,
    events: readonly EnrollmentEvent[]
  ) => Promise<{ enrollment: Enrollment; created: boolean }>
  /** The Enrollment, or null when the Organization has none with this id. */
  find: (organizationId: OrganizationId, id: EnrollmentId) => Promise<Enrollment | null>
  /** The Prospect's Enrollment in the Campaign, or null. */
  findByProspect: (
    organizationId: OrganizationId,
    campaignId: CampaignId,
    prospectId: ProspectId
  ) => Promise<Enrollment | null>
  /** A newest-first page of at most `limit` Enrollments of a Campaign, resuming after `after`. */
  list: (
    organizationId: OrganizationId,
    campaignId: CampaignId,
    filter: EnrollmentFilter,
    after: EnrollmentPosition | null,
    limit: number
  ) => Promise<Paged<Enrollment, EnrollmentPosition>>
  /** A newest-first page of at most `limit` log entries of an Enrollment. */
  activity: (
    organizationId: OrganizationId,
    enrollmentId: EnrollmentId,
    after: ActivityPosition | null,
    limit: number
  ) => Promise<Paged<EnrollmentEvent, ActivityPosition>>
  /**
   * Stops an active Enrollment and logs it, holding the row so two stops never interleave.
   * `stopped` is false when it had already ended (nothing is written). Null when it is not there.
   */
  stop: (
    organizationId: OrganizationId,
    id: EnrollmentId,
    reason: EnrollmentStopReason,
    at: string,
    actor: MembershipId | null
  ) => Promise<{ enrollment: Enrollment; stopped: boolean } | null>
  /** Of these Prospects, the ones with an active Enrollment in a Campaign other than this one. */
  activeElsewhere: (
    organizationId: OrganizationId,
    campaignId: CampaignId,
    prospectIds: readonly ProspectId[]
  ) => Promise<Set<ProspectId>>
  /**
   * Organizations that have an active Enrollment due, in id order after `after`, at most `batch`;
   * `next` resumes the walk and is null when none were visited. Runs outside any Organization's scope.
   */
  dueOrganizations: (
    after: string | null,
    batch: number,
    now: string
  ) => Promise<{ organizationIds: OrganizationId[]; next: string | null }>
  /**
   * Takes up to `limit` active Enrollments due at `now`, oldest due first, skipping rows another
   * sweep holds, and moves their due time to `leaseUntil` so no other sweep takes them until then.
   */
  claimDue: (
    organizationId: OrganizationId,
    now: string,
    leaseUntil: string,
    limit: number
  ) => Promise<Enrollment[]>
  /**
   * Moves an active Enrollment that is still at `expect` (Step and attempt) to `to` and appends
   * `events`, holding the row. Null when it has ended or moved on, so a repeat writes nothing.
   */
  advance: (
    organizationId: OrganizationId,
    id: EnrollmentId,
    expect: { stepKey: string; attemptEpoch: number },
    to: Transition,
    events: readonly EnrollmentEvent[]
  ) => Promise<Enrollment | null>
  /** At most `limit` active Enrollments of a Prospect, across Campaigns. */
  activeOfProspect: (
    organizationId: OrganizationId,
    prospectId: ProspectId,
    limit: number
  ) => Promise<Enrollment[]>
  /** When the latest log entry of this kind was written, or null. */
  lastEventAt: (
    organizationId: OrganizationId,
    id: EnrollmentId,
    kind: EnrollmentEvent['kind']
  ) => Promise<string | null>
  /**
   * Per variant of an email Step: the sends, and how many of those Prospects then replied,
   * bounced or unsubscribed (a stop is credited to the variant of the Prospect's latest send,
   * and only when that send was this Step's). Only variants with a send appear.
   */
  variantCounts: (
    organizationId: OrganizationId,
    campaignId: CampaignId,
    stepKey: string
  ) => Promise<VariantCount[]>
}
