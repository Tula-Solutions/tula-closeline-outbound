import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  formatId,
  type MailboxId,
  type MailboxKind,
  type MailboxProvider,
  type OrganizationId,
  type TeamId,
  type UserId,
} from 'tula-closeline-contract'

/** The most Teams a shared Mailbox may be opened to in one connect attempt (the state must stay short). */
export const MAX_ATTEMPT_TEAMS = 8

/** How long a connect attempt lasts, in seconds. */
export const ATTEMPT_TTL_SECONDS = 600

/** The width of the time bucket attempts start in, so a retry under one key gets the same URL. */
const BUCKET_SECONDS = 60

const PROVIDERS: readonly MailboxProvider[] = ['gmail', 'outlook']
const KINDS: readonly MailboxKind[] = ['personal', 'shared']
const NONCE_BYTES = 16
const MAC_BYTES = 32
const VERSION = 1

/** What a connect attempt carries; the Organization and user are bound by the signature, not carried. */
export type ConnectAttempt = {
  /** 32 hex characters, the same for the same Organization, user and Idempotency-Key. */
  nonce: string
  provider: MailboxProvider
  kind: MailboxKind
  teamIds: readonly TeamId[]
  /** Epoch seconds. */
  expiresAt: number
}

/** The caller an attempt belongs to. */
export type AttemptOwner = { organizationId: OrganizationId; userId: UserId }

function sha256(text: string): Buffer {
  return Buffer.from(new Bun.CryptoHasher('sha256').update(text).digest())
}

function mac(secret: string, owner: AttemptOwner, payload: Buffer): Buffer {
  return createHmac('sha256', secret)
    .update(`state|${owner.organizationId}|${owner.userId}|`)
    .update(payload)
    .digest()
}

/** The attempt a start call under this key makes: same inputs and minute, same attempt. */
export function newAttempt(
  owner: AttemptOwner,
  idempotencyKey: string,
  input: { provider: MailboxProvider; kind: MailboxKind; teamIds: readonly TeamId[] },
  nowSeconds: number
): ConnectAttempt {
  const bucket = Math.floor(nowSeconds / BUCKET_SECONDS) * BUCKET_SECONDS
  return {
    nonce: sha256(`${owner.organizationId}|${owner.userId}|${idempotencyKey}`)
      .subarray(0, NONCE_BYTES)
      .toString('hex'),
    provider: input.provider,
    kind: input.kind,
    teamIds: input.teamIds,
    expiresAt: bucket + ATTEMPT_TTL_SECONDS,
  }
}

/** Signs an attempt into the opaque `state` the provider hands back (base64url, under 256 characters). */
export function signAttempt(secret: string, owner: AttemptOwner, attempt: ConnectAttempt): string {
  const head = Buffer.alloc(1 + 4 + 1 + 1 + 1)
  head.writeUInt8(VERSION, 0)
  head.writeUInt32BE(attempt.expiresAt, 1)
  head.writeUInt8(PROVIDERS.indexOf(attempt.provider), 5)
  head.writeUInt8(KINDS.indexOf(attempt.kind), 6)
  head.writeUInt8(attempt.teamIds.length, 7)
  const payload = Buffer.concat([
    head,
    Buffer.from(attempt.nonce, 'hex'),
    ...attempt.teamIds.map((id) => Buffer.from(id.slice('team_'.length), 'hex')),
  ])
  return Buffer.concat([payload, mac(secret, owner, payload)]).toString('base64url')
}

/** The attempt a state carries, or null when it is malformed, forged, for another caller or expired. */
export function verifyAttempt(
  secret: string,
  owner: AttemptOwner,
  state: string,
  nowSeconds: number
): ConnectAttempt | null {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(state)) {
    return null
  }
  const bytes = Buffer.from(state, 'base64url')
  const headLength = 8 + NONCE_BYTES
  if (bytes.length < headLength + MAC_BYTES) {
    return null
  }
  const payload = bytes.subarray(0, bytes.length - MAC_BYTES)
  const given = bytes.subarray(bytes.length - MAC_BYTES)
  if (!timingSafeEqual(given, mac(secret, owner, payload))) {
    return null
  }
  const teamCount = payload.readUInt8(7)
  const provider = PROVIDERS[payload.readUInt8(5)]
  const kind = KINDS[payload.readUInt8(6)]
  const expiresAt = payload.readUInt32BE(1)
  if (
    payload.readUInt8(0) !== VERSION ||
    provider === undefined ||
    kind === undefined ||
    payload.length !== headLength + teamCount * 16 ||
    expiresAt <= nowSeconds
  ) {
    return null
  }
  const teamIds: TeamId[] = []
  for (let i = 0; i < teamCount; i++) {
    const start = headLength + i * 16
    teamIds.push(formatId('team', payload.subarray(start, start + 16).toString('hex')))
  }
  return {
    nonce: payload.subarray(8, headLength).toString('hex'),
    provider,
    kind,
    teamIds,
    expiresAt,
  }
}

/** The PKCE verifier of an attempt: derived from the secret, so nothing is stored between the two calls. */
export function codeVerifierOf(secret: string, owner: AttemptOwner, nonce: string): string {
  return createHmac('sha256', secret)
    .update(`pkce|${owner.organizationId}|${owner.userId}|${nonce}`)
    .digest('base64url')
}

/** The S256 challenge for a verifier. */
export function challengeOf(verifier: string): string {
  return Buffer.from(new Bun.CryptoHasher('sha256').update(verifier).digest()).toString('base64url')
}

/** The id the Mailbox of an attempt gets, so completing the same attempt twice finds the first. */
export function mailboxIdOf(organizationId: OrganizationId, nonce: string): MailboxId {
  return formatId(
    'mbx',
    sha256(`${organizationId}|mailbox|${nonce}`).subarray(0, 16).toString('hex')
  )
}

/** The hash the store keeps for an attempt, so a stored row never holds the `state` itself. */
export function stateHashOf(state: string): string {
  return sha256(state).toString('hex')
}
