import { createHmac, timingSafeEqual } from 'node:crypto'
import type { MailboxId, OrganizationId } from 'tula-closeline-contract'

/** Length of a base64url SHA-256 MAC. */
const MAC_LENGTH = 43
const DOMAIN = 'mailhook|v1|'

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(DOMAIN).update(payload).digest()
}

/**
 * The secret string a provider sends back with a notification (Graph's `clientState`, Gmail's
 * `state` query parameter): it names the Mailbox and proves we set up the subscription.
 */
export function signWebhookState(
  secret: string,
  organizationId: OrganizationId,
  mailboxId: MailboxId
): string {
  const payload = Buffer.from(JSON.stringify([organizationId, mailboxId])).toString('base64url')
  return `${payload}${mac(secret, payload).toString('base64url')}`
}

/** The Mailbox a genuine state names, or null; the MAC is compared in constant time. */
export function verifyWebhookState(
  secret: string,
  state: string
): { organizationId: OrganizationId; mailboxId: MailboxId } | null {
  if (state.length <= MAC_LENGTH) {
    return null
  }
  const payload = state.slice(0, -MAC_LENGTH)
  const given = Buffer.from(state.slice(-MAC_LENGTH), 'base64url')
  const expected = mac(secret, payload)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null
  }
  try {
    const [o, m] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown[]
    return typeof o === 'string' && typeof m === 'string'
      ? { organizationId: o as OrganizationId, mailboxId: m as MailboxId }
      : null
  } catch {
    return null
  }
}
