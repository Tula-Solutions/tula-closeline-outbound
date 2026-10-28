import { buildRfc822 } from '~/adapters/gmail/mail-transport'
import { createProviderCall } from '~/adapters/provider-call'
import {
  type ConnectedAccount,
  type GrantTokens,
  type MailTransport,
  MailTransportError,
  type SentMessage,
} from '~/ports/mail-transport'

/** Scopes the Mailbox needs: identity, a refresh token, drafting and sending, and reading replies later. */
export const GRAPH_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
] as const

/** The `fetch` shape the adapter needs, so a test can swap it. */
export type GraphFetch = (input: string, init: RequestInit) => Promise<Response>

/** Settings for {@link createGraphMailTransport}. */
export type GraphMailTransportOptions = {
  clientId: string
  clientSecret: string
  redirectUri: string
  /** The Microsoft identity platform authorize URL (tenant `common`). */
  authUrl: string
  tokenUrl: string
  /** The Graph origin, without a path. */
  apiBaseUrl: string
  /** Bound for one HTTP call, in ms. */
  timeoutMs: number
  /** Most tries for a call that may be repeated (at least 1). */
  maxTries: number
  /** First retry delay, in ms; doubles each try, with jitter. */
  retryBaseMs: number
  fetch?: GraphFetch
  sleep?: (ms: number) => Promise<void>
  /** Returns a number in [0, 1); used for jitter. */
  random?: () => number
  /** The clock token expiry is measured from; defaults to the system clock. */
  now?: () => Date
}

/** Token-endpoint errors that mean the grant is gone (revoked, expired, or needs the person again). */
const DEAD_GRANT = new Set(['invalid_grant', 'interaction_required', 'consent_required'])

/**
 * The Microsoft Graph implementation of the mail transport. Every call has a timeout. Token,
 * refresh and identity calls retry on a network error, 429 or 5xx with jittered backoff. Sending
 * is two calls: creating the draft (repeatable; a lost answer leaves at worst an unsent draft) and
 * sending it, which retries only on 429 or 503, never after a timeout or a dropped connection.
 * Microsoft has no per-grant revoke endpoint, so `revoke` does nothing at the provider.
 */
export function createGraphMailTransport(options: GraphMailTransportOptions): MailTransport {
  const doFetch: GraphFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const call = createProviderCall({
    ...options,
    fetch: doFetch,
    sleep,
    random: options.random ?? Math.random,
  })
  const api = `${options.apiBaseUrl.replace(/\/$/, '')}/v1.0`

  const retryAlways = () => true
  const form = (values: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(values).toString(),
  })
  const field = (body: unknown, key: string): string | undefined => {
    const value =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const expiry = (body: unknown): string => {
    const seconds =
      typeof body === 'object' && body !== null
        ? (body as { expires_in?: unknown }).expires_in
        : undefined
    return new Date(
      (options.now ?? (() => new Date()))().getTime() +
        (typeof seconds === 'number' && seconds > 0 ? seconds : 3600) * 1000
    ).toISOString()
  }
  const bearer = (accessToken: string): Record<string, string> => ({
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
  })

  return {
    provider: 'outlook',

    authorizationUrl({ state, codeChallenge }) {
      const url = new URL(options.authUrl)
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', options.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('response_mode', 'query')
      url.searchParams.set('scope', GRAPH_SCOPES.join(' '))
      url.searchParams.set('prompt', 'consent')
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },

    async exchangeCode({
      code,
      codeVerifier,
    }): Promise<{ tokens: GrantTokens; account: ConnectedAccount }> {
      // A code is single use: a repeat after an unknown outcome would only fail, so do not retry a timeout.
      const token = await call(
        options.tokenUrl,
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: options.redirectUri,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code_verifier: codeVerifier,
          scope: GRAPH_SCOPES.join(' '),
        }),
        (outcome) => outcome !== 'timeout'
      )
      if (token.status !== 200) {
        throw new MailTransportError(
          token.status === 400 || token.status === 401 ? 'grant_invalid' : 'rejected',
          token.status
        )
      }
      const accessToken = field(token.body, 'access_token')
      const refreshToken = field(token.body, 'refresh_token')
      if (accessToken === undefined || refreshToken === undefined) {
        throw new MailTransportError('grant_invalid', token.status)
      }
      const me = await call(
        `${api}/me?$select=id,displayName,mail,userPrincipalName`,
        { method: 'GET', headers: bearer(accessToken) },
        retryAlways
      )
      const id = field(me.body, 'id')
      const address = (field(me.body, 'mail') ?? field(me.body, 'userPrincipalName'))?.toLowerCase()
      if (me.status !== 200 || id === undefined || address === undefined) {
        throw new MailTransportError(me.status === 401 ? 'grant_invalid' : 'rejected', me.status)
      }
      return {
        tokens: { accessToken, refreshToken, expiresAt: expiry(token.body) },
        account: {
          address,
          displayName: field(me.body, 'displayName') ?? address,
          providerAccountId: id,
        },
      }
    },

    async refresh(refreshToken) {
      const { status, body } = await call(
        options.tokenUrl,
        form({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          scope: GRAPH_SCOPES.join(' '),
        }),
        retryAlways
      )
      if (status === 400 || status === 401) {
        throw new MailTransportError(
          DEAD_GRANT.has(field(body, 'error') ?? '') ? 'grant_invalid' : 'rejected',
          status
        )
      }
      const accessToken = field(body, 'access_token')
      if (status !== 200 || accessToken === undefined) {
        throw new MailTransportError('rejected', status)
      }
      return { accessToken, expiresAt: expiry(body) }
    },

    // shortcut: Microsoft offers no revoke for one app's grant (revokeSignInSessions would sign the
    // person out everywhere); the service deletes the tokens and the person can remove the app at
    // account.microsoft.com. Upgrade if Microsoft adds a per-app revoke.
    async revoke() {},

    async send(accessToken, message): Promise<SentMessage> {
      // Built first so a header that would break the block is refused before any call.
      const mime = Buffer.from(buildRfc822(message), 'utf8').toString('base64')
      const draft = await call(
        `${api}/me/messages`,
        {
          method: 'POST',
          headers: { ...bearer(accessToken), 'content-type': 'text/plain' },
          body: mime,
        },
        retryAlways
      )
      if (draft.status === 401) {
        throw new MailTransportError('token_expired', draft.status)
      }
      const id = field(draft.body, 'id')
      if (draft.status !== 201 || id === undefined) {
        throw new MailTransportError('rejected', draft.status)
      }
      const sent = await call(
        `${api}/me/messages/${encodeURIComponent(id)}/send`,
        { method: 'POST', headers: bearer(accessToken) },
        (outcome) =>
          typeof outcome !== 'string' && (outcome.status === 429 || outcome.status === 503)
      )
      if (sent.status === 401) {
        throw new MailTransportError('token_expired', sent.status)
      }
      if (sent.status !== 202) {
        throw new MailTransportError('rejected', sent.status)
      }
      return { providerMessageId: id, threadId: field(draft.body, 'conversationId') ?? id }
    },
  }
}
