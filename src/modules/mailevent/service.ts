import { formatId, MAIL_ERRORS, type MailboxId, type OrganizationId } from 'tula-closeline-contract'
import { describeError } from '~/describe-error'
import { domainError } from '~/http/domain-error'
import * as Mailboxes from '~/modules/mailbox/service'
import type { InboundNotice } from '~/ports/mail-transport'
import type { StoredSend } from '~/ports/send-store'
import { verifyUnsubscribe } from '../send/unsubscribe'
import type { MailEventDeps } from './deps'

/** After this many soft bounces in one Enrollment the address counts as hard bounced: the bound on retrying. */
export const SOFT_BOUNCE_LIMIT = 3

/** Shown on the unsubscribe page until core can tell us the Organization's name. */
const SENDER_LABEL = 'the sender'

/** What ingesting one notice did. */
export type Ingested = 'handled' | 'duplicate' | 'ignored'

const ids = (send: StoredSend, mailboxId: MailboxId, providerMessageId: string) => ({
  mailboxId,
  prospectId: send.prospectId,
  sendId: send.id,
  campaignId: send.campaignId,
  enrollmentId: send.enrollmentId,
  providerMessageId,
})

/** The address core holds for the Prospect, or null. Never logged. */
async function emailOf(deps: MailEventDeps, organizationId: OrganizationId, send: StoredSend) {
  const input = await deps.prospects.getEnrichmentInput(organizationId, send.prospectId)
  return input?.values.email ?? null
}

/**
 * Acts on one inbox notice of a Mailbox. The notice must belong to a message we sent (found by its
 * thread), otherwise it is ignored. Every effect is idempotent and the event is logged last, so a
 * replay changes nothing and publishes nothing, and a crash midway is finished by the replay.
 */
export async function ingest(
  deps: MailEventDeps,
  organizationId: OrganizationId,
  mailboxId: MailboxId,
  notice: InboundNotice
): Promise<Ingested> {
  const send = await deps.sends.findByThread(organizationId, mailboxId, notice.threadId)
  if (send === null) {
    return 'ignored'
  }
  const at = notice.receivedAt
  let bounced: 'hard' | 'soft' | null = notice.kind === 'hard_bounce' ? 'hard' : null
  if (notice.kind === 'soft_bounce') {
    const earlier = await deps.log.countSoftBounces(
      organizationId,
      send.enrollmentId,
      notice.providerMessageId
    )
    bounced = earlier + 1 >= SOFT_BOUNCE_LIMIT ? 'hard' : 'soft'
  }
  const failure = notice.kind === 'complaint' ? 'complaint' : bounced === 'hard' ? 'bounce' : null
  const stopReason =
    notice.kind === 'complaint'
      ? 'complaint'
      : bounced === 'hard'
        ? 'hard_bounce'
        : notice.kind === 'reply'
          ? 'replied'
          : null

  if (failure !== null) {
    const email = await emailOf(deps, organizationId, send)
    if (email !== null) {
      await deps.suppression.recordDeliveryFailure(organizationId, {
        email,
        reason: failure,
        sourceRef: `${failure}:${notice.providerMessageId}`.slice(0, 200),
      })
    }
  }
  if (notice.kind === 'complaint') {
    await pauseForComplaint(deps, organizationId, mailboxId, at)
  }
  if (stopReason !== null) {
    await deps.enrollments.stop(organizationId, send.enrollmentId, stopReason, at, null)
  }

  const inserted = await deps.log.record(organizationId, {
    id: formatId('mev', crypto.randomUUID()),
    mailboxId,
    kind: notice.kind,
    sendId: send.id,
    prospectId: send.prospectId,
    enrollmentId: send.enrollmentId,
    providerMessageId: notice.providerMessageId,
    occurredAt: at,
  })
  if (!inserted) {
    return 'duplicate'
  }
  const base = ids(send, mailboxId, notice.providerMessageId)
  if (bounced !== null) {
    await deps.publish(organizationId, {
      name: 'mail.bounced',
      payload: { ...base, kind: bounced, bouncedAt: at },
    })
  } else if (notice.kind === 'complaint') {
    await deps.publish(organizationId, {
      name: 'mail.complained',
      payload: { ...base, complainedAt: at },
    })
  } else if (notice.kind === 'reply') {
    await deps.publish(organizationId, {
      name: 'mail.replied',
      payload: { ...base, repliedAt: at },
    })
  } else {
    await deps.publish(organizationId, {
      name: 'mail.out_of_office',
      payload: { ...base, returnDate: null, receivedAt: at },
    })
  }
  return 'handled'
}

/** Pauses the Mailbox a complaint came in on and tells the world once. */
async function pauseForComplaint(
  deps: MailEventDeps,
  organizationId: OrganizationId,
  mailboxId: MailboxId,
  at: string
): Promise<void> {
  const paused = await deps.mailboxes.store.pause(organizationId, mailboxId, 'complaint_spike', at)
  if (paused?.changed) {
    await deps.mailboxes.events(organizationId, {
      mailboxId,
      ownerMembershipId: paused.record.ownerMembershipId,
      from: paused.before,
      to: paused.record.state,
      reason: 'complaint_spike',
      changedAt: at,
    })
  }
}

/**
 * Reads the Mailbox's inbox since it was last read and ingests each notice.
 * shortcut: at most one page (50) per poll, so a burst larger than that loses its older notices;
 * a queue-driven loop that follows the provider's history cursor replaces this.
 */
export async function pollMailbox(
  deps: MailEventDeps,
  organizationId: OrganizationId,
  mailboxId: MailboxId
): Promise<number> {
  const record = await deps.mailboxes.store.find(organizationId, mailboxId)
  const transport = record && deps.mailboxes.transports[record.provider]
  if (!record || record.state === 'disconnected' || !transport) {
    return 0
  }
  const startedAt = deps.clock.now().toISOString()
  const accessToken = await Mailboxes.accessTokenFor(deps.mailboxes, organizationId, mailboxId)
  const notices = await transport.fetchInbound(accessToken, {
    since: record.lastSyncedAt ?? record.connectedAt,
    ownAddress: record.address,
  })
  let handled = 0
  let failed = false
  for (const notice of notices) {
    try {
      if ((await ingest(deps, organizationId, mailboxId, notice)) === 'handled') {
        handled += 1
      }
    } catch (error) {
      // One bad notice must not hide the rest; the cursor stays put so it is read again (ingest is idempotent).
      failed = true
      deps.logger.warn('mail notice failed', {
        organizationId,
        mailboxId,
        error: describeError(error),
      })
    }
  }
  if (!failed) {
    await deps.mailboxes.store.markSynced(organizationId, mailboxId, startedAt)
  }
  return handled
}

/** The claims of a genuine, unexpired token; otherwise `unsubscribe.invalid_token` without saying which. */
function claimsOf(deps: MailEventDeps, token: string) {
  const claims = verifyUnsubscribe(
    deps.secret,
    token,
    Math.floor(deps.clock.now().getTime() / 1000)
  )
  if (claims === null) {
    throw domainError(MAIL_ERRORS['unsubscribe.invalid_token'])
  }
  return claims
}

/** What the unsubscribe page shows: the sender's name and nothing else. */
export function unsubscribePage(deps: MailEventDeps, token: string) {
  claimsOf(deps, token)
  return { organizationName: SENDER_LABEL }
}

/**
 * Suppresses the token's Prospect at once, for the token's Organization only. The answer is the
 * same whether or not the Prospect is known or was already suppressed.
 */
export async function unsubscribe(
  deps: MailEventDeps,
  token: string,
  source: 'link' | 'one_click'
) {
  const claims = claimsOf(deps, token)
  const org = claims.organizationId
  const at = deps.clock.now().toISOString()
  const input = await deps.prospects.getEnrichmentInput(org, claims.prospectId)
  const email = input?.values.email
  if (email !== undefined) {
    await deps.suppression.withdrawEmailConsent(org, {
      email,
      sourceRef: `unsubscribe:${claims.prospectId}`,
    })
  }
  const enrollment = await deps.enrollments.findByProspect(
    org,
    claims.campaignId,
    claims.prospectId
  )
  const stopped =
    enrollment && (await deps.enrollments.stop(org, enrollment.id, 'unsubscribed', at, null))
  const last = enrollment && (await deps.sends.lastOfEnrollment(org, enrollment.id))
  const inserted = last
    ? await deps.log.record(org, {
        id: formatId('mev', crypto.randomUUID()),
        mailboxId: last.mailboxId,
        kind: 'unsubscribe',
        sendId: null,
        prospectId: claims.prospectId,
        enrollmentId: enrollment.id,
        providerMessageId: `unsubscribe:${claims.prospectId}`,
        occurredAt: at,
      })
    : false
  if (inserted || (!last && stopped?.stopped)) {
    await deps.publish(org, {
      name: 'mail.unsubscribed',
      payload: {
        prospectId: claims.prospectId,
        mailboxId: last?.mailboxId ?? null,
        sendId: null,
        enrollmentId: enrollment?.id ?? null,
        source,
        unsubscribedAt: at,
      },
    })
  }
  return { status: 'unsubscribed' as const, organizationName: SENDER_LABEL }
}
