import {
  type CreateFitCriterionRequest,
  decodeCursor,
  ENRICHMENT_ERRORS,
  ERRORS,
  encodeCursor,
  type FitCriterion,
  type FitCriterionId,
  type FitScore,
  fitConditionSuitsField,
  formatId,
  type ProspectId,
  type UpdateFitCriterionRequest,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { domainError } from '~/http/domain-error'
import type { SignalCaller } from '~/modules/signal/service'
import { CriterionRefusedError } from '~/ports/fit-store'
import type { FitDeps } from './deps'
import { evaluate } from './evaluate'

const MAX_PAGE = 100
const invalidCriteria = () => domainError(ENRICHMENT_ERRORS['fit.invalid_criteria'])
const notFound = () => domainError(ENRICHMENT_ERRORS['fit.criterion_not_found'])
const prospectNotFound = () => domainError(ENRICHMENT_ERRORS['enrichment.prospect_not_found'])

const criterionCursor = z.strictObject({ createdAt: z.string().max(40), id: z.string().max(64) })
const scoreCursor = z.strictObject({ score: z.number(), prospectId: z.string().max(64) })

function suits(criterion: FitCriterion) {
  return fitConditionSuitsField(criterion.field, criterion.condition)
}

function sameDefinition(a: FitCriterion, b: FitCriterion) {
  return (
    a.field === b.field &&
    a.weight === b.weight &&
    a.enabled === b.enabled &&
    JSON.stringify(a.condition) === JSON.stringify(b.condition)
  )
}

/** A page of criteria, oldest first, with the version of the whole set. */
export async function listCriteria(
  deps: FitDeps,
  caller: { organizationId: SignalCaller['organizationId'] },
  query: { cursor?: string | undefined; limit: number }
) {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor, criterionCursor)
  if (after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const page = await deps.store.list(caller.organizationId, after, Math.min(query.limit, MAX_PAGE))
  return {
    items: page.items,
    nextCursor: page.next === null ? null : encodeCursor(page.next),
    criteriaVersion: page.criteriaVersion,
  }
}

/** Adds a criterion; the same definition under the same name again answers the first one (`replay`). */
export async function createCriterion(
  deps: FitDeps,
  caller: { organizationId: SignalCaller['organizationId'] },
  body: CreateFitCriterionRequest
): Promise<{ criterion: FitCriterion; replay: boolean }> {
  const now = deps.clock.now().toISOString()
  const criterion: FitCriterion = {
    id: formatId('fcr', crypto.randomUUID().replaceAll('-', '')),
    ...body,
    createdAt: now,
    updatedAt: now,
  }
  if (!suits(criterion)) {
    throw invalidCriteria()
  }
  const existing = await deps.store.byName(caller.organizationId, body.name)
  if (existing !== null) {
    if (sameDefinition(existing, criterion)) {
      return { criterion: existing, replay: true }
    }
    throw invalidCriteria()
  }
  try {
    await deps.store.create(caller.organizationId, criterion)
  } catch (error) {
    if (error instanceof CriterionRefusedError) {
      // A concurrent identical create won the name; this retry is a replay of it.
      const winner = await deps.store.byName(caller.organizationId, body.name)
      if (winner !== null && sameDefinition(winner, criterion)) {
        return { criterion: winner, replay: true }
      }
      throw invalidCriteria()
    }
    throw error
  }
  return { criterion, replay: false }
}

/** Changes parts of a criterion; the merged result must still suit its attribute. */
export async function updateCriterion(
  deps: FitDeps,
  caller: { organizationId: SignalCaller['organizationId'] },
  criterionId: FitCriterionId,
  change: UpdateFitCriterionRequest
): Promise<FitCriterion> {
  let refused = false
  const updated = await deps.store
    .update(caller.organizationId, criterionId, (current) => {
      const next: FitCriterion = {
        ...current,
        ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
        updatedAt: deps.clock.now().toISOString(),
      }
      if (!suits(next)) {
        refused = true
        return current
      }
      return next
    })
    .catch((error: unknown) => {
      if (error instanceof CriterionRefusedError) {
        throw invalidCriteria()
      }
      throw error
    })
  if (refused) {
    throw invalidCriteria()
  }
  if (updated === null) {
    throw notFound()
  }
  return updated
}

/** Removes a criterion; a retry after it is gone also answers success. */
export async function deleteCriterion(
  deps: FitDeps,
  caller: { organizationId: SignalCaller['organizationId'] },
  criterionId: FitCriterionId
): Promise<Record<string, never>> {
  await deps.store.remove(caller.organizationId, criterionId)
  return {}
}

/** Scores the Prospect against the enabled criteria now, stores it, and emits `prospect.fit_changed` when the score moved. */
export async function getProspectFit(
  deps: FitDeps,
  caller: SignalCaller,
  prospectId: ProspectId
): Promise<FitScore> {
  const seen = await deps.access.inspect(caller, [prospectId])
  const input =
    seen.notVisible.length > 0
      ? null
      : await deps.core.getEnrichmentInput(caller.organizationId, prospectId)
  if (input === null) {
    throw prospectNotFound()
  }
  const { criteria, criteriaVersion } = await deps.store.enabled(caller.organizationId)
  const matches = criteria.map((criterion) => ({
    criterionId: criterion.id,
    name: criterion.name,
    weight: criterion.weight,
    result: evaluate(criterion, input.values),
  }))
  const scoredAt = deps.clock.now().toISOString()
  const score: FitScore = {
    prospectId,
    score: matches.reduce((sum, m) => (m.result === 'matched' ? sum + m.weight : sum), 0),
    maxScore: criteria.reduce((sum, c) => sum + c.weight, 0),
    matches,
    criteriaVersion: Math.max(1, criteriaVersion),
    scoredAt,
  }
  const previous = await deps.store.saveScore(caller.organizationId, score)
  if (previous !== score.score) {
    await deps.events(caller.organizationId, {
      name: 'prospect.fit_changed',
      payload: {
        prospectId,
        previousScore: previous,
        score: score.score,
        maxScore: score.maxScore,
        criteriaVersion: score.criteriaVersion,
        changedAt: scoredAt,
      },
    })
  }
  return score
}

/** A page of stored scores, highest first, hiding Prospects the caller cannot see; stored scores can lag a criteria change. */
export async function listScores(
  deps: FitDeps,
  caller: SignalCaller,
  query: { cursor?: string | undefined; limit: number; minScore?: number | undefined }
) {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor, scoreCursor)
  if (after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const page = await deps.store.listScores(caller.organizationId, {
    minScore: query.minScore ?? 0,
    after,
    limit: Math.min(query.limit, MAX_PAGE),
  })
  const hidden = new Set<string>()
  if (page.items.length > 0) {
    const seen = await deps.access.inspect(
      caller,
      page.items.map((item) => item.prospectId)
    )
    for (const id of seen.notVisible) {
      hidden.add(id)
    }
  }
  return {
    items: page.items.filter((item) => !hidden.has(item.prospectId)),
    nextCursor: page.next === null ? null : encodeCursor(page.next),
  }
}
