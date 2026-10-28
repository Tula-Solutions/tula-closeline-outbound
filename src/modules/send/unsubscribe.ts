import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CampaignId, OrganizationId, ProspectId } from 'tula-closeline-contract'

/** How long an unsubscribe link in a sent email keeps working. */
export const UNSUBSCRIBE_TTL_SECONDS = 30 * 24 * 60 * 60

/** What an unsubscribe token names: who unsubscribes from what, until when. */
export type UnsubscribeClaims = {
  organizationId: OrganizationId
  prospectId: ProspectId
  campaignId: CampaignId
  /** Unix seconds. */
  expiresAt: number
}

const DOMAIN = 'unsub|v1|'

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(DOMAIN).update(payload).digest()
}

/** Length of a base64url SHA-256 MAC; the token has no separator because the route's token alphabet has none. */
const MAC_LENGTH = 43

/** Signs the claims into a URL-safe token: `base64url(payload)` then the 43-character `base64url(mac)`. */
export function signUnsubscribe(secret: string, claims: UnsubscribeClaims): string {
  const payload = Buffer.from(
    JSON.stringify([claims.organizationId, claims.prospectId, claims.campaignId, claims.expiresAt])
  ).toString('base64url')
  return `${payload}${mac(secret, payload).toString('base64url')}`
}

/** The claims of a token that is genuine and not expired at `nowSeconds`; otherwise null. */
export function verifyUnsubscribe(
  secret: string,
  token: string,
  nowSeconds: number
): UnsubscribeClaims | null {
  if (token.length <= MAC_LENGTH) {
    return null
  }
  const payload = token.slice(0, -MAC_LENGTH)
  const signature = token.slice(-MAC_LENGTH)
  const given = Buffer.from(signature, 'base64url')
  const expected = mac(secret, payload)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null
  }
  try {
    const [o, p, c, e] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown[]
    if (
      typeof o !== 'string' ||
      typeof p !== 'string' ||
      typeof c !== 'string' ||
      typeof e !== 'number' ||
      e < nowSeconds
    ) {
      return null
    }
    return {
      organizationId: o as OrganizationId,
      prospectId: p as ProspectId,
      campaignId: c as CampaignId,
      expiresAt: e,
    }
  } catch {
    return null
  }
}

/** The link a recipient follows: the configured page with the token as its `t` parameter. */
export function unsubscribeUrl(base: string, token: string): string {
  const url = new URL(base)
  url.searchParams.set('t', token)
  return url.toString()
}
