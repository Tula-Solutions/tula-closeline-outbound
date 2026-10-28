import type {
  APPROVAL_REASONS,
  CampaignId,
  DraftId,
  EnrollmentId,
  OrganizationId,
  OutreachDraft,
  ProspectId,
} from 'tula-closeline-contract'

/** Why a Draft needs a person's approval before it goes. */
export type ApprovalReason = (typeof APPROVAL_REASONS)[number]

/** Where the engine gets the message of an email Step (draft generation lives in the drafting module). */
export type DraftSource = {
  /** The Draft for this Prospect, Campaign and Step; the same one for a repeat of the same Step. */
  obtain: (
    organizationId: OrganizationId,
    request: { prospectId: ProspectId; campaignId: CampaignId; stepKey: string; goal: string }
  ) => Promise<OutreachDraft>
}

/** Where a Draft that a Rep must look at goes before it may be sent (the approvals module). */
export type Approvals = {
  /** Puts the Draft in front of a Rep with the reasons; asking again for the same Step changes nothing. */
  request: (
    organizationId: OrganizationId,
    approval: {
      draftId: DraftId
      enrollmentId: EnrollmentId
      prospectId: ProspectId
      campaignId: CampaignId
      stepKey: string
      reasons: readonly ApprovalReason[]
    }
  ) => Promise<void>
}

/** Who a Prospect is to the sender: the address, whether it was verified, and the time zone. */
export type ProspectContact = { email: string; verified: boolean; timeZone: string | null }

/** Reads the contact details of a Prospect for sending. */
export type ProspectContacts = {
  /** The Prospect's contact details, or null when it has no email address or is not there. */
  resolve: (
    organizationId: OrganizationId,
    prospectId: ProspectId
  ) => Promise<ProspectContact | null>
}
