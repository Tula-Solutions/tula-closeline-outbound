import type { Clock } from 'tula-closeline-kit'
import type { CampaignStore } from '~/ports/campaign-store'
import type { CoreAccess } from '~/ports/core'

/** What the campaign module needs from outside the process; a service function takes this first. */
export type CampaignDeps = {
  store: CampaignStore
  /** Who the caller is as a Membership, and which Reps are on a Manager's Team. */
  access: CoreAccess
  clock: Clock
}
