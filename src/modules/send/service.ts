import {
  type CampaignId,
  type DraftId,
  formatId,
  MAIL_ERRORS,
  type MailboxId,
  type OrganizationId,
  type ProspectId,
  type SendKey,
  type SendRefusalReason,
  sendKeyToString,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import { domainError } from '~/http/domain-error'
import * as Mailboxes from '~/modules/mailbox/service'
import type { MailboxRecord } from '~/ports/mailbox-store'
import type { CheckResults, NewSend, StoredSend } from '~/ports/send-store'
import type { SendDeps } from './deps'
import { bucketsOf } from './limits'
import { signUnsubscribe, UNSUBSCRIBE_TTL_SECONDS, unsubscribeUrl } from './unsubscribe'
import { isOpen, nextOpen } from './window'

/** How long a `sending` row may sit before {@link reconcile} settles it. */
export const STALE_SENDING_SECONDS = 600

/** The most rows one {@link reconcile} call settles. */
export const RECONCILE_BATCH = 100

const PROVIDER_MESSAGE_ID = /^[!-~]{1,255}$/
const MAX_THREAD_ID = 2048

/** One message to send, with everything the decision needs already resolved by the caller. */
export type SendRequest = {
  campaignId: CampaignId
  prospectId: ProspectId
  /** The Enrollment, step and attempt: one key is one decision, forever. */
  key: SendKey
  draftId?: DraftId | undefined
  recipient: { email: string; verified: boolean }
  /** Send to an address that was not verified (the Campaign allows it). */
  acceptUnverified: boolean
  /** The Prospect's own zone, read when the Campaign's window follows the Prospect. */
  prospectTimeZone?: string | undefined
  /** The Mailboxes the sender may use; the pipeline picks one. */
  mailboxIds: readonly MailboxId[]
  message: { subject: string; text: string; inReplyTo?: string | undefined }
}

/** The error code a refusal or deferral answers with, for a caller that surfaces it. */
export const REASON_CODES = {
  campaign_not_running: 'send.campaign_not_running',
  outside_window: 'send.outside_window',
  unverified_address: 'send.unverified_address',
  suppressed: 'send.suppressed',
  no_consent: 'send.no_consent',
  mailbox_unavailable: 'mailbox.not_connected',
  limit_reached: 'mailbox.limit_reached',
  organization_cap_reached: 'send.organization_cap_reached',
  duplicate: 'send.duplicate',
} as const satisfies Record<SendRefusalReason, keyof typeof MAIL_ERRORS>

/** The AppError of a refused or deferred decision. */
export function errorOf(reason: SendRefusalReason): AppError {
  return domainError(MAIL_ERRORS[REASON_CODES[reason]])
}

const LIMIT_REASONS = { organization_daily_cap: 'organization_cap_reached' } as const

type Plan = { mailbox: MailboxRecord; today: number; lastAt: string | null }

function isUnknownOutcome(error: unknown) {
  // A timeout, a 5xx or a dropped connection may follow a provider accept, so none may send again.
  return (
    error instanceof AppError &&
    (error.code === 'server.timeout' || error.code === 'server.unavailable')
  )
}

/**
 * Decides and, when every check passes, sends one message. Every decision is stored under its key
 * before anything leaves, so a replay changes nothing: a settled key throws `send.duplicate`, a
 * deferred one is decided again. Returns the stored record (`sent`, `refused` or `deferred`); a
 * provider failure throws after the row is settled (`failed`, or left `sending` when the outcome
 * is unknown, which {@link reconcile} settles without ever sending again).
 */
export async function send(
  deps: SendDeps,
  organizationId: OrganizationId,
  request: SendRequest
): Promise<StoredSend> {
  const key = sendKeyToString(request.key)
  const existing = await deps.store.find(organizationId, key)
  if (existing !== null && existing.state !== 'deferred') {
    throw domainError(MAIL_ERRORS['send.duplicate'])
  }
  const campaign = await deps.campaigns.find(organizationId, request.campaignId)
  if (campaign === null) {
    throw domainError(MAIL_ERRORS['send.not_found'])
  }
  const now = deps.clock.now()
  const checks: CheckResults = []
  const base = {
    id: existing?.id ?? formatId('snd', crypto.randomUUID()),
    key,
    campaignId: request.campaignId,
    enrollmentId: request.key.enrollmentId,
    prospectId: request.prospectId,
    draftId: request.draftId ?? null,
    step: request.key.step,
    attemptEpoch: request.key.attemptEpoch,
    decidedAt: now.toISOString(),
  }
  const stop = async (
    state: 'refused' | 'deferred',
    reason: SendRefusalReason,
    retryAt: Date | null = null
  ) => {
    const result = await deps.store.record(organizationId, {
      ...base,
      mailboxId: null,
      state,
      reason,
      checks: [...checks],
      retryAt: retryAt?.toISOString() ?? null,
    })
    if (result.kind === 'exists') {
      throw domainError(MAIL_ERRORS['send.duplicate'])
    }
    return result.send
  }
  const pass = (check: CheckResults[number]['check'], passed: boolean) => {
    checks.push({ check, passed })
    return passed
  }

  if (!pass('campaign', campaign.state === 'running')) {
    return stop('refused', 'campaign_not_running')
  }
  const zone =
    campaign.windowZone === 'prospect' && request.prospectTimeZone !== undefined
      ? request.prospectTimeZone
      : campaign.sendWindow.timeZone
  const window = { ...campaign.sendWindow, timeZone: zone }
  if (!pass('window', isOpen(window, now))) {
    return stop('deferred', 'outside_window', nextOpen(window, now))
  }
  if (!pass('address', request.recipient.verified || request.acceptUnverified)) {
    return stop('refused', 'unverified_address')
  }
  const verdict = await deps.guard.check({
    organizationId,
    prospectId: request.prospectId,
    channel: 'email',
    purpose: 'agent_initiated',
  })
  const suppressed = !verdict.allowed && verdict.code === 'consent.suppressed'
  if (!pass('suppression', !suppressed)) {
    return stop('refused', 'suppressed')
  }
  if (!pass('consent', verdict.allowed)) {
    return stop('refused', 'no_consent')
  }

  const plan = await planMailboxes(deps, organizationId, request, now)
  if (!pass('mailbox', plan.usable.length > 0)) {
    return stop('refused', 'mailbox_unavailable')
  }
  const open = plan.usable.filter((p) => isOpen(p.mailbox.limits.window, now))
  if (open.length === 0) {
    pass('limits', false)
    const soonest = Math.min(
      ...plan.usable.map((p) => nextOpen(p.mailbox.limits.window, now).getTime())
    )
    return stop('deferred', 'outside_window', new Date(soonest))
  }

  const { dayStart, hourStart, nextHour, nextDay } = bucketsOf(now)
  let retryAt = null as Date | null
  for (const { mailbox } of open) {
    const { effective } = Mailboxes.effectiveLimitsOf(mailbox, now)
    const claim: NewSend = {
      ...base,
      mailboxId: mailbox.id,
      state: 'sending',
      reason: null,
      retryAt: null,
      checks: [],
    }
    const result = await deps.store.reserve(
      organizationId,
      {
        ...claim,
        checks: [
          ...checks,
          { check: 'limits', passed: true },
          { check: 'organization_cap', passed: true },
          { check: 'idempotency', passed: true },
        ],
      },
      {
        mailboxId: mailbox.id,
        perDay: effective.perDay,
        perHour: effective.perHour,
        minGapSeconds: effective.minGapSeconds,
        dayStart: dayStart.toISOString(),
        hourStart: hourStart.toISOString(),
        now: now.toISOString(),
        organizationDailyCap: deps.organizationDailyCap,
      }
    )
    if (result.kind === 'exists') {
      throw domainError(MAIL_ERRORS['send.duplicate'])
    }
    if (result.kind === 'reserved') {
      return deliver(deps, organizationId, request, mailbox, result.send, plan.threadId)
    }
    if (result.limit === 'organization_daily_cap') {
      pass('limits', true)
      pass('organization_cap', false)
      return stop('deferred', LIMIT_REASONS[result.limit], nextDay)
    }
    const gapEnds =
      result.lastAt === null
        ? now
        : new Date(Date.parse(result.lastAt) + effective.minGapSeconds * 1000)
    const free =
      result.limit === 'min_gap' ? gapEnds : result.limit === 'per_hour' ? nextHour : nextDay
    const when = nextOpen(mailbox.limits.window, free)
    retryAt = retryAt === null || when < retryAt ? when : retryAt
  }
  pass('limits', false)
  return stop('deferred', 'limit_reached', retryAt ?? nextHour)
}

/** The usable Mailboxes in fair order (fewest sent today, then longest idle), or just the sticky one. */
async function planMailboxes(
  deps: SendDeps,
  organizationId: OrganizationId,
  request: SendRequest,
  now: Date
): Promise<{ usable: Plan[]; threadId: string | undefined }> {
  const records = (
    await Promise.all(request.mailboxIds.map((id) => deps.mailboxes.store.find(organizationId, id)))
  ).filter(
    (record): record is MailboxRecord =>
      record !== null && !Mailboxes.effectiveLimitsOf(record, now).stopped
  )
  const previous = await deps.store.lastOfEnrollment(organizationId, request.key.enrollmentId)
  const sticky = records.find((r) => r.id === previous?.mailboxId)
  // A follow-up goes out from the Mailbox that sent the first message, so the thread stays whole.
  // If that Mailbox is gone or stopped, nothing is sent: another Mailbox would split the thread.
  const chosen = previous === null ? records : sticky === undefined ? [] : [sticky]
  const { dayStart, hourStart } = bucketsOf(now)
  const usage = await deps.store.usage(
    organizationId,
    chosen.map((r) => r.id),
    dayStart.toISOString(),
    hourStart.toISOString()
  )
  const usable = chosen
    .map((mailbox) => ({
      mailbox,
      today: usage.mailboxes[mailbox.id]?.today ?? 0,
      lastAt: usage.mailboxes[mailbox.id]?.lastAt ?? null,
    }))
    .sort(
      (a, b) =>
        a.today - b.today ||
        (a.lastAt ?? '').localeCompare(b.lastAt ?? '') ||
        a.mailbox.id.localeCompare(b.mailbox.id)
    )
  return {
    usable,
    threadId: sticky === undefined ? undefined : (previous?.providerThreadId ?? undefined),
  }
}

/** Sends through the reserved Mailbox and settles the row; the only place a message leaves. */
async function deliver(
  deps: SendDeps,
  organizationId: OrganizationId,
  request: SendRequest,
  mailbox: MailboxRecord,
  reserved: StoredSend,
  threadId: string | undefined
): Promise<StoredSend> {
  const token = signUnsubscribe(deps.unsubscribe.secret, {
    organizationId,
    prospectId: request.prospectId,
    campaignId: request.campaignId,
    expiresAt: Math.floor(deps.clock.now().getTime() / 1000) + UNSUBSCRIBE_TTL_SECONDS,
  })
  const link = unsubscribeUrl(deps.unsubscribe.url, token)
  let sent: Awaited<ReturnType<typeof Mailboxes.sendThrough>>
  try {
    sent = await Mailboxes.sendThrough(deps.mailboxes, organizationId, mailbox.id, {
      from: { address: mailbox.address, name: mailbox.displayName },
      to: request.recipient.email,
      subject: request.message.subject,
      text: `${request.message.text}\n\n--\nTo stop these emails: ${link}`,
      headers: {
        'List-Unsubscribe': `<${link}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      ...(threadId === undefined ? {} : { threadId }),
      ...(request.message.inReplyTo === undefined ? {} : { inReplyTo: request.message.inReplyTo }),
    })
  } catch (error) {
    if (isUnknownOutcome(error)) {
      // The provider may have sent it: leave the row `sending` so it counts, and never send again.
      deps.logger.warn('send.unknown_outcome', { sendId: reserved.id })
      throw error
    }
    await deps.store
      .settle(organizationId, reserved.id, { state: 'failed', at: deps.clock.now().toISOString() })
      .catch(() => undefined)
    throw error
  }
  // The mail is out. If this write fails the row stays `sending` and reconcile settles it.
  const settled = await deps.store.settle(organizationId, reserved.id, {
    state: 'sent',
    at: deps.clock.now().toISOString(),
    providerMessageId: PROVIDER_MESSAGE_ID.test(sent.providerMessageId)
      ? sent.providerMessageId
      : null,
    providerThreadId:
      sent.threadId.length >= 1 && sent.threadId.length <= MAX_THREAD_ID ? sent.threadId : null,
  })
  return settled ?? reserved
}

/**
 * Settles one batch of `sending` rows older than {@link STALE_SENDING_SECONDS} as sent. The
 * provider has no lookup, so this assumes the mail left (never sends again) and says so in the
 * log. Returns how many rows it settled; call again while it returns {@link RECONCILE_BATCH}.
 */
export async function reconcile(deps: SendDeps, organizationId: OrganizationId): Promise<number> {
  const now = deps.clock.now()
  const before = new Date(now.getTime() - STALE_SENDING_SECONDS * 1000).toISOString()
  const stale = await deps.store.listStale(organizationId, before, RECONCILE_BATCH)
  let settled = 0
  for (const row of stale) {
    const done = await deps.store.settle(organizationId, row.id, {
      state: 'sent',
      at: row.decidedAt,
      providerMessageId: null,
      providerThreadId: null,
    })
    if (done !== null) {
      settled += 1
      deps.logger.warn('send.reconciled_unknown_outcome', { sendId: row.id })
    }
  }
  return settled
}
