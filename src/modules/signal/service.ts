import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  decodeCursor,
  ENRICHMENT_ERRORS,
  ERRORS,
  encodeCursor,
  formatId,
  type OrganizationId,
  organizationIdSchema,
  type ProspectId,
  type ProviderKey,
  type RecordNoteRequest,
  type Role,
  SIGNAL_KINDS,
  SIGNAL_WEBHOOK_TOLERANCE_SECONDS,
  type Signal,
  type SignalId,
  type SignalKind,
  type SignalKindSetting,
  type SignalSettings,
  type SignalSource,
  type SignalWebhookRequest,
  type SignalWebhookResponse,
  signalSchema,
  signalWebhookRequestSchema,
  type UserId,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { domainError } from '~/http/domain-error'
import type { AccessCaller } from '~/ports/core'
import { SettingsVersionConflictError, type StoredSignal } from '~/ports/signal-store'
import type { SignalDeps } from './deps'

/** The largest page a Signal list may ask for. */
export const MAX_PAGE = 100

/** The days a Signal stays fresh when its Organization never saved settings. */
export const DEFAULT_FRESHNESS_DAYS = 30

/** Who is calling, with their own bearer so core's view rules decide which Prospects they see. */
export type SignalCaller = AccessCaller

const cursorSchema = z.strictObject({
  observedAt: z.string().max(40),
  id: z.string().max(64),
})

const DAY_MS = 86_400_000
const invalid = () => domainError(ENRICHMENT_ERRORS['signal.invalid'])
const prospectNotFound = () => domainError(ENRICHMENT_ERRORS['enrichment.prospect_not_found'])
const unauthorized = () => domainError(ENRICHMENT_ERRORS['signal.webhook_unauthorized'])

/** A Signal in the form the API returns, with `fresh` read against `now`; the shape is checked by the contract. */
function present(stored: StoredSignal, now: Date): Signal {
  return signalSchema.parse({
    ...stored.detail,
    id: stored.id,
    prospectId: stored.prospectId,
    kind: stored.kind,
    source: stored.source,
    observedAt: stored.observedAt,
    recordedAt: stored.recordedAt,
    expiresAt: stored.expiresAt,
    fresh: new Date(stored.expiresAt).getTime() > now.getTime(),
  })
}

/** An id that is the same for the same inputs, so a replay collides on it. */
function derivedId(...parts: string[]): SignalId {
  const hex = new Bun.CryptoHasher('sha256').update(parts.join('\u0000')).digest('hex')
  return formatId('sig', hex.slice(0, 32))
}

async function ensureVisible(deps: SignalDeps, caller: SignalCaller, prospectId: ProspectId) {
  const seen = await deps.access.inspect(caller, [prospectId])
  return seen.notVisible.length === 0
}

async function requireVisible(deps: SignalDeps, caller: SignalCaller, prospectId: ProspectId) {
  if (!(await ensureVisible(deps, caller, prospectId))) {
    throw prospectNotFound()
  }
}

/** The settings with every kind present: the Organization's saved ones, or all enabled for 30 days. */
function withDefaults(saved: readonly SignalKindSetting[]): SignalKindSetting[] {
  return SIGNAL_KINDS.map(
    (kind) =>
      saved.find((setting) => setting.kind === kind) ?? {
        kind,
        enabled: true,
        freshnessDays: DEFAULT_FRESHNESS_DAYS,
      }
  )
}

/** What a caller (a provider adapter, the webhook or a person) hands in to be recorded. */
export type IngestInput = {
  /** A fixed id makes a repeat collide on it; omit for a new one. */
  id?: SignalId
  prospectId: ProspectId
  source: SignalSource
  /** The webhook's event id, which makes a replay record nothing. */
  eventId?: string
  observedAt: string
  /** The kind and its fields, as the contract's Signal has them; unchecked here, checked by the contract. */
  fields: { kind: SignalKind } & Record<string, unknown>
}

/**
 * Records a Signal once. The fields are checked by the contract (and cleaned: control characters
 * dropped, text cut to length); a disabled kind or a bad field is `signal.invalid`. Text is kept as
 * data and is never interpreted or logged. Used by the routes and by provider adapters.
 */
export async function ingest(
  deps: SignalDeps,
  organizationId: OrganizationId,
  input: IngestInput
): Promise<{ signal: Signal; duplicate: boolean }> {
  const now = deps.clock.now()
  const observed = new Date(input.observedAt)
  if (Number.isNaN(observed.getTime()) || observed.getTime() > now.getTime() + 300_000) {
    throw invalid()
  }
  const settings = withDefaults((await deps.store.settings(organizationId)).kinds)
  const setting = settings.find((entry) => entry.kind === input.fields.kind)
  if (setting === undefined || !setting.enabled) {
    throw invalid()
  }
  const id = input.id ?? formatId('sig', crypto.randomUUID().replaceAll('-', ''))
  const recordedAt = now.toISOString()
  const candidate = signalSchema.safeParse({
    ...input.fields,
    id,
    prospectId: input.prospectId,
    source: input.source,
    observedAt: observed.toISOString(),
    recordedAt,
    expiresAt: new Date(observed.getTime() + setting.freshnessDays * DAY_MS).toISOString(),
    fresh: true,
  })
  if (!candidate.success) {
    throw invalid()
  }
  const {
    id: _id,
    prospectId,
    kind,
    source,
    observedAt,
    recordedAt: _recorded,
    expiresAt,
    fresh: _fresh,
    ...detail
  } = candidate.data
  const result = await deps.store.record(
    organizationId,
    { id, prospectId, kind, source, observedAt, recordedAt, expiresAt, detail },
    input.eventId ?? null
  )
  if (!result.duplicate) {
    await deps.events(organizationId, {
      name: 'signal.recorded',
      payload: { signalId: id, prospectId, kind, observedAt, recordedAt },
    })
  }
  return { signal: present(result.signal, now), duplicate: result.duplicate }
}

/** Records a note a person wrote; a repeat under the same key answers the first, a different note under it is refused. */
export async function recordNote(
  deps: SignalDeps,
  caller: SignalCaller,
  prospectId: ProspectId,
  body: RecordNoteRequest,
  idempotencyKey: string
): Promise<{ signal: Signal; replay: boolean }> {
  await requireVisible(deps, caller, prospectId)
  const observedAt = body.observedAt ?? deps.clock.now().toISOString()
  const id = derivedId(caller.organizationId, prospectId, idempotencyKey)
  const { signal, duplicate } = await ingest(deps, caller.organizationId, {
    id,
    prospectId,
    source: { type: 'manual', userId: caller.userId },
    observedAt,
    fields: { kind: 'note', text: body.text },
  })
  if (
    duplicate &&
    (signal.kind !== 'note' ||
      signal.text !== body.text ||
      (body.observedAt !== undefined &&
        new Date(signal.observedAt).getTime() !== new Date(body.observedAt).getTime()))
  ) {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  return { signal, replay: duplicate }
}

/** A page of one Prospect's Signals, newest first; expired ones only when `fresh` is false. */
export async function listForProspect(
  deps: SignalDeps,
  caller: SignalCaller,
  prospectId: ProspectId,
  query: {
    cursor?: string | undefined
    limit: number
    kind?: SignalKind | undefined
    fresh?: boolean | undefined
  }
): Promise<{ items: Signal[]; nextCursor: string | null }> {
  await requireVisible(deps, caller, prospectId)
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor, cursorSchema)
  if (after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const now = deps.clock.now()
  const page = await deps.store.list(caller.organizationId, prospectId, {
    kind: query.kind,
    expiresAfter: query.fresh === false ? null : now.toISOString(),
    after,
    limit: Math.min(query.limit, MAX_PAGE),
  })
  return {
    items: page.items.map((stored) => present(stored, now)),
    nextCursor: page.next === null ? null : encodeCursor(page.next),
  }
}

/**
 * The fresh Signals of a Prospect, newest first, for another module (the research brief). The
 * text in them is untrusted data: show it, never obey it, never log it.
 */
export async function listFresh(
  deps: SignalDeps,
  organizationId: OrganizationId,
  prospectId: ProspectId,
  options: { limit: number; kind?: SignalKind | undefined }
): Promise<Signal[]> {
  const now = deps.clock.now()
  const page = await deps.store.list(organizationId, prospectId, {
    kind: options.kind,
    expiresAfter: now.toISOString(),
    after: null,
    limit: Math.min(options.limit, MAX_PAGE),
  })
  return page.items.map((stored) => present(stored, now))
}

/** One Signal; `signal.not_found` also for another Organization's and for a Prospect the caller cannot see. */
export async function getOne(
  deps: SignalDeps,
  caller: SignalCaller,
  signalId: SignalId
): Promise<Signal> {
  const stored = await deps.store.get(caller.organizationId, signalId)
  if (stored === null || !(await ensureVisible(deps, caller, stored.prospectId))) {
    throw domainError(ENRICHMENT_ERRORS['signal.not_found'])
  }
  return present(stored, deps.clock.now())
}

async function settingsOf(
  deps: SignalDeps,
  organizationId: OrganizationId
): Promise<SignalSettings> {
  const stored = await deps.store.settings(organizationId)
  return {
    kinds: withDefaults(stored.kinds),
    webhook: { configured: stored.webhook.sealed !== null, rotatedAt: stored.webhook.rotatedAt },
    version: stored.version,
    updatedAt: stored.updatedAt,
  }
}

/** The Organization's settings: saved ones or the defaults at version 0. */
export function getSettings(deps: SignalDeps, caller: { organizationId: OrganizationId }) {
  return settingsOf(deps, caller.organizationId)
}

/** Saves the settings; `enrichment.version_conflict` when someone saved since the caller read. */
export async function setSettings(
  deps: SignalDeps,
  caller: { organizationId: OrganizationId },
  body: { kinds: SignalKindSetting[]; expectedVersion: number }
): Promise<SignalSettings> {
  try {
    await deps.store.saveSettings(
      caller.organizationId,
      withDefaults(body.kinds),
      body.expectedVersion,
      deps.clock.now().toISOString()
    )
  } catch (error) {
    if (error instanceof SettingsVersionConflictError) {
      throw domainError(ENRICHMENT_ERRORS['enrichment.version_conflict'])
    }
    throw error
  }
  return settingsOf(deps, caller.organizationId)
}

/** Makes a new webhook signing secret, keeps it sealed, and returns it this once. */
export async function rotateWebhookSecret(
  deps: SignalDeps,
  caller: { organizationId: OrganizationId; role: Role; userId: UserId }
): Promise<{ organizationId: OrganizationId; secret: string; rotatedAt: string }> {
  if (!deps.secretBox.configured) {
    throw domainError(ERRORS['server.unavailable'])
  }
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const sealed = await deps.secretBox.seal(secret, {
    organizationId: caller.organizationId,
    purpose: 'signal_webhook_secret',
  })
  const rotatedAt = deps.clock.now().toISOString()
  await deps.store.setWebhookSecret(caller.organizationId, sealed, rotatedAt)
  return { organizationId: caller.organizationId, secret, rotatedAt }
}

/** What the webhook route hands over: the path, the raw body and the two headers. */
export type WebhookCall = {
  organizationId: string
  rawBody: string
  timestamp: string | undefined
  signature: string | undefined
}

const SIGNATURE = /^[0-9a-f]{64}$/

/**
 * Records a website visit from the Organization's own site. Order: timestamp, signature (constant
 * time), body, Prospect, record. Any failure before the body is read is `signal.webhook_unauthorized`
 * with nothing read; a replayed event id records nothing.
 */
export async function receiveWebhook(
  deps: SignalDeps,
  call: WebhookCall
): Promise<SignalWebhookResponse & { created: boolean }> {
  const organization = organizationIdSchema.safeParse(call.organizationId)
  if (
    !organization.success ||
    call.timestamp === undefined ||
    !/^\d{1,12}$/.test(call.timestamp) ||
    call.signature === undefined ||
    !SIGNATURE.test(call.signature)
  ) {
    throw unauthorized()
  }
  const organizationId = organization.data
  const drift = Math.abs(deps.clock.now().getTime() / 1000 - Number(call.timestamp))
  if (drift > SIGNAL_WEBHOOK_TOLERANCE_SECONDS) {
    throw unauthorized()
  }
  const { webhook } = await deps.store.settings(organizationId)
  if (webhook.sealed === null) {
    throw unauthorized()
  }
  // A sealed secret the box cannot open (a changed key) must not become a 500 for a stranger.
  const secret = await deps.secretBox
    .open(webhook.sealed, { organizationId, purpose: 'signal_webhook_secret' })
    .catch(() => null)
  if (secret === null) {
    throw unauthorized()
  }
  const expected = createHmac('sha256', secret).update(`${call.timestamp}.${call.rawBody}`).digest()
  const given = Buffer.from(call.signature, 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw unauthorized()
  }

  let json: unknown
  try {
    json = JSON.parse(call.rawBody)
  } catch {
    throw invalid()
  }
  const parsed = signalWebhookRequestSchema.safeParse(json)
  if (!parsed.success) {
    throw invalid()
  }
  const request: SignalWebhookRequest = parsed.data
  const prospectId =
    'prospectId' in request
      ? (await deps.core.getEnrichmentInput(organizationId, request.prospectId)) === null
        ? null
        : request.prospectId
      : await deps.core.findProspectIdByEmail(organizationId, request.email)
  if (prospectId === null) {
    throw prospectNotFound()
  }
  const { signal, duplicate } = await ingest(deps, organizationId, {
    id: derivedId(organizationId, 'webhook', request.eventId),
    prospectId,
    source: { type: 'webhook' },
    eventId: request.eventId,
    observedAt: request.visitedAt,
    fields: { kind: 'website_visit', pageUrl: request.pageUrl, visitCount: 1 },
  })
  return { recorded: !duplicate, duplicate, signalId: signal.id, created: !duplicate }
}

/** The provider key a provider adapter records Signals under. */
export type { ProviderKey }
