import {
  decodeCursor,
  ENRICHMENT_ERRORS,
  type EnrichmentRun,
  type EnrichmentRunId,
  type EnrichmentRunSet,
  type EnrichmentRunSetId,
  ERRORS,
  type ErrorDefinition,
  encodeCursor,
  type FieldGroup,
  formatId,
  type OrganizationId,
  type ProspectId,
  type Role,
  type UserId,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { enrichmentRun as enrichmentRunMessage, registry } from '~/messages'
import type { AccessCaller } from '~/ports/core'
import type { NewRun } from '~/ports/store'
import type { EnrichmentDeps } from './deps'
import { monthOf } from './waterfall'

/** Who is calling, as the verified token says, plus the token itself for core's view rules. */
export type EnrichCaller = AccessCaller & { requestId: string }

const ALL_GROUPS: readonly FieldGroup[] = ['person', 'company', 'email_verification']

/** The largest page a list may ask for. */
export const MAX_PAGE = 100

/** The seconds a busy answer asks the caller to wait. */
const RETRY_AFTER_SECONDS = 5

/** How many messages one `publishBatch` carries. */
const BATCH = 10

const cursorSchema = z.object({ createdAt: z.string().max(64), id: z.string().max(64) })

/** The registry error with this code, from the enrichment or the common registry. */
function errorOf(code: keyof typeof ENRICHMENT_ERRORS | keyof typeof ERRORS): ErrorDefinition {
  return code in ENRICHMENT_ERRORS
    ? ENRICHMENT_ERRORS[code as keyof typeof ENRICHMENT_ERRORS]
    : ERRORS[code as keyof typeof ERRORS]
}

/** The ids of the users whose runs the caller sees; undefined means every run of the Organization. */
async function visibleRequesters(
  deps: EnrichmentDeps,
  caller: { organizationId: OrganizationId; userId: UserId; role: Role }
): Promise<readonly UserId[] | undefined> {
  if (caller.role === 'owner' || caller.role === 'admin') {
    return undefined
  }
  if (caller.role === 'manager') {
    return [caller.userId, ...(await deps.access.teamRepIds(caller.organizationId, caller.userId))]
  }
  return [caller.userId]
}

/** Publishes the run messages, ten at a time. A message the queue refuses fails the call. */
async function publishRuns(
  deps: EnrichmentDeps,
  organizationId: OrganizationId,
  traceId: string,
  runs: readonly { id: EnrichmentRunId; prospectId: ProspectId }[]
): Promise<void> {
  for (let start = 0; start < runs.length; start += BATCH) {
    const chunk = runs.slice(start, start + BATCH).map((run) =>
      registry.create({
        type: enrichmentRunMessage.type,
        payload: { runId: run.id, prospectId: run.prospectId },
        traceId,
        organizationId,
      })
    )
    const result = await deps.queue.publishBatch(chunk)
    if (result.failed.length > 0) {
      throw new RetryAfterError(ERRORS['server.unavailable'], RETRY_AFTER_SECONDS)
    }
  }
}

/** What {@link create} answers: the run set and whether it was already there. */
export type Created = { runSet: EnrichmentRunSet; replay: boolean }

/**
 * Starts enrichment of one Prospect or a bounded set. Nothing proportional to the Organization's
 * size happens here: the runs are created queued and sent to the queue, and the waterfall runs in
 * the consumer. The same idempotency key answers with the same run set and charges nothing twice.
 */
export async function create(
  deps: EnrichmentDeps,
  caller: EnrichCaller,
  input: { prospectIds: readonly ProspectId[]; groups?: readonly FieldGroup[] | undefined },
  idempotencyKey: string
): Promise<Created> {
  const organizationId = caller.organizationId
  const prospectIds = [...new Set(input.prospectIds)]
  const groups = ALL_GROUPS.filter((group) => (input.groups ?? ALL_GROUPS).includes(group))

  const seen = await deps.access.inspect(caller, prospectIds)
  if (seen.notVisible.length > 0) {
    throw domainError(errorOf('enrichment.prospect_not_found'))
  }
  if (input.groups?.includes('email_verification') && seen.withoutEmail.length > 0) {
    throw domainError(errorOf('enrichment.verification_failed'))
  }

  const existing = await deps.store.findByRequest(organizationId, prospectIds, idempotencyKey)
  if (existing.length > 0) {
    return { runSet: await replay(deps, caller, existing, prospectIds, groups), replay: true }
  }

  const spent = await deps.store.monthSpend(organizationId, monthOf(deps.clock.now()))
  if (spent >= deps.limits.monthlyBudgetMicros) {
    throw domainError(errorOf('enrichment.budget_exceeded'))
  }

  const settings = await deps.config.list(organizationId)
  const usable = new Set(
    settings.filter((s) => s.enabled && s.apiKey !== null).map((s) => s.provider)
  )
  for (const group of groups) {
    const served =
      group === 'email_verification'
        ? deps.verifiers.some((v) => usable.has(v.key))
        : deps.providers.some((p) => p.groups.includes(group) && usable.has(p.key))
    if (!served) {
      throw new RetryAfterError(errorOf('enrichment.provider_unavailable'), RETRY_AFTER_SECONDS)
    }
  }

  const now = deps.clock.now()
  const runSetId = formatId('erset', crypto.randomUUID())
  const runs: NewRun[] = prospectIds.map((prospectId) => ({
    id: formatId('erun', crypto.randomUUID()),
    runSetId,
    prospectId,
    requestId: idempotencyKey,
    groups,
    ceilingMicros: deps.limits.runCeilingMicros,
    requestedByUserId: caller.userId,
    createdAt: now,
  }))
  const created = await deps.store.createRuns(organizationId, runs)
  if (created < runs.length) {
    // Another request with the same key got in first: answer as a replay of it.
    const raced = await deps.store.findByRequest(organizationId, prospectIds, idempotencyKey)
    return { runSet: await replay(deps, caller, raced, prospectIds, groups), replay: true }
  }
  await publishRuns(deps, organizationId, caller.requestId, runs)
  const runSet = await deps.store.getRunSet(organizationId, runSetId)
  if (runSet === null) {
    throw domainError(ERRORS['server.internal'])
  }
  return { runSet, replay: false }
}

/** Answers a repeated request, or refuses a key reused for a different request. */
async function replay(
  deps: EnrichmentDeps,
  caller: EnrichCaller,
  existing: readonly EnrichmentRun[],
  prospectIds: readonly ProspectId[],
  groups: readonly FieldGroup[]
): Promise<EnrichmentRunSet> {
  const first = existing[0]
  const sameSet = existing.every((run) => run.runSetId === first?.runSetId)
  const sameGroups = existing.every(
    (run) => run.groups.length === groups.length && groups.every((g) => run.groups.includes(g))
  )
  const sameCaller = existing.every((run) => run.requestedByUserId === caller.userId)
  if (first === undefined || first.runSetId === null || !sameSet || !sameGroups || !sameCaller) {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  const runSet = await deps.store.getRunSet(caller.organizationId, first.runSetId)
  if (runSet === null || runSet.total !== prospectIds.length || existing.length !== runSet.total) {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  // A lost publish is mended by the same call again: queued runs are sent again, and the claim
  // makes a second message for a run that is going on harmless.
  const queued = existing.filter((run) => run.status === 'queued')
  if (queued.length > 0) {
    await publishRuns(deps, caller.organizationId, caller.requestId, queued)
  }
  return runSet
}

/** One run with its attempts, if the caller may see it; otherwise `enrichment.run_not_found`. */
export async function getRun(
  deps: EnrichmentDeps,
  caller: EnrichCaller,
  runId: EnrichmentRunId
): Promise<EnrichmentRun> {
  const run = await deps.store.getRun(caller.organizationId, runId)
  const visible = await visibleRequesters(deps, caller)
  if (
    run === null ||
    (visible !== undefined &&
      (run.requestedByUserId === null || !visible.includes(run.requestedByUserId)))
  ) {
    throw domainError(errorOf('enrichment.run_not_found'))
  }
  return run
}

/** One run set's progress, if the caller may see it; otherwise `enrichment.run_set_not_found`. */
export async function getRunSet(
  deps: EnrichmentDeps,
  caller: EnrichCaller,
  runSetId: EnrichmentRunSetId
): Promise<EnrichmentRunSet> {
  const runSet = await deps.store.getRunSet(caller.organizationId, runSetId)
  const visible = await visibleRequesters(deps, caller)
  if (
    runSet === null ||
    (visible !== undefined &&
      (runSet.requestedByUserId === null || !visible.includes(runSet.requestedByUserId)))
  ) {
    throw domainError(errorOf('enrichment.run_set_not_found'))
  }
  return runSet
}

/** What a list of runs is narrowed by, as the route parsed it. */
export type ListQuery = {
  cursor?: string | undefined
  limit: number
  prospectId?: ProspectId | undefined
  runSetId?: EnrichmentRunSetId | undefined
  status?: EnrichmentRun['status'] | undefined
}

/** A page of the runs the caller may see, newest first, with a cursor to the next page. */
export async function list(
  deps: EnrichmentDeps,
  caller: EnrichCaller,
  query: ListQuery
): Promise<{ items: EnrichmentRun[]; nextCursor: string | null }> {
  let after: { createdAt: string; id: string } | undefined
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, cursorSchema)
    if (after === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
  }
  const page = await deps.store.listRuns(caller.organizationId, {
    requestedBy: await visibleRequesters(deps, caller),
    prospectId: query.prospectId,
    runSetId: query.runSetId,
    status: query.status,
    after,
    limit: Math.min(query.limit, MAX_PAGE),
  })
  return { items: page.items, nextCursor: page.next === null ? null : encodeCursor(page.next) }
}
