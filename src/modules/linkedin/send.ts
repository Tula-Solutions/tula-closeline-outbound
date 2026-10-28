import type { LinkedinAccountId, OrganizationId, ProspectId } from 'tula-closeline-contract'
import { ERRORS } from 'tula-closeline-contract'
import { domainError } from '~/http/domain-error'
import { LinkedInProviderError, type SendOutcome } from '~/ports/linkedin-provider'
import type { LinkedinDeps } from './deps'
import {
  dayOf,
  inWindow,
  nextDayStart,
  nextWeekStart,
  nextWindowStart,
  weekStartOf,
} from './pacing'
import { assertChannelOpen, linkedinError } from './service'

/** One LinkedIn send job: the Prospect, what to send, and the key that makes a retry send once. */
export type LinkedinSendInput = {
  organizationId: OrganizationId
  accountId: LinkedinAccountId
  prospectId: ProspectId
  kind: 'connection' | 'message'
  /** Names this send for good: a retried job carries the same key and never sends twice. */
  sendKey: string
  /** The recipient's reference at the provider; never logged. */
  recipient: string
  /** The note or message body; never logged. */
  text: string | null
}

/**
 * What a send job decided. `skipped` and `rejected` are final (the step is marked skipped or
 * failed); `deferred` is not dropped: run it again at `retryAt`; `unknown` means the provider did
 * not answer in time, so the send may or may not have happened and is never resent.
 */
export type LinkedinSendResult =
  | { outcome: 'sent' }
  | { outcome: 'duplicate'; state: 'sending' | 'sent' }
  | { outcome: 'skipped'; reason: 'suppressed' | 'no_consent' }
  | {
      outcome: 'deferred'
      reason: 'outside_window' | 'min_gap' | 'daily_limit' | 'weekly_limit'
      retryAt: string
    }
  | { outcome: 'paused'; reason: 'checkpoint' | 'rate_limited' | 'restricted' }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }

/** Calls `fn`, giving up on it after `ms`; the result of an abandoned call is not known. */
function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LinkedInProviderError('unknown')), ms)
  })
  return Promise.race([fn(), late]).finally(() => clearTimeout(timer))
}

/** The pause before retry number `attempt` (from 1): exponential, jittered to half to one and a half. */
function backoffMs(deps: LinkedinDeps, attempt: number): number {
  return deps.send.retryBaseMs * 2 ** (attempt - 1) * (0.5 + deps.send.random())
}

/**
 * Runs one send through the guard in the contract's order: channel open, account connected,
 * Contact Check (consent, then suppression), pacing, then the quota; only then the provider is
 * called, with a timeout and bounded jittered retries. Safe to run twice for one `sendKey`.
 */
export async function sendJob(
  deps: LinkedinDeps,
  input: LinkedinSendInput
): Promise<LinkedinSendResult> {
  const { organizationId, accountId } = input
  await assertChannelOpen(deps, organizationId)
  const account = await deps.store.find(organizationId, accountId)
  if (account === null) {
    throw domainError(ERRORS['request.not_found'])
  }
  if (account.status !== 'connected') {
    throw linkedinError('linkedin.account_not_connected')
  }
  const verdict = await deps.guard.check({
    organizationId,
    prospectId: input.prospectId,
    channel: 'linkedin',
    purpose: 'agent_initiated',
  })
  if (!verdict.allowed) {
    return {
      outcome: 'skipped',
      reason: verdict.code === 'consent.suppressed' ? 'suppressed' : 'no_consent',
    }
  }
  if (deps.provider === null) {
    throw domainError(ERRORS['server.unavailable'])
  }

  const now = deps.clock.now()
  const { window, jitterMs, random } = deps.send
  if (!inWindow(now, window)) {
    const retryAt = nextWindowStart(now, window, jitterMs, random).toISOString()
    return { outcome: 'deferred', reason: 'outside_window', retryAt }
  }
  // shortcut: the gap check reads the last reservation without a lock, so two jobs of one account
  // may both pass it; the quota below is still exact. Upgrade when the provider punishes bursts.
  const last = await deps.store.lastSendAt(organizationId, accountId)
  if (last !== null) {
    const wake = Date.parse(last) + deps.send.minGapMs * (0.5 + random())
    if (wake > now.getTime()) {
      return { outcome: 'deferred', reason: 'min_gap', retryAt: new Date(wake).toISOString() }
    }
  }

  const reserved = await deps.store.reserve(organizationId, {
    accountId,
    sendKey: input.sendKey,
    kind: input.kind,
    day: dayOf(now),
    weekStart: weekStartOf(now),
    at: now.toISOString(),
  })
  if (reserved.status === 'duplicate') {
    return { outcome: 'duplicate', state: reserved.state }
  }
  if (reserved.status === 'not_connected') {
    throw linkedinError('linkedin.account_not_connected')
  }
  if (reserved.status === 'over_limit') {
    const weekly = reserved.limit === 'weekly'
    const retryAt = (weekly ? nextWeekStart : nextDayStart)(now, window, jitterMs, random)
    return {
      outcome: 'deferred',
      reason: weekly ? 'weekly_limit' : 'daily_limit',
      retryAt: retryAt.toISOString(),
    }
  }

  let result: SendOutcome
  try {
    result = await callProvider(deps, deps.provider, account.providerAccountId, input)
  } catch (error) {
    if (!(error instanceof LinkedInProviderError) || error.reason === 'unknown') {
      // The send may have gone out: keep the reservation (it counts) and never resend.
      deps.logger.warn('linkedin.send_outcome_unknown', { organizationId, accountId })
      return { outcome: 'unknown' }
    }
    await deps.store.release(organizationId, input.sendKey)
    if (error.reason === 'rejected') {
      return { outcome: 'rejected' }
    }
    throw domainError(ERRORS['server.unavailable'])
  }

  if (result === 'sent') {
    await deps.store.markSent(organizationId, input.sendKey, deps.clock.now().toISOString())
    return { outcome: 'sent' }
  }
  await deps.store.release(organizationId, input.sendKey)
  const status = result === 'restricted' ? 'restricted' : 'paused'
  const paused = await deps.store.pause(
    organizationId,
    accountId,
    status,
    result,
    deps.clock.now().toISOString()
  )
  // Only the job that changed the account publishes, so concurrent restricted results say it once.
  if (paused !== null) {
    await deps.accountPaused(organizationId, {
      accountId,
      membershipId: paused.membershipId,
      status,
      reason: result,
    })
  }
  return { outcome: 'paused', reason: result }
}

/** One send with a timeout per call and bounded, jittered retries of calls that were not processed. */
async function callProvider(
  deps: LinkedinDeps,
  provider: NonNullable<LinkedinDeps['provider']>,
  accountRef: string,
  input: LinkedinSendInput
): Promise<SendOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(
        () =>
          provider.send({
            kind: input.kind,
            accountRef,
            recipient: input.recipient,
            text: input.text,
            idempotencyKey: input.sendKey,
          }),
        deps.send.providerTimeoutMs
      )
    } catch (error) {
      const retryable = error instanceof LinkedInProviderError && error.reason === 'unavailable'
      if (!retryable || attempt >= deps.send.providerMaxTries) {
        throw error
      }
      await deps.send.sleep(backoffMs(deps, attempt))
    }
  }
}
