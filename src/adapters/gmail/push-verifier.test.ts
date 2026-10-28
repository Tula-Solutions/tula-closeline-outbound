import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { createGooglePushVerifier } from './push-verifier'

const AUDIENCE = 'https://outbound.test/v1/public/mail/webhooks/gmail'
const ACCOUNT = 'push@project.iam.gserviceaccount.com'
const NOW = Date.parse('2026-10-28T12:00:00Z')

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const other = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1' }
  const keys = async () => publicKey
  const verify = createGooglePushVerifier({
    audience: AUDIENCE,
    serviceAccount: ACCOUNT,
    keys,
    now: () => NOW,
  })
  const sign = (
    claims: JWTPayload = {},
    key = privateKey,
    { audience = AUDIENCE, expiresIn = 3600 } = {}
  ) =>
    new SignJWT({ email: ACCOUNT, email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer('https://accounts.google.com')
      .setAudience(audience)
      .setIssuedAt(Math.floor(NOW / 1000) - 7200)
      .setExpirationTime(Math.floor(NOW / 1000) + expiresIn)
      .sign(key)
  return { verify, sign, other: other.privateKey }
}

describe('Pub/Sub push token', () => {
  test('a genuine token for our URL and the service account is accepted', async () => {
    const { verify, sign } = await setup()
    expect(await verify(`Bearer ${await sign()}`)).toBe(true)
  })

  test('a missing header, other scheme, wrong audience, wrong account or unverified email is refused', async () => {
    const { verify, sign } = await setup()
    expect(await verify(undefined)).toBe(false)
    expect(await verify(`Basic ${await sign()}`)).toBe(false)
    expect(await verify('Bearer not.a.jwt')).toBe(false)
    const wrongAudience = await sign({}, undefined, { audience: 'https://evil.test/hook' })
    expect(await verify(`Bearer ${wrongAudience}`)).toBe(false)
    expect(await verify(`Bearer ${await sign({ email: 'someone@else.test' })}`)).toBe(false)
    expect(await verify(`Bearer ${await sign({ email_verified: false })}`)).toBe(false)
  })

  test('an expired token and a token signed by another key are refused', async () => {
    const { verify, sign, other } = await setup()
    expect(await verify(`Bearer ${await sign({}, undefined, { expiresIn: -10 })}`)).toBe(false)
    expect(await verify(`Bearer ${await sign({}, other)}`)).toBe(false)
  })
})
