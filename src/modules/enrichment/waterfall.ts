import {
  ENRICHED_FIELDS,
  type EnrichedFieldName,
  type EnrichmentAttempt,
  type EnrichmentRun,
  type EnrichmentRunId,
  FIELD_GROUP_OF,
  type FieldGroup,
  type OrganizationId,
  type ProviderKey,
  VERIFICATION_REASONS,
  VERIFICATION_STATUSES,
} from 'tula-closeline-contract'
import type { EnrichedFieldWrite } from '~/ports/core'
import {
  type EmailVerifier,
  type EnrichmentProvider,
  type ProspectValues,
  ProviderError,
  type ProviderFailure,
} from '~/ports/enrichment-provider'
import type { ProviderSetting } from '~/ports/provider-config'
import {
  type Lease,
  LeaseLostError,
  type Provenance,
  type Reservation,
  type StoredVerification,
} from '~/ports/store'
import { cleanVendorText } from './clean'
import type { EnrichmentDeps } from './deps'

/** A provider's answer below this confidence (0 to 100) is not used. */
export const MIN_CONFIDENCE = 60

/** The failures that are tried again; a rejected key or a malformed answer would fail again. */
const RETRYABLE: ReadonlySet<ProviderFailure> = new Set([
  'timeout',
  'rate_limited',
  'provider_error',
])

/** The month `YYYY-MM-01` (UTC) a time falls in, the key of the spend ledger. */
export function monthOf(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`
}

/** Which setting position decides the order within a group. */
function positionOf(setting: ProviderSetting, group: FieldGroup): number {
  const value =
    group === 'email_verification' ? setting.positions.emailVerification : setting.positions[group]
  return value ?? Number.MAX_SAFE_INTEGER
}

/** Calls once with a deadline that aborts it, whatever the adapter does with the signal. */
async function callOnce<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ProviderError('timeout'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([call(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** The failure a thrown value counts as; only the kind is kept, never its message. */
function failureOf(error: unknown): ProviderFailure {
  return error instanceof ProviderError ? error.failure : 'provider_error'
}

/** Calls a provider with a timeout and a bounded, jittered retry; resolves to a result or a failure. */
async function callWithRetry<T>(
  deps: EnrichmentDeps,
  call: (signal: AbortSignal) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; failure: ProviderFailure }> {
  const { providerMaxTries, providerTimeoutMs, retryBaseMs } = deps.limits
  let failure: ProviderFailure = 'provider_error'
  for (let attempt = 1; attempt <= providerMaxTries; attempt += 1) {
    try {
      return { ok: true, value: await callOnce(providerTimeoutMs, call) }
    } catch (error) {
      failure = failureOf(error)
      if (!RETRYABLE.has(failure) || attempt === providerMaxTries) {
        break
      }
      await deps.sleep(Math.round(retryBaseMs * 2 ** (attempt - 1) * (0.5 + deps.random())))
    }
  }
  return { ok: false, failure }
}

/** What stops a run early. */
type Stop = 'monthly_budget' | 'run_ceiling'

/** The running state of one execution. */
type State = {
  organizationId: OrganizationId
  run: EnrichmentRun
  known: ProspectValues
  fields: Provenance[]
  position: number
  cost: number
  verification: StoredVerification | null
  satisfied: Set<FieldGroup>
  stop: Stop | null
  lease: Lease
}

/** Records one attempt (and what it found) in the store and in the running state. */
async function record(
  deps: EnrichmentDeps,
  state: State,
  attempt: EnrichmentAttempt,
  fields: readonly Provenance[],
  extra?: { verification?: StoredVerification; reservation?: Reservation }
): Promise<void> {
  await deps.store.recordAttempt(
    state.organizationId,
    state.run.id,
    state.lease,
    { ...attempt, position: state.position },
    fields,
    extra
  )
  state.position += 1
  state.cost += attempt.costMicros
  state.fields.push(...fields)
  for (const field of fields) {
    state.known[field.field] = field.value
  }
}

/** The attempt row for a call that was not made. */
function skipped(
  deps: EnrichmentDeps,
  provider: ProviderKey,
  group: FieldGroup,
  outcome: 'skipped_disabled' | 'skipped_budget'
): EnrichmentAttempt {
  return {
    provider,
    group,
    outcome,
    failure: null,
    costMicros: 0,
    startedAt: deps.clock.now().toISOString(),
    durationMs: 0,
  }
}

/**
 * Checks the run ceiling and reserves the price against the month before a call. Renews the run
 * lease first, so a long run keeps it. Returns the reservation when the call may go ahead;
 * otherwise it has recorded a `skipped_budget` attempt and set the stop.
 */
async function admit(
  deps: EnrichmentDeps,
  state: State,
  provider: ProviderKey,
  group: FieldGroup,
  price: number
): Promise<Reservation | null> {
  if (state.cost + price > state.run.ceilingMicros) {
    state.stop = 'run_ceiling'
  } else {
    const now = deps.clock.now()
    state.lease = await deps.store.renewLease(state.organizationId, state.run.id, state.lease, now)
    const reserved = await deps.store.reserveSpend(state.organizationId, {
      runId: state.run.id,
      lease: state.lease,
      provider,
      priceMicros: price,
      limitMicros: deps.limits.monthlyBudgetMicros,
      now,
      holdSeconds: deps.limits.runLeaseSeconds,
    })
    if (reserved !== null) {
      return reserved
    }
    state.stop = 'monthly_budget'
  }
  await record(deps, state, skipped(deps, provider, group, 'skipped_budget'), [])
  return null
}

/** Gives a reservation back after a call that threw; a lost lease means someone else owns it now. */
async function releaseHeld(
  deps: EnrichmentDeps,
  state: State,
  reservation: Reservation
): Promise<void> {
  try {
    await deps.store.releaseSpend(state.organizationId, state.run.id, state.lease, reservation)
  } catch (error) {
    if (!(error instanceof LeaseLostError)) {
      throw error
    }
  }
}

/** Runs the providers of a person or company group in order until one fills a field. */
async function fillGroup(
  deps: EnrichmentDeps,
  state: State,
  group: 'person' | 'company',
  settings: ReadonlyMap<ProviderKey, ProviderSetting>
): Promise<void> {
  const wanted = ENRICHED_FIELDS.filter(
    (field) => FIELD_GROUP_OF[field] === group && state.known[field] === undefined
  )
  if (wanted.length === 0) {
    state.satisfied.add(group)
    return
  }
  const candidates = deps.providers
    .filter((provider) => provider.groups.includes(group) && settings.has(provider.key))
    .sort(
      (a, b) =>
        positionOf(settings.get(a.key) as ProviderSetting, group) -
          positionOf(settings.get(b.key) as ProviderSetting, group) || a.key.localeCompare(b.key)
    )
  for (const provider of candidates) {
    if (state.stop !== null) {
      return
    }
    if (state.run.attempts.some((a) => a.provider === provider.key && a.group === group)) {
      continue
    }
    const setting = settings.get(provider.key) as ProviderSetting
    if (!setting.enabled || setting.apiKey === null) {
      await record(deps, state, skipped(deps, provider.key, group, 'skipped_disabled'), [])
      continue
    }
    const reservation = await admit(deps, state, provider.key, group, provider.priceMicros)
    if (reservation === null) {
      return
    }
    if (await tryProvider(deps, state, provider, group, wanted, setting.apiKey, reservation)) {
      state.satisfied.add(group)
      return
    }
  }
}

/** What a provider answer looks like once it is known to be well formed. */
type AnswerItem = { field: unknown; value: unknown; confidence: unknown }

/** The items of a provider's answer, or null when the answer is not a list of objects. */
function answerItems(answer: unknown): readonly AnswerItem[] | null {
  if (!Array.isArray(answer)) {
    return null
  }
  const items: AnswerItem[] = []
  for (const item of answer as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) {
      return null
    }
    const entry = item as Record<string, unknown>
    items.push({ field: entry.field, value: entry.value, confidence: entry.confidence })
  }
  return items
}

/** A verifier's verdict when it is one of the contract's statuses and reasons, else null. */
function verdictOf(answer: unknown): { status: string; reason: string } | null {
  if (typeof answer !== 'object' || answer === null) {
    return null
  }
  const { status, reason } = answer as Record<string, unknown>
  const statuses: readonly unknown[] = VERIFICATION_STATUSES
  const reasons: readonly unknown[] = VERIFICATION_REASONS
  return statuses.includes(status) && reasons.includes(reason)
    ? { status: status as string, reason: reason as string }
    : null
}

/** One provider call and its recording; true when it filled at least one wanted field. */
async function tryProvider(
  deps: EnrichmentDeps,
  state: State,
  provider: EnrichmentProvider,
  group: FieldGroup,
  wanted: readonly EnrichedFieldName[],
  apiKey: string,
  reservation: Reservation
): Promise<boolean> {
  const startedAt = deps.clock.now()
  const known = { ...state.known }
  const price = provider.priceMicros
  try {
    const called = await callWithRetry(deps, (signal) =>
      provider.lookup({ wanted, known, apiKey, signal })
    )
    const durationMs = Math.max(0, deps.clock.now().getTime() - startedAt.getTime())
    const items = called.ok ? answerItems(called.value) : null
    const failure: ProviderFailure | null = !called.ok
      ? called.failure
      : items === null
        ? 'invalid_response'
        : null
    if (failure !== null || items === null) {
      deps.logger.warn('provider call failed', { provider: provider.key, failure })
      await record(
        deps,
        state,
        {
          provider: provider.key,
          group,
          outcome: 'failed',
          failure: failure ?? 'invalid_response',
          costMicros: 0,
          startedAt: startedAt.toISOString(),
          durationMs,
        },
        [],
        { reservation }
      )
      return false
    }
    const found = new Map<EnrichedFieldName, Provenance>()
    for (const entry of items) {
      const field = entry.field as EnrichedFieldName
      const confidence = typeof entry.confidence === 'number' ? Math.round(entry.confidence) : -1
      const cleaned = cleanVendorText(entry.value)
      if (
        !wanted.includes(field) ||
        found.has(field) ||
        confidence < MIN_CONFIDENCE ||
        confidence > 100 ||
        cleaned === null
      ) {
        continue
      }
      found.set(field, {
        field,
        value: cleaned.value,
        truncated: cleaned.truncated,
        provider: provider.key,
        confidence,
        obtainedAt: startedAt.toISOString(),
        costMicros: found.size === 0 ? price : 0,
        application: 'suggested',
      })
    }
    await record(
      deps,
      state,
      {
        provider: provider.key,
        group,
        outcome: found.size > 0 ? 'filled' : 'no_result',
        failure: null,
        costMicros: provider.priceMicros,
        startedAt: startedAt.toISOString(),
        durationMs,
      },
      [...found.values()],
      { reservation }
    )
    return found.size > 0
  } catch (error) {
    await releaseHeld(deps, state, reservation)
    throw error
  }
}

/** Runs the verifiers in order until one gives a verdict on the Prospect's email address. */
async function verifyEmail(
  deps: EnrichmentDeps,
  state: State,
  settings: ReadonlyMap<ProviderKey, ProviderSetting>
): Promise<void> {
  const group: FieldGroup = 'email_verification'
  const email = state.known.email
  if (email === undefined) {
    return
  }
  const candidates: EmailVerifier[] = deps.verifiers
    .filter((verifier) => settings.has(verifier.key))
    .sort(
      (a, b) =>
        positionOf(settings.get(a.key) as ProviderSetting, group) -
          positionOf(settings.get(b.key) as ProviderSetting, group) || a.key.localeCompare(b.key)
    )
  for (const verifier of candidates) {
    if (state.stop !== null) {
      return
    }
    if (state.run.attempts.some((a) => a.provider === verifier.key && a.group === group)) {
      continue
    }
    const setting = settings.get(verifier.key) as ProviderSetting
    if (!setting.enabled || setting.apiKey === null) {
      await record(deps, state, skipped(deps, verifier.key, group, 'skipped_disabled'), [])
      continue
    }
    const reservation = await admit(deps, state, verifier.key, group, verifier.priceMicros)
    if (reservation === null) {
      return
    }
    const apiKey = setting.apiKey
    const startedAt = deps.clock.now()
    try {
      const called = await callWithRetry(deps, (signal) =>
        verifier.verify({ email, apiKey, signal })
      )
      const durationMs = Math.max(0, deps.clock.now().getTime() - startedAt.getTime())
      const answer = called.ok ? verdictOf(called.value) : null
      if (!called.ok || answer === null) {
        const failure: ProviderFailure = called.ok ? 'invalid_response' : called.failure
        deps.logger.warn('provider call failed', { provider: verifier.key, failure })
        await record(
          deps,
          state,
          {
            provider: verifier.key,
            group,
            outcome: 'failed',
            failure,
            costMicros: 0,
            startedAt: startedAt.toISOString(),
            durationMs,
          },
          [],
          { reservation }
        )
        continue
      }
      const verdict = {
        status: answer.status,
        reason: answer.reason,
        provider: verifier.key,
        checkedAt: startedAt.toISOString(),
      } as StoredVerification
      state.verification = verdict
      await record(
        deps,
        state,
        {
          provider: verifier.key,
          group,
          outcome: 'filled',
          failure: null,
          costMicros: verifier.priceMicros,
          startedAt: startedAt.toISOString(),
          durationMs,
        },
        [],
        { verification: verdict, reservation }
      )
    } catch (error) {
      await releaseHeld(deps, state, reservation)
      throw error
    }
    state.satisfied.add(group)
    return
  }
}

/** Why a run could not be taken: another worker holds it and the message should come back later. */
export class RunBusyError extends Error {
  constructor() {
    super('the run is held by another worker')
    this.name = 'RunBusyError'
  }
}

/**
 * Executes one enrichment run: for each requested group it asks the Organization's providers in
 * order, stopping at the first that fills. Before every provider call it checks the run ceiling
 * and reserves the price against the month's budget; when either is spent the run ends `stopped`
 * with the reason and no further call is made. Every attempt is recorded as it happens, so a
 * retried message resumes from the last attempt instead of calling a provider twice. What was
 * found is written to core once, at the end, idempotently on the run id.
 */
export async function execute(
  deps: EnrichmentDeps,
  organizationId: OrganizationId,
  runId: EnrichmentRunId
): Promise<void> {
  try {
    await executeClaimed(deps, organizationId, runId)
  } catch (error) {
    if (!(error instanceof LeaseLostError)) {
      throw error
    }
    // Another worker took the run after the lease ran out; it owns the run and its result now.
    deps.logger.warn('run lease lost', { runId })
  }
}

/** The body of {@link execute}; throws {@link LeaseLostError} when the lease is taken over. */
async function executeClaimed(
  deps: EnrichmentDeps,
  organizationId: OrganizationId,
  runId: EnrichmentRunId
): Promise<void> {
  const claim = await deps.store.claim(
    organizationId,
    runId,
    deps.clock.now(),
    deps.limits.runLeaseSeconds
  )
  if (claim.kind === 'busy') {
    throw new RunBusyError()
  }
  if (claim.kind !== 'claimed') {
    return
  }
  const run = claim.run
  const input = await deps.core.getEnrichmentInput(organizationId, run.prospectId)
  if (input === null) {
    await deps.store.finish(organizationId, runId, claim.lease, {
      status: 'incomplete',
      stopReason: null,
      emailVerification: run.emailVerification,
      applications: [],
      completedAt: deps.clock.now(),
    })
    return
  }
  const settings = new Map<ProviderKey, ProviderSetting>(
    (await deps.config.list(organizationId)).map((setting) => [setting.provider, setting])
  )
  const state: State = {
    organizationId,
    run,
    known: { ...input.values },
    fields: [...run.fields],
    position: run.attempts.length,
    cost: run.costMicros,
    verification: run.emailVerification,
    satisfied: new Set(),
    stop: null,
    lease: claim.lease,
  }
  for (const field of run.fields) {
    state.known[field.field] = field.value
  }
  for (const attempt of run.attempts) {
    if (attempt.outcome === 'filled') {
      state.satisfied.add(attempt.group)
    }
  }
  const skippedForBudget = run.attempts.find((attempt) => attempt.outcome === 'skipped_budget')
  if (skippedForBudget !== undefined) {
    // A crash after the skip was recorded must not lose the stop: work out why it was taken.
    const price =
      [...deps.providers, ...deps.verifiers].find((p) => p.key === skippedForBudget.provider)
        ?.priceMicros ?? 0
    state.stop = state.cost + price > run.ceilingMicros ? 'run_ceiling' : 'monthly_budget'
  }

  for (const group of run.groups) {
    if (state.stop !== null) {
      break
    }
    if (state.satisfied.has(group)) {
      continue
    }
    if (group === 'email_verification') {
      await verifyEmail(deps, state, settings)
    } else {
      await fillGroup(deps, state, group, settings)
    }
  }

  const applications: { field: EnrichedFieldName; application: Provenance['application'] }[] = []
  if (state.fields.length > 0) {
    const writes: EnrichedFieldWrite[] = state.fields.map((field) => ({
      field: field.field,
      value: field.value,
      provider: field.provider as ProviderKey,
      confidence: field.confidence,
      obtainedAt: field.obtainedAt,
    }))
    state.lease = await deps.store.renewLease(organizationId, runId, state.lease, deps.clock.now())
    const answer = await deps.core.writeEnrichedFields(organizationId, run.prospectId, {
      runId,
      fields: writes,
    })
    applications.push(...answer.results)
  }
  const complete = run.groups.every((group) => state.satisfied.has(group))
  await deps.store.finish(organizationId, runId, state.lease, {
    status: state.stop !== null ? 'stopped' : complete ? 'complete' : 'incomplete',
    stopReason: state.stop,
    emailVerification: state.verification,
    applications,
    completedAt: deps.clock.now(),
  })
}
