import type { MembershipId, OrganizationId } from 'tula-closeline-contract'
import type { Clock, Logger } from 'tula-closeline-kit'
import type { CoreAccess } from '~/ports/core'
import type { LinkedInProvider } from '~/ports/linkedin-provider'
import type { LinkedinStore } from '~/ports/linkedin-store'

/** The `linkedin.channel_disabled` v1 payload: the channel stopped, why, and which Admin did it. */
export type LinkedinChannelDisabled = {
  reason: 'admin_switch' | 'acceptance_revoked'
  byMembershipId: MembershipId
  at: string
}

/** What the LinkedIn module needs from outside the process; a service function takes this first. */
export type LinkedinDeps = {
  store: LinkedinStore
  /** Who the caller is as a Membership, and which Reps are on a Manager's Team. */
  access: CoreAccess
  clock: Clock
  /** The LinkedIn provider; none is configured until a vendor adapter exists, and connecting answers `server.unavailable`. */
  provider: LinkedInProvider | null
  /** Publishes a domain event; the Organization is the one the event happened in. */
  events: (organizationId: OrganizationId, event: LinkedinChannelDisabled) => Promise<void>
  logger: Logger
}
