import type { Clock, ContactGuard, Logger, Queue } from 'tula-closeline-kit'
import type { OutboundEnvelope } from '~/messages'
import type { AudienceCheckStore, CoreAudience } from '~/ports/audience'
import type { CampaignStore } from '~/ports/campaign-store'
import type { CoreAccess } from '~/ports/core'
import type { EnrollmentStore } from '~/ports/enrollment-store'

/** What the campaign module needs from outside the process; a service function takes this first. */
export type CampaignDeps = {
  store: CampaignStore
  /** Who the caller is as a Membership, and which Reps are on a Manager's Team. */
  access: CoreAccess
  clock: Clock
  enrollments: EnrollmentStore
  /** The latest audience check of each Campaign. */
  checks: AudienceCheckStore
  /** Reads an audience from core a page at a time. */
  audience: CoreAudience
  /** The Contact Check; fails closed, and nothing here can turn it off (ADR 0003). */
  guard: ContactGuard
  /** Carries the pages of an audience check. */
  queue: Queue<OutboundEnvelope>
  logger: Logger
}
