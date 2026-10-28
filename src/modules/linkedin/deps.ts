import type { LinkedinAccountId, MembershipId, OrganizationId } from 'tula-closeline-contract'
import {
  type Clock,
  type ContactGuard,
  type Logger,
  type Sleep,
  systemSleep,
} from 'tula-closeline-kit'
import type { CoreAccess } from '~/ports/core'
import type { LinkedInProvider } from '~/ports/linkedin-provider'
import type { LinkedinStore } from '~/ports/linkedin-store'
import type { SendWindow } from './pacing'

/** The `linkedin.channel_disabled` v1 payload: the channel stopped, why, and which Admin did it. */
export type LinkedinChannelDisabled = {
  reason: 'admin_switch' | 'acceptance_revoked'
  byMembershipId: MembershipId
  at: string
}

/** The `linkedin.account_paused` v1 payload: the account stopped sending, and why. Ids and values only. */
export type LinkedinAccountPaused = {
  accountId: LinkedinAccountId
  membershipId: MembershipId
  status: 'paused' | 'restricted'
  reason: 'checkpoint' | 'rate_limited' | 'restricted'
}

/** How sends are paced and how the provider is called. */
export type LinkedinSendSettings = {
  /** One UTC window for every account (shortcut: per-Rep working hours when they are exposed). */
  window: SendWindow
  /** The least time between two sends of one account; each wait is jittered. */
  minGapMs: number
  /** The most a send is pushed past the opening of the window or the gap, so accounts do not move together. */
  jitterMs: number
  /** The bound on one provider call. */
  providerTimeoutMs: number
  /** The most provider calls for one send, the first included. */
  providerMaxTries: number
  /** The base of the pause before a retry; each pause is jittered. */
  retryBaseMs: number
  sleep: Sleep
  /** A number in `[0, 1)`. */
  random: () => number
}

/** The pacing and provider-call defaults. */
export function defaultSendSettings(
  overrides: Partial<LinkedinSendSettings> = {}
): LinkedinSendSettings {
  return {
    window: { startHour: 9, endHour: 17 },
    minGapMs: 60_000,
    jitterMs: 1_800_000,
    providerTimeoutMs: 10_000,
    providerMaxTries: 3,
    retryBaseMs: 500,
    sleep: systemSleep,
    random: Math.random,
    ...overrides,
  }
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
  /** The Contact Check; a send job asks it before any quota is used. */
  guard: ContactGuard
  /** Publishes `linkedin.account_paused` when a provider result stops one account. */
  accountPaused: (organizationId: OrganizationId, event: LinkedinAccountPaused) => Promise<void>
  send: LinkedinSendSettings
  logger: Logger
}
