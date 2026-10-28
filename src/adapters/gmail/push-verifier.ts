import { createHash, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'

/** Where Google publishes the keys that sign the OIDC tokens of Pub/Sub push. */
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

/** What {@link createGooglePushVerifier} checks a push token against. */
export type PushVerifierOptions = {
  /** The URL Pub/Sub pushes to; the token's `aud`. */
  audience: string
  /** The service account the subscription pushes as; the token's `email`. */
  serviceAccount: string
  /** The signing keys; tests pass a local set, production reads Google's. */
  keys?: JWTVerifyGetKey
  /** Time in epoch ms, for the expiry check. */
  now: () => number
}

const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * Checks the `Authorization: Bearer` OIDC token of a Pub/Sub push: Google-signed (RS256), issued by
 * Google, for our webhook URL, to the configured service account, unexpired. Any failure is false.
 */
export function createGooglePushVerifier(
  options: PushVerifierOptions
): (authorization: string | undefined) => Promise<boolean> {
  const keys = options.keys ?? createRemoteJWKSet(new URL(GOOGLE_CERTS_URL))
  return async (authorization) => {
    const token = authorization?.match(/^Bearer (.{1,8192})$/i)?.[1]
    if (token === undefined) {
      return false
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: options.audience,
        currentDate: new Date(options.now()),
      })
      return (
        payload.email_verified === true &&
        typeof payload.email === 'string' &&
        timingSafeEqual(digest(payload.email), digest(options.serviceAccount))
      )
    } catch {
      return false
    }
  }
}
