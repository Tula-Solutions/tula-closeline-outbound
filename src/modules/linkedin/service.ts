import {
  decodeCursor,
  ERRORS,
  type ErrorDefinition,
  encodeCursor,
  formatId,
  LINKEDIN_DAILY_CONNECTION_CEILING,
  LINKEDIN_DAILY_MESSAGE_CEILING,
  LINKEDIN_ERRORS,
  LINKEDIN_RISK_WORDING_VERSION,
  LINKEDIN_WEEKLY_CONNECTION_CEILING,
  type LinkedinAccount,
  type LinkedinAccountId,
  linkedinAccountIdSchema,
  linkedinAccountSchema,
  type MembershipId,
  type OrganizationId,
  type Role,
  type StartLinkedinConnectionResponse,
  type UserId,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { describeError } from '~/describe-error'
import { domainError } from '~/http/domain-error'
import { LinkedInProviderError } from '~/ports/linkedin-provider'
import type { LinkedinAccountRecord, LinkedinAccountStatus } from '~/ports/linkedin-store'
import type { LinkedinDeps } from './deps'

/** The largest page a list may ask for. */
export const MAX_PAGE = 100

/** Who is calling, as the verified token says. */
export type LinkedinCaller = { userId: UserId; organizationId: OrganizationId; role: Role }

const cursorSchema = z.strictObject({
  connectedAt: z.iso.datetime(),
  id: linkedinAccountIdSchema,
})

function linkedinError(code: keyof typeof LINKEDIN_ERRORS) {
  return domainError(LINKEDIN_ERRORS[code] as ErrorDefinition)
}

/** A record as the response shows it; the schema drops the provider's reference and anything else it does not name. */
function present(record: LinkedinAccountRecord): LinkedinAccount {
  const { providerAccountId: _reference, ...visible } = record
  return linkedinAccountSchema.parse(visible)
}

type View = { me: MembershipId; owners: readonly MembershipId[] | undefined }

async function viewOf(deps: LinkedinDeps, caller: LinkedinCaller): Promise<View> {
  const me = await deps.access.membershipIdOf(caller.organizationId, caller.userId)
  if (caller.role === 'owner' || caller.role === 'admin') {
    return { me, owners: undefined }
  }
  if (caller.role === 'manager') {
    const reps = await deps.access.teamRepIds(caller.organizationId, caller.userId)
    const memberships = await Promise.all(
      reps.map((rep) => deps.access.membershipIdOf(caller.organizationId, rep))
    )
    return { me, owners: [me, ...memberships] }
  }
  return { me, owners: [me] }
}

/** Starts the calling Rep's connection: answers the hosted login; a repeat under the same key answers the same one. */
export async function startConnection(
  deps: LinkedinDeps,
  caller: LinkedinCaller,
  idempotencyKey: string
): Promise<StartLinkedinConnectionResponse> {
  const channel = await deps.store.channelState(
    caller.organizationId,
    LINKEDIN_RISK_WORDING_VERSION
  )
  if (!channel.enabled) {
    throw linkedinError('linkedin.channel_disabled')
  }
  if (!channel.accepted) {
    throw linkedinError('linkedin.risk_not_accepted')
  }
  if (deps.provider === null) {
    throw domainError(ERRORS['server.unavailable'])
  }
  const membershipId = await deps.access.membershipIdOf(caller.organizationId, caller.userId)
  try {
    return await deps.provider.startConnection({
      organizationId: caller.organizationId,
      membershipId,
      idempotencyKey,
    })
  } catch (error) {
    if (error instanceof LinkedInProviderError) {
      deps.logger.warn('linkedin.provider_failed', { reason: error.reason })
      throw domainError(ERRORS['server.unavailable'])
    }
    throw error
  }
}

/**
 * Records that a Rep finished the hosted login: reads the account at the provider and stores it
 * under the Rep's Membership (a reconnect reuses the row and its limits). The webhook that tells us
 * the login finished calls this; the reference is stored and never logged or returned.
 */
export async function completeConnection(
  deps: LinkedinDeps,
  organizationId: OrganizationId,
  membershipId: MembershipId,
  accountRef: string
): Promise<LinkedinAccount> {
  if (deps.provider === null) {
    throw domainError(ERRORS['server.unavailable'])
  }
  let status: LinkedinAccountStatus
  try {
    const read = await deps.provider.readAccount(accountRef)
    status = read.status
  } catch (error) {
    if (error instanceof LinkedInProviderError) {
      deps.logger.warn('linkedin.provider_failed', { reason: error.reason })
      throw domainError(ERRORS['server.unavailable'])
    }
    throw error
  }
  const now = deps.clock.now().toISOString()
  const record = await deps.store.connect(organizationId, {
    id: formatId('lia', crypto.randomUUID()) as LinkedinAccountId,
    membershipId,
    providerAccountId: accountRef,
    status,
    pauseReason: null,
    limits: {
      dailyConnections: LINKEDIN_DAILY_CONNECTION_CEILING,
      dailyMessages: LINKEDIN_DAILY_MESSAGE_CEILING,
      weeklyConnections: LINKEDIN_WEEKLY_CONNECTION_CEILING,
    },
    connectedAt: now,
    updatedAt: now,
  })
  deps.logger.info('linkedin.account_connected', {
    organizationId,
    accountId: record.id,
    status: record.status,
  })
  return present(record)
}

/** Lists the accounts the caller may see, newest connection first. */
export async function list(
  deps: LinkedinDeps,
  caller: LinkedinCaller,
  query: { cursor?: string | undefined; limit: number }
): Promise<{ items: LinkedinAccount[]; nextCursor: string | null }> {
  let after = null
  if (query.cursor !== undefined) {
    const position = decodeCursor(query.cursor, cursorSchema)
    if (position === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    after = position
  }
  const view = await viewOf(deps, caller)
  const page = await deps.store.list(
    caller.organizationId,
    view.owners,
    after,
    Math.min(query.limit, MAX_PAGE)
  )
  return {
    items: page.items.map(present),
    nextCursor: page.next === null ? null : encodeCursor(page.next),
  }
}

/** One account if the caller may see it; otherwise `request.not_found`. */
export async function get(
  deps: LinkedinDeps,
  caller: LinkedinCaller,
  id: LinkedinAccountId
): Promise<LinkedinAccount> {
  const view = await viewOf(deps, caller)
  const record = await deps.store.find(caller.organizationId, id)
  if (
    record === null ||
    (view.owners !== undefined && !view.owners.includes(record.membershipId))
  ) {
    throw domainError(ERRORS['request.not_found'])
  }
  return present(record)
}

/**
 * Disconnects an account. The owning Rep may, and an Owner or Admin may remove a leaver's; any
 * other caller is `linkedin.not_account_owner`. An account of another Organization is
 * `request.not_found`. Disconnecting a disconnected account changes nothing.
 */
export async function disconnect(
  deps: LinkedinDeps,
  caller: LinkedinCaller,
  id: LinkedinAccountId
): Promise<void> {
  const me = await deps.access.membershipIdOf(caller.organizationId, caller.userId)
  const record = await deps.store.find(caller.organizationId, id)
  if (record === null) {
    throw domainError(ERRORS['request.not_found'])
  }
  const mayAll = caller.role === 'owner' || caller.role === 'admin'
  if (!mayAll && record.membershipId !== me) {
    throw linkedinError('linkedin.not_account_owner')
  }
  const result = await deps.store.disconnect(
    caller.organizationId,
    id,
    deps.clock.now().toISOString()
  )
  if (result === null) {
    throw domainError(ERRORS['request.not_found'])
  }
  if (!result.changed) {
    return
  }
  // The row is already disconnected, so nothing sends; a provider failure here only leaves its copy to expire.
  try {
    await deps.provider?.disconnect(record.providerAccountId)
  } catch (error) {
    deps.logger.warn('linkedin.provider_disconnect_failed', {
      organizationId: caller.organizationId,
      accountId: id,
      error: describeError(error),
    })
  }
  deps.logger.info('linkedin.account_disconnected', {
    organizationId: caller.organizationId,
    accountId: id,
  })
}
