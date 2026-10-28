import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { signUnsubscribe, unsubscribeUrl, verifyUnsubscribe } from './unsubscribe'

const secret = 'testing-mail-state-secret-0123456789-abcdef'
const claims = {
  organizationId: formatId('org', crypto.randomUUID()),
  prospectId: formatId('prs', crypto.randomUUID()),
  campaignId: formatId('cpg', crypto.randomUUID()),
  expiresAt: 2_000_000_000,
}

const MAC_LENGTH = 43

describe('unsubscribe token', () => {
  test('uses only the characters the route accepts', () => {
    expect(signUnsubscribe(secret, claims)).toMatch(/^[A-Za-z0-9_-]{22,512}$/)
  })

  test('round trips', () => {
    expect(verifyUnsubscribe(secret, signUnsubscribe(secret, claims), 1_900_000_000)).toEqual(
      claims
    )
  })

  test('expires', () => {
    expect(verifyUnsubscribe(secret, signUnsubscribe(secret, claims), 2_000_000_001)).toBeNull()
  })

  test('rejects a changed payload, a wrong secret and junk', () => {
    const token = signUnsubscribe(secret, claims)
    const payload = token.slice(0, -MAC_LENGTH)
    const mac = token.slice(-MAC_LENGTH)
    const forged = Buffer.from(JSON.stringify([claims.organizationId, 'prs_x', 'c', 1])).toString(
      'base64url'
    )
    expect(verifyUnsubscribe(secret, `${forged}${mac}`, 1)).toBeNull()
    expect(verifyUnsubscribe('another-secret-0123456789-abcdefghijklmn', token, 1)).toBeNull()
    expect(verifyUnsubscribe(secret, payload, 1)).toBeNull()
    expect(verifyUnsubscribe(secret, `${token}x`, 1)).toBeNull()
    expect(verifyUnsubscribe(secret, '', 1)).toBeNull()
  })

  test('the link carries the token', () => {
    expect(unsubscribeUrl('https://app.test/unsubscribe', 'a.b')).toBe(
      'https://app.test/unsubscribe?t=a.b'
    )
  })
})
