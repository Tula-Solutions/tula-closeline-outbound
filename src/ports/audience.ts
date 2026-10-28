import type {
  Audience,
  AudienceCheck,
  AudienceCounts,
  CampaignId,
  OrganizationId,
  ProspectId,
  Role,
  UserId,
} from 'tula-closeline-contract'

/** Who an audience is read for: core shows the Prospects this person may see. */
export type AudienceViewer = { organizationId: OrganizationId; userId: UserId; role: Role }

/** One Prospect of an audience page: its id and whether its email address is verified. */
export type AudienceMember = { prospectId: ProspectId; emailVerified: boolean }

/** Reads an audience from core one bounded page at a time, so no call holds the whole list. */
export type CoreAudience = {
  /** At most `limit` members after the opaque cursor; `next` is null on the last page. */
  list: (
    viewer: AudienceViewer,
    audience: Audience,
    after: string | null,
    limit: number
  ) => Promise<{ items: AudienceMember[]; next: string | null }>
}

/** What a finished audience check recorded. */
export type CheckOutcome = { state: 'ready'; counts: AudienceCounts } | { state: 'failed' }

/** The latest audience check of each Campaign; every call is scoped to one Organization. */
export type AudienceCheckStore = {
  /**
   * Starts a check unless this key already started one or the latest is still pending for the same
   * audience version; returns that check and whether a new one was started.
   */
  start: (
    organizationId: OrganizationId,
    campaignId: CampaignId,
    audienceVersion: number,
    requestedAt: string,
    key: string
  ) => Promise<{ check: AudienceCheck; started: boolean }>
  /** The latest check, or null when none was started. */
  get: (organizationId: OrganizationId, campaignId: CampaignId) => Promise<AudienceCheck | null>
  /** Records the outcome of the check requested at `requestedAt`; ignored when a newer one began. */
  finish: (
    organizationId: OrganizationId,
    campaignId: CampaignId,
    requestedAt: string,
    outcome: CheckOutcome,
    at: string
  ) => Promise<void>
}
