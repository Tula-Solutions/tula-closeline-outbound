import {
  decodeCursor,
  ERRORS,
  type ErrorDefinition,
  encodeCursor,
  formatId,
  type ListMailboxesQuery,
  MAIL_ERRORS,
  MAILBOX_RAMP_STEPS,
  type Mailbox,
  type MailboxConnectStart,
  type MailboxId,
  type MembershipId,
  mailboxCursorSchema,
  mailboxSchema,
  type OrganizationId,
  type Role,
  type StartMailboxConnectRequest,
  type TestSendRequest,
  type TestSendResult,
  type UserId,
} from 'tula-closeline-contract'
import type { AppError } from 'tula-closeline-kit'
import { describeError } from '~/describe-error'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { MailTransportError, type OutgoingMessage, type SentMessage } from '~/ports/mail-transport'
import type { MailboxFilter, MailboxRecord, StoredTokens } from '~/ports/mailbox-store'
import type { SecretContext } from '~/ports/secret-box'
import type { MailboxDeps } from './deps'
import {
  challengeOf,
  codeVerifierOf,
  MAX_ATTEMPT_TEAMS,
  mailboxIdOf,
  newAttempt,
  signAttempt,
  stateHashOf,
  verifyAttempt,
} from './oauth-state'

/** The largest page a list may ask for. */
export const MAX_PAGE = 100

/** Who is calling, as the verified token says. */
export type MailboxCaller = { userId: UserId; organizationId: OrganizationId; role: Role }

/** A Mailbox and whether this call wrote it (a replay answers the stored one). */
export type Connected = { mailbox: Mailbox; created: boolean }

/** The default limits a new Mailbox starts with: the first ramp step, Monday to Friday, 09:00 to 17:00 UTC. */
const DEFAULT_LIMITS = {
  perDay: 10,
  perHour: 5,
  minGapSeconds: 60,
  window: {
    timeZone: 'UTC',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    startMinute: 540,
    endMinute: 1020,
  },
} as const

const MAX_DISPLAY_NAME = 100
const REFRESH_MARGIN_MS = 60_000
const DAY_MS = 86_400_000

function mailError(code: keyof typeof MAIL_ERRORS): AppError {
  return domainError(MAIL_ERRORS[code] as ErrorDefinition)
}

/** Whose Mailboxes a caller sees: `owners` undefined means all (Owner and Admin). */
export type View = { me: MembershipId; owners: readonly MembershipId[] | undefined }

/** The view of Mailboxes a caller has by role: all, their Team's Reps', or their own. */
export async function viewOf(deps: MailboxDeps, caller: MailboxCaller): Promise<View> {
  const me = await deps.access.membershipIdOf(caller.organizationId, caller.userId)
  if (caller.role === 'owner' || caller.role === 'admin') {
    return { me, owners: undefined }
  }
  if (caller.role === 'manager') {
    const reps = await deps.access.teamRepIds(caller.organizationId, caller.userId)
    const memberships = await Promise.all(
      reps.map((rep) => deps.access.membershipIdOf(caller.organizationId, rep))
    )
    return { me, owners: [me, ...memberships] }
  }
  return { me, owners: [me] }
}

/** Whether a view includes a Mailbox. */
export function sees(view: View, record: MailboxRecord): boolean {
  return (
    view.owners === undefined ||
    (record.ownerMembershipId !== null && view.owners.includes(record.ownerMembershipId))
  )
}

/** What a Mailbox may send now: its limits after the ramp and its health, and zero when it is stopped. */
export function effectiveLimitsOf(record: MailboxRecord, now: Date) {
  const dayIndex = Math.max(
    0,
    Math.floor((now.getTime() - new Date(record.rampStartedAt).getTime()) / DAY_MS)
  )
  const last = MAILBOX_RAMP_STEPS[MAILBOX_RAMP_STEPS.length - 1]
  const active = last !== undefined && dayIndex < last.fromDay
  const step = [...MAILBOX_RAMP_STEPS].reverse().find((s) => s.fromDay <= dayIndex)
  const perDayNow = active ? (step?.perDay ?? null) : null
  const stopped =
    record.state === 'paused' ||
    record.state === 'disconnected' ||
    record.health.effect === 'paused'
  const halve = record.health.effect === 'limit_halved' ? 2 : 1
  const perDay = Math.floor(Math.min(record.limits.perDay, perDayNow ?? Infinity) / halve)
  const perHour = Math.floor(record.limits.perHour / halve)
  return {
    stopped,
    ramp: { active, dayIndex, perDayNow },
    effective: {
      perDay: stopped ? 0 : perDay,
      perHour: stopped ? 0 : Math.min(perHour, perDay),
      minGapSeconds: record.limits.minGapSeconds,
    },
  }
}

/** A record as the response shows it; the schema drops every field it does not name. */
function present(record: MailboxRecord, now: Date): Mailbox {
  const { ramp, effective } = effectiveLimitsOf(record, now)
  return mailboxSchema.parse({
    id: record.id,
    provider: record.provider,
    kind: record.kind,
    address: record.address,
    displayName: record.displayName,
    ownerMembershipId: record.ownerMembershipId,
    teamIds: record.teamIds,
    state: record.state,
    stateReason: record.stateReason,
    limits: record.limits,
    effectiveLimits: effective,
    ramp: { ...ramp, steps: MAILBOX_RAMP_STEPS.map((s) => ({ ...s })) },
    health: {
      status: record.health.score === null ? 'not_enough_data' : 'scored',
      score: record.health.score,
      effect: record.health.effect,
      scoredAt: record.health.scoredAt ?? record.connectedAt,
    },
    connectedAt: record.connectedAt,
    lastSyncedAt: record.lastSyncedAt,
  })
}

async function loadVisible(deps: MailboxDeps, caller: MailboxCaller, id: MailboxId) {
  const view = await viewOf(deps, caller)
  const record = await deps.store.find(caller.organizationId, id)
  if (record === null || !sees(view, record)) {
    throw mailError('mailbox.not_found')
  }
  return { record, view }
}

/** Lists the Mailboxes the caller may see, oldest connection first. */
export async function list(
  deps: MailboxDeps,
  caller: MailboxCaller,
  query: ListMailboxesQuery
): Promise<{ items: Mailbox[]; nextCursor: string | null }> {
  let after = null
  if (query.cursor !== undefined) {
    const position = decodeCursor(query.cursor, mailboxCursorSchema)
    if (position === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    after = position
  }
  const view = await viewOf(deps, caller)
  const filter: MailboxFilter = {
    visibleOwners: view.owners,
    state: query.state,
    provider: query.provider,
    kind: query.kind,
    ownerMembershipId: query.ownerMembershipId,
  }
  const page = await deps.store.list(
    caller.organizationId,
    filter,
    after,
    Math.min(query.limit, MAX_PAGE)
  )
  const now = deps.clock.now()
  return {
    items: page.items.map((r) => present(r, now)),
    nextCursor: page.next === null ? null : encodeCursor(page.next),
  }
}

/** One Mailbox if the caller may see it; otherwise `mailbox.not_found`. */
export async function get(
  deps: MailboxDeps,
  caller: MailboxCaller,
  id: MailboxId
): Promise<Mailbox> {
  const { record } = await loadVisible(deps, caller, id)
  return present(record, deps.clock.now())
}

/** Starts a connection: answers the provider's consent URL; a repeat under the same key answers the same one. */
export async function startConnect(
  deps: MailboxDeps,
  caller: MailboxCaller,
  body: StartMailboxConnectRequest,
  idempotencyKey: string
): Promise<MailboxConnectStart> {
  if (body.kind === 'shared' && caller.role !== 'owner' && caller.role !== 'admin') {
    throw domainError(ERRORS['auth.forbidden'])
  }
  // shortcut: teamIds are not checked against the Organization's Teams (CoreAccess has no such call); add the check when core exposes one.
  if (body.teamIds.length > MAX_ATTEMPT_TEAMS) {
    throw domainError(ERRORS['request.invalid'])
  }
  const transport = deps.transports[body.provider]
  if (transport === undefined || !deps.secretBox.configured) {
    throw domainError(ERRORS['server.unavailable'])
  }
  const now = Math.floor(deps.clock.now().getTime() / 1000)
  const attempt = newAttempt(caller, idempotencyKey, body, now)
  const state = signAttempt(deps.stateSecret, caller, attempt)
  const verifier = codeVerifierOf(deps.stateSecret, caller, attempt.nonce)
  await deps.store.registerAttempt(caller.organizationId, {
    id: formatId('mca', crypto.randomUUID().replaceAll('-', '')),
    userId: caller.userId,
    stateHash: stateHashOf(state),
    createdAt: deps.clock.now().toISOString(),
    expiresAt: new Date(attempt.expiresAt * 1000).toISOString(),
  })
  return {
    authorizationUrl: transport.authorizationUrl({ state, codeChallenge: challengeOf(verifier) }),
    expiresAt: new Date(attempt.expiresAt * 1000).toISOString(),
  }
}

function contextOf(
  organizationId: OrganizationId,
  mailboxId: MailboxId,
  purpose: SecretContext['purpose']
): SecretContext {
  return { organizationId, mailboxId, purpose }
}

async function sealTokens(
  deps: MailboxDeps,
  organizationId: OrganizationId,
  mailboxId: MailboxId,
  tokens: { accessToken: string; refreshToken: string; expiresAt: string }
): Promise<StoredTokens> {
  const access = await deps.secretBox.seal(
    tokens.accessToken,
    contextOf(organizationId, mailboxId, 'access_token')
  )
  const refresh = await deps.secretBox.seal(
    tokens.refreshToken,
    contextOf(organizationId, mailboxId, 'refresh_token')
  )
  return {
    keyId: access.keyId,
    accessToken: access.ciphertext,
    accessTokenExpiresAt: tokens.expiresAt,
    refreshToken: refresh.ciphertext,
  }
}

function transportFailure(error: unknown): AppError {
  if (error instanceof MailTransportError) {
    if (error.failure === 'grant_invalid' || error.failure === 'rejected') {
      return mailError('mailbox.oauth_state_invalid')
    }
    if (error.failure === 'timeout') {
      return domainError(ERRORS['server.timeout'])
    }
  }
  return domainError(ERRORS['server.unavailable'])
}

/** Completes a connection with the state and code the provider sent back; a replay answers the same Mailbox. */
export async function completeConnect(
  deps: MailboxDeps,
  caller: MailboxCaller,
  body: { state: string; code: string }
): Promise<Connected> {
  const nowDate = deps.clock.now()
  const attempt = verifyAttempt(
    deps.stateSecret,
    caller,
    body.state,
    Math.floor(nowDate.getTime() / 1000)
  )
  if (attempt === null) {
    // A forged, foreign or expired attempt (a replay after the window included) is refused.
    throw mailError('mailbox.oauth_state_invalid')
  }
  const derivedId = mailboxIdOf(caller.organizationId, attempt.nonce)
  const first = await deps.store.find(caller.organizationId, derivedId)
  if (first !== null) {
    return { mailbox: present(first, nowDate), created: false }
  }
  const transport = deps.transports[attempt.provider]
  if (transport === undefined || !deps.secretBox.configured) {
    throw domainError(ERRORS['server.unavailable'])
  }
  if (attempt.kind === 'shared' && caller.role !== 'owner' && caller.role !== 'admin') {
    throw domainError(ERRORS['auth.forbidden'])
  }
  // shortcut: the link is burned before the exchange, so a transient provider failure means starting the connect again; release the attempt on a transient failure if that annoys users.
  // The link is single-use: the first completion burns it, a second one (even after a reconnect) is refused.
  const unused = await deps.store.consumeAttempt(
    caller.organizationId,
    caller.userId,
    stateHashOf(body.state),
    nowDate.toISOString()
  )
  if (!unused) {
    throw mailError('mailbox.oauth_state_invalid')
  }
  const { me } = await viewOf(deps, caller)
  let granted: Awaited<ReturnType<typeof transport.exchangeCode>>
  try {
    granted = await transport.exchangeCode({
      code: body.code,
      codeVerifier: codeVerifierOf(deps.stateSecret, caller, attempt.nonce),
    })
  } catch (error) {
    deps.logger.warn('mailbox code exchange failed', { error: describeError(error) })
    throw transportFailure(error)
  }
  const existing = await deps.store.findByAddress(
    caller.organizationId,
    attempt.provider,
    granted.account.address
  )
  if (existing !== null && existing.state !== 'disconnected') {
    throw mailError('mailbox.already_connected')
  }
  const id = existing?.id ?? derivedId
  const tokens = await sealTokens(deps, caller.organizationId, id, granted.tokens)
  const at = nowDate.toISOString()
  const record: MailboxRecord = {
    id,
    provider: attempt.provider,
    kind: attempt.kind,
    address: granted.account.address,
    displayName:
      granted.account.displayName.trim().slice(0, MAX_DISPLAY_NAME) || granted.account.address,
    providerAccountId: granted.account.providerAccountId,
    ownerMembershipId: attempt.kind === 'personal' ? me : null,
    teamIds: attempt.teamIds,
    state: 'warming',
    stateReason: null,
    stateChangedAt: at,
    limits: {
      ...DEFAULT_LIMITS,
      window: { ...DEFAULT_LIMITS.window, days: [...DEFAULT_LIMITS.window.days] },
    },
    health: { score: null, effect: 'none', scoredAt: null },
    rampStartedAt: at,
    connectedAt: at,
    lastSyncedAt: null,
  }
  const result = await deps.store.connect(caller.organizationId, record, tokens)
  if (result.kind === 'already_connected') {
    throw mailError('mailbox.already_connected')
  }
  return { mailbox: present(result.record, nowDate), created: true }
}

async function publishChange(
  deps: MailboxDeps,
  organizationId: OrganizationId,
  before: MailboxRecord,
  after: MailboxRecord
): Promise<void> {
  try {
    await deps.events(organizationId, {
      mailboxId: after.id,
      ownerMembershipId: after.ownerMembershipId,
      from: before.state,
      to: after.state,
      reason: after.stateReason,
      changedAt: after.stateChangedAt,
    })
  } catch (error) {
    deps.logger.error('mailbox.state_changed was not published', {
      mailboxId: after.id,
      error: describeError(error),
    })
  }
}

/** Disconnects a Mailbox the caller owns (or any, for an Owner or Admin); a repeat answers 200 and changes nothing. */
export async function disconnect(
  deps: MailboxDeps,
  caller: MailboxCaller,
  id: MailboxId
): Promise<Mailbox> {
  const { record, view } = await loadVisible(deps, caller, id)
  const mayAll = caller.role === 'owner' || caller.role === 'admin'
  if (!mayAll && record.ownerMembershipId !== view.me) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  const now = deps.clock.now()
  if (record.state === 'disconnected') {
    return present(record, now)
  }
  const refreshToken = await readRefreshToken(deps, caller.organizationId, record)
  const result = await deps.store.disconnect(
    caller.organizationId,
    id,
    'disconnected_by_owner',
    now.toISOString()
  )
  if (result === null) {
    throw mailError('mailbox.not_found')
  }
  if (result.changed) {
    await revokeAtProvider(deps, record, refreshToken)
    await publishChange(deps, caller.organizationId, record, result.record)
  }
  return present(result.record, now)
}

async function readRefreshToken(
  deps: MailboxDeps,
  organizationId: OrganizationId,
  record: MailboxRecord
): Promise<string | null> {
  try {
    const tokens = await deps.store.readTokens(organizationId, record.id)
    if (tokens === null || !deps.secretBox.configured) {
      return null
    }
    return await deps.secretBox.open(
      { keyId: tokens.keyId, ciphertext: tokens.refreshToken },
      contextOf(organizationId, record.id, 'refresh_token')
    )
  } catch (error) {
    deps.logger.warn('mailbox refresh token could not be opened', {
      mailboxId: record.id,
      error: describeError(error),
    })
    return null
  }
}

async function revokeAtProvider(
  deps: MailboxDeps,
  record: MailboxRecord,
  refreshToken: string | null
): Promise<void> {
  const transport = deps.transports[record.provider]
  if (transport === undefined || refreshToken === null) {
    return
  }
  try {
    await transport.revoke(refreshToken)
  } catch (error) {
    // The tokens are already gone here; a grant left at the provider is the person's to remove.
    deps.logger.warn('mailbox grant was not revoked at the provider', {
      mailboxId: record.id,
      error: describeError(error),
    })
  }
}

/**
 * A working access token for a Mailbox, refreshed when it is about to expire. When the provider says
 * the grant is gone, the Mailbox becomes `disconnected` with reason `auth_revoked`, its tokens are
 * deleted, `mailbox.state_changed` is published, and this throws `mailbox.auth_revoked`.
 */
export async function accessTokenFor(
  deps: MailboxDeps,
  organizationId: OrganizationId,
  id: MailboxId
): Promise<string> {
  const record = await deps.store.find(organizationId, id)
  const tokens = await deps.store.readTokens(organizationId, id)
  if (record === null) {
    throw mailError('mailbox.not_found')
  }
  const transport = deps.transports[record.provider]
  if (tokens === null || record.state === 'disconnected') {
    throw mailError('mailbox.not_connected')
  }
  if (transport === undefined || !deps.secretBox.configured) {
    throw domainError(ERRORS['server.unavailable'])
  }
  if (
    new Date(tokens.accessTokenExpiresAt).getTime() - deps.clock.now().getTime() >
    REFRESH_MARGIN_MS
  ) {
    return deps.secretBox.open(
      { keyId: tokens.keyId, ciphertext: tokens.accessToken },
      contextOf(organizationId, id, 'access_token')
    )
  }
  const refreshToken = await deps.secretBox.open(
    { keyId: tokens.keyId, ciphertext: tokens.refreshToken },
    contextOf(organizationId, id, 'refresh_token')
  )
  try {
    const fresh = await transport.refresh(refreshToken)
    const sealed = await sealTokens(deps, organizationId, id, {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? refreshToken,
      expiresAt: fresh.expiresAt,
    })
    await deps.store.writeTokens(organizationId, id, sealed)
    return fresh.accessToken
  } catch (error) {
    if (error instanceof MailTransportError && error.failure === 'grant_invalid') {
      const result = await deps.store.disconnect(
        organizationId,
        id,
        'auth_revoked',
        deps.clock.now().toISOString()
      )
      if (result?.changed) {
        await publishChange(deps, organizationId, record, result.record)
      }
      throw mailError('mailbox.auth_revoked')
    }
    throw transportFailure(error)
  }
}

/** Sends one email through a Mailbox; refreshes the token once if the provider says it expired. */
export async function sendThrough(
  deps: MailboxDeps,
  organizationId: OrganizationId,
  id: MailboxId,
  message: OutgoingMessage
): Promise<SentMessage> {
  const record = await deps.store.find(organizationId, id)
  const transport = record === null ? undefined : deps.transports[record.provider]
  if (record === null || transport === undefined) {
    throw mailError('mailbox.not_found')
  }
  try {
    return await transport.send(await accessTokenFor(deps, organizationId, id), message)
  } catch (error) {
    if (error instanceof MailTransportError && error.failure === 'token_expired') {
      // Nothing was accepted, so a second send after a refresh cannot double-send.
      const tokens = await deps.store.readTokens(organizationId, id)
      if (tokens !== null) {
        await deps.store.writeTokens(organizationId, id, {
          ...tokens,
          accessTokenExpiresAt: new Date(0).toISOString(),
        })
      }
      return transport.send(await accessTokenFor(deps, organizationId, id), message)
    }
    throw error instanceof MailTransportError ? transportFailure(error) : error
  }
}

/** How many test sends one Mailbox may make in an hour. */
export const TEST_SENDS_PER_HOUR = 5

const TEST_SEND_WINDOW_MS = 3_600_000
const TEST_SEND_SUBJECT = 'Closeline test email'
const TEST_SEND_TEXT =
  'This is a test email from Closeline to check that your Mailbox can send. No reply is needed.'

/** Sends one fixed test email through a Mailbox the caller owns (or any, for an Owner or Admin). */
export async function testSend(
  deps: MailboxDeps,
  caller: MailboxCaller,
  id: MailboxId,
  body: TestSendRequest,
  idempotencyKey: string
): Promise<TestSendResult> {
  const { record, view } = await loadVisible(deps, caller, id)
  const mayAll = caller.role === 'owner' || caller.role === 'admin'
  if (!mayAll && record.ownerMembershipId !== view.me) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  const sha = (text: string) =>
    Buffer.from(new Bun.CryptoHasher('sha256').update(text).digest()).toString('hex')
  const keyHash = sha(idempotencyKey)
  const requestHash = sha(JSON.stringify([body.to, body.subject ?? null]))
  if (record.state === 'disconnected') {
    throw mailError(
      record.stateReason === 'auth_revoked' ? 'mailbox.auth_revoked' : 'mailbox.not_connected'
    )
  }
  if (record.state === 'paused' || record.health.effect === 'paused') {
    throw mailError('mailbox.paused')
  }
  const now = deps.clock.now()
  // The marker is `<request hash>:` while the send runs and `<request hash>:<provider id>` after.
  const claim = await deps.store.claimTestSend(caller.organizationId, id, keyHash, {
    marker: `${requestHash}:`,
    sentAt: now.toISOString(),
  })
  if (!claim.claimed) {
    const marker = claim.existing.marker
    const seen = marker.slice(0, marker.indexOf(':'))
    const providerMessageId = marker.slice(marker.indexOf(':') + 1)
    if (seen !== requestHash) {
      throw domainError(ERRORS['request.idempotency_key_reused'])
    }
    if (providerMessageId === '') {
      throw new RetryAfterError(ERRORS['request.idempotency_in_progress'], 1, { retryAfter: 1 })
    }
    return { providerMessageId, sentAt: claim.existing.sentAt }
  }
  let sent: SentMessage
  try {
    // The claim itself is counted, hence `>`.
    const recent = await deps.store.countTestSends(
      caller.organizationId,
      id,
      new Date(now.getTime() - TEST_SEND_WINDOW_MS).toISOString()
    )
    if (recent > TEST_SENDS_PER_HOUR) {
      throw new RetryAfterError(ERRORS['rate.limited'], TEST_SEND_WINDOW_MS / 1000)
    }
    sent = await sendThrough(deps, caller.organizationId, id, {
      from: { address: record.address, name: record.displayName },
      to: body.to,
      subject: body.subject ?? TEST_SEND_SUBJECT,
      text: TEST_SEND_TEXT,
    })
  } catch (error) {
    // shortcut: failed sends are released, so they do not count toward the cap, and a process that dies mid-send leaves its key pending (in_progress) until the caller uses a new key; add a claim expiry and a failure count if that matters.
    await deps.store.releaseTestSend(caller.organizationId, id, keyHash).catch(() => undefined)
    throw error
  }
  // Past this point the mail is out: a failure here keeps the claim pending rather than allow a resend.
  await deps.store.finishTestSend(
    caller.organizationId,
    id,
    keyHash,
    `${requestHash}:${sent.providerMessageId}`
  )
  return { providerMessageId: sent.providerMessageId, sentAt: now.toISOString() }
}
