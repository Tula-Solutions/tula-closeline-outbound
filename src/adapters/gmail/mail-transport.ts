import { createHash, randomBytes } from 'node:crypto'
import { classifyInbound, INBOUND_PAGE_SIZE } from '~/adapters/inbound-classify'
import { createProviderCall } from '~/adapters/provider-call'
import {
  type ConnectedAccount,
  type GrantTokens,
  type InboundNotice,
  type InboundPage,
  type MailTransport,
  MailTransportError,
  type OutgoingMessage,
  type SentMessage,
} from '~/ports/mail-transport'

/** Scopes the Mailbox needs: identity, sending, and reading replies later. */
export const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const

/** The `fetch` shape the adapter needs, so a test can swap it. */
export type GmailFetch = (input: string, init: RequestInit) => Promise<Response>

/** Settings for {@link createGmailMailTransport}. */
export type GmailMailTransportOptions = {
  clientId: string
  clientSecret: string
  redirectUri: string
  authUrl: string
  tokenUrl: string
  revokeUrl: string
  apiBaseUrl: string
  /** Bound for one HTTP call, in ms. */
  timeoutMs: number
  /** Most tries for a call that may be repeated (at least 1). */
  maxTries: number
  /** First retry delay, in ms; doubles each try, with jitter. */
  retryBaseMs: number
  fetch?: GmailFetch
  sleep?: (ms: number) => Promise<void>
  /** Returns a number in [0, 1); used for jitter. */
  random?: () => number
  /** The clock token expiry is measured from; defaults to the system clock. */
  now?: () => Date
}

/** Headers a caller may not set because the transport owns them. */
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'subject',
  'content-type',
  'mime-version',
  'bcc',
  'cc',
])

function lineSafe(value: string): boolean {
  return !/[\r\n\0]/.test(value)
}

function encodedWord(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: tests for non-ASCII on purpose
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function addressHeader(name: string, address: string): string {
  if (name === '') {
    return address
  }
  const ascii = encodedWord(name) === name
  const shown = ascii
    ? `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : encodedWord(name)
  return `${shown} <${address}>`
}

/** Builds the RFC 822 text of a message; throws `rejected` when a field would break the header block. */
export function buildRfc822(message: OutgoingMessage): string {
  for (const value of [
    message.from.address,
    message.from.name,
    message.to,
    message.subject,
    message.inReplyTo ?? '',
  ]) {
    if (!lineSafe(value)) {
      throw new MailTransportError('rejected')
    }
  }
  const headers: Array<[string, string]> = [
    ['From', addressHeader(message.from.name, message.from.address)],
    ['To', message.to],
    ['Subject', encodedWord(message.subject)],
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=UTF-8'],
    ['Content-Transfer-Encoding', 'base64'],
  ]
  if (message.inReplyTo !== undefined) {
    headers.push(['In-Reply-To', message.inReplyTo], ['References', message.inReplyTo])
  }
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new MailTransportError('rejected')
    }
    headers.push([name, value])
  }
  for (const [name, value] of headers) {
    if (!lineSafe(name) || !lineSafe(value)) {
      throw new MailTransportError('rejected')
    }
  }
  const body = Buffer.from(message.text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')
  return `${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n${body}`
}

function decodeIdToken(idToken: unknown): {
  sub: string
  email: string
  name: string
} {
  if (typeof idToken !== 'string') {
    throw new MailTransportError('grant_invalid')
  }
  const part = idToken.split('.')[1]
  if (part === undefined) {
    throw new MailTransportError('grant_invalid')
  }
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    throw new MailTransportError('grant_invalid')
  }
  if (typeof claims !== 'object' || claims === null) {
    throw new MailTransportError('grant_invalid')
  }
  const { sub, email, email_verified: verified, name } = claims as Record<string, unknown>
  if (typeof sub !== 'string' || typeof email !== 'string' || verified === false) {
    throw new MailTransportError('grant_invalid')
  }
  return { sub, email: email.toLowerCase(), name: typeof name === 'string' ? name : email }
}

/**
 * The Gmail implementation of the mail transport. Every call has a timeout. Token, refresh and
 * revoke calls retry on a network error, 429 or 5xx with jittered backoff; a send retries only on
 * 429 or 503, where Google did not take the message, never after a timeout or a dropped connection.
 */
export function createGmailMailTransport(options: GmailMailTransportOptions): MailTransport {
  const doFetch: GmailFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  const call = createProviderCall({ ...options, fetch: doFetch, sleep, random })

  const retryAlways = () => true
  const form = (values: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(values).toString(),
  })
  const errorOf = (body: unknown): string | undefined =>
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : undefined
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

  return {
    provider: 'gmail',

    authorizationUrl({ state, codeChallenge }) {
      const url = new URL(options.authUrl)
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', options.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', GMAIL_SCOPES.join(' '))
      url.searchParams.set('access_type', 'offline')
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
      const { status, body } = await call(
        options.tokenUrl,
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: options.redirectUri,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code_verifier: codeVerifier,
        }),
        (outcome) => outcome !== 'timeout'
      )
      if (status !== 200) {
        throw new MailTransportError(
          status === 400 || status === 401 ? 'grant_invalid' : 'rejected',
          status
        )
      }
      const accessToken = field(body, 'access_token')
      const refreshToken = field(body, 'refresh_token')
      if (accessToken === undefined || refreshToken === undefined) {
        throw new MailTransportError('grant_invalid', status)
      }
      const identity = decodeIdToken((body as Record<string, unknown>).id_token)
      return {
        tokens: { accessToken, refreshToken, expiresAt: expiry(body) },
        account: {
          address: identity.email,
          displayName: identity.name,
          providerAccountId: identity.sub,
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
        }),
        retryAlways
      )
      if (status === 400 || status === 401) {
        throw new MailTransportError(
          errorOf(body) === 'invalid_grant' ? 'grant_invalid' : 'rejected',
          status
        )
      }
      const accessToken = field(body, 'access_token')
      if (status !== 200 || accessToken === undefined) {
        throw new MailTransportError('rejected', status)
      }
      return { accessToken, expiresAt: expiry(body) }
    },

    async revoke(token) {
      const { status } = await call(options.revokeUrl, form({ token }), retryAlways)
      // 400 means the token was already revoked or expired: the goal is met.
      if (status !== 200 && status !== 400) {
        throw new MailTransportError('rejected', status)
      }
    },

    async send(accessToken, message): Promise<SentMessage> {
      const raw = Buffer.from(buildRfc822(message), 'utf8').toString('base64url')
      const payload: Record<string, string> = { raw }
      if (message.threadId !== undefined) {
        payload.threadId = message.threadId
      }
      const { status, body } = await call(
        `${options.apiBaseUrl.replace(/\/$/, '')}/gmail/v1/users/me/messages/send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(payload),
        },
        (outcome) =>
          typeof outcome !== 'string' && (outcome.status === 429 || outcome.status === 503)
      )
      if (status === 401) {
        throw new MailTransportError('token_expired', status)
      }
      const id = field(body, 'id')
      if (status !== 200 || id === undefined) {
        throw new MailTransportError('rejected', status)
      }
      return { providerMessageId: id, threadId: field(body, 'threadId') ?? id }
    },

    async fetchInbound(accessToken, { cursor, since, ownAddress }): Promise<InboundPage> {
      const api = `${options.apiBaseUrl.replace(/\/$/, '')}/gmail/v1/users/me`
      const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
      const read = async (url: string): Promise<{ status: number; body: unknown }> => {
        const { status, body } = await call(url, { method: 'GET', headers }, retryAlways)
        if (status === 401) {
          throw new MailTransportError('token_expired', status)
        }
        return { status, body }
      }
      const readOk = async (url: string): Promise<unknown> => {
        const { status, body } = await read(url)
        if (status !== 200) {
          throw new MailTransportError('rejected', status)
        }
        return body
      }
      const idsOf = (list: unknown, key: string): string[] =>
        (typeof list === 'object' &&
        list !== null &&
        Array.isArray((list as Record<string, unknown>)[key])
          ? ((list as Record<string, unknown[]>)[key] as unknown[])
          : []
        )
          .map((m) => field(m, 'id'))
          .filter((id): id is string => id !== undefined)

      /** One bounded listing of the inbox since the Mailbox was connected. */
      const listing = async (historyId: string, pageToken: string | undefined) => {
        const query = new URLSearchParams({
          q: `in:inbox after:${Math.floor(new Date(since).getTime() / 1000)}`,
          maxResults: String(INBOUND_PAGE_SIZE),
        })
        if (pageToken !== undefined) {
          query.set('pageToken', pageToken)
        }
        const list = await readOk(`${api}/messages?${query}`)
        const next = field(list, 'nextPageToken')
        return {
          ids: idsOf(list, 'messages'),
          cursor: next === undefined ? historyId : `list:${historyId}:${next}`,
          more: next !== undefined,
        }
      }

      let step: { ids: string[]; cursor: string; more: boolean }
      if (cursor?.startsWith('list:')) {
        const [, historyId = '', ...token] = cursor.split(':')
        step = await listing(historyId, token.join(':'))
      } else {
        let history: unknown
        if (cursor !== null && cursor !== undefined) {
          const query = new URLSearchParams({
            startHistoryId: cursor,
            historyTypes: 'messageAdded',
            labelId: 'INBOX',
            maxResults: '100',
          })
          const res = await read(`${api}/history?${query}`)
          if (res.status === 200) {
            history = res.body
          } else if (res.status !== 404) {
            throw new MailTransportError('rejected', res.status)
          }
        }
        if (history === undefined) {
          // First read, or a history id Gmail no longer keeps: list the inbox again.
          const profile = await readOk(`${api}/profile`)
          step = await listing(field(profile, 'historyId') ?? '0', undefined)
        } else {
          const records =
            typeof history === 'object' &&
            history !== null &&
            Array.isArray((history as { history?: unknown }).history)
              ? ((history as { history: unknown[] }).history as unknown[])
              : []
          const ids = new Set<string>()
          for (const record of records) {
            const added = (record as { messagesAdded?: unknown }).messagesAdded
            for (const item of Array.isArray(added) ? added : []) {
              const id = field((item as { message?: unknown }).message, 'id')
              if (id !== undefined) {
                ids.add(id)
              }
            }
          }
          const more = field(history, 'nextPageToken') !== undefined
          // Cut short: stop at the last record read, so the next run resumes right after it.
          const last = field(records[records.length - 1], 'id')
          step = {
            ids: [...ids],
            cursor: more ? (last ?? cursor ?? '0') : (field(history, 'historyId') ?? cursor ?? '0'),
            more,
          }
        }
      }

      const notices: InboundNotice[] = []
      // shortcut: one metadata call per message (at most ~100 a run); use a batch call if polling gets hot.
      for (const id of step.ids) {
        const query = new URLSearchParams({ format: 'metadata' })
        for (const name of ['From', 'Subject', 'Content-Type', 'Auto-Submitted']) {
          query.append('metadataHeaders', name)
        }
        const { status, body: message } = await read(
          `${api}/messages/${encodeURIComponent(id)}?${query}`
        )
        if (status === 404) {
          continue // deleted before we read it
        }
        if (status !== 200) {
          throw new MailTransportError('rejected', status)
        }
        const raw =
          typeof message === 'object' && message !== null
            ? ((message as { payload?: { headers?: unknown } }).payload?.headers ?? [])
            : []
        const value = (name: string): string => {
          const found = Array.isArray(raw)
            ? raw.find((h) => field(h, 'name')?.toLowerCase() === name.toLowerCase())
            : undefined
          return field(found, 'value') ?? ''
        }
        const kind = classifyInbound(
          {
            from: value('From'),
            subject: value('Subject'),
            contentType: value('Content-Type'),
            autoSubmitted: value('Auto-Submitted'),
          },
          ownAddress
        )
        const millis = Number(field(message, 'internalDate'))
        if (kind !== null) {
          notices.push({
            providerMessageId: id,
            threadId: field(message, 'threadId') ?? id,
            kind,
            receivedAt: new Date(Number.isFinite(millis) ? millis : Date.now()).toISOString(),
          })
        }
      }
      notices.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      return { notices, cursor: step.cursor, more: step.more }
    },
  }
}

/** A fresh PKCE verifier, for callers that do not derive one. */
export function newCodeVerifier(): string {
  return randomBytes(48).toString('base64url')
}

/** The S256 challenge for a verifier. */
export function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}
