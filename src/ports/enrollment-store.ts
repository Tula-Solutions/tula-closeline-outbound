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
}
