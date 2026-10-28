import { and, asc, desc, eq, gte, lt, or, sql } from 'drizzle-orm'
import {
  type FitCriterion,
  fitConditionSchema,
  fitScoreSchema,
  MAX_FIT_CRITERIA,
} from 'tula-closeline-contract'
import { fitCriteria, fitScores, signalSettings } from 'tula-closeline-db/schema'
import { CriterionRefusedError, type FitStore } from '~/ports/fit-store'
import type { InOrganization } from './store'

type Tx = Parameters<Parameters<InOrganization>[1]>[0]
type Row = typeof fitCriteria.$inferSelect

function criterionOf(row: Row): FitCriterion {
  return {
    id: row.id as FitCriterion['id'],
    name: row.name,
    field: row.field,
    condition: fitConditionSchema.parse(row.condition),
    weight: row.weight,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** The fit store over Postgres: every call runs in one Organization-scoped transaction. */
export function createPostgresFitStore(inOrganization: InOrganization): FitStore {
  const lock = (tx: Tx, organizationId: string) =>
    tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`)
  const version = async (tx: Tx, organizationId: string) => {
    const [row] = await tx
      .select({ v: signalSettings.criteriaVersion })
      .from(signalSettings)
      .where(eq(signalSettings.organizationId, organizationId))
    return row?.v ?? 0
  }
  const bump = (tx: Tx, organizationId: string) =>
    tx
      .insert(signalSettings)
      .values({ organizationId, kinds: [], criteriaVersion: 1 })
      .onConflictDoUpdate({
        target: signalSettings.organizationId,
        set: { criteriaVersion: sql`${signalSettings.criteriaVersion} + 1` },
      })
  const named = async (tx: Tx, organizationId: string, name: string) => {
    const [row] = await tx
      .select()
      .from(fitCriteria)
      .where(
        and(
          eq(fitCriteria.organizationId, organizationId),
          sql`lower(${fitCriteria.name}) = lower(${name})`
        )
      )
    return row
  }
  return {
    list: (organizationId, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(fitCriteria)
          .where(
            and(
              eq(fitCriteria.organizationId, organizationId),
              after === null
                ? undefined
                : or(
                    sql`${fitCriteria.createdAt} > ${new Date(after.createdAt)}`,
                    and(
                      eq(fitCriteria.createdAt, new Date(after.createdAt)),
                      sql`${fitCriteria.id} > ${after.id}`
                    )
                  )
            )
          )
          .orderBy(asc(fitCriteria.createdAt), asc(fitCriteria.id))
          .limit(limit + 1)
        const items = rows.slice(0, limit).map(criterionOf)
        const last = items.at(-1)
        return {
          items,
          next:
            rows.length > limit && last !== undefined
              ? { createdAt: last.createdAt, id: last.id }
              : null,
          criteriaVersion: await version(tx, organizationId),
        }
      }),

    enabled: (organizationId) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(fitCriteria)
          .where(and(eq(fitCriteria.organizationId, organizationId), eq(fitCriteria.enabled, true)))
          .orderBy(asc(fitCriteria.createdAt), asc(fitCriteria.id))
          .limit(MAX_FIT_CRITERIA)
        return {
          criteria: rows.map(criterionOf),
          criteriaVersion: await version(tx, organizationId),
        }
      }),

    create: (organizationId, criterion) =>
      inOrganization(organizationId, async (tx) => {
        await lock(tx, organizationId)
        const count = await tx.$count(fitCriteria, eq(fitCriteria.organizationId, organizationId))
        if (count >= MAX_FIT_CRITERIA || (await named(tx, organizationId, criterion.name))) {
          throw new CriterionRefusedError()
        }
        await tx.insert(fitCriteria).values({
          id: criterion.id,
          organizationId,
          name: criterion.name,
          field: criterion.field,
          condition: criterion.condition,
          weight: criterion.weight,
          enabled: criterion.enabled,
          createdAt: new Date(criterion.createdAt),
          updatedAt: new Date(criterion.updatedAt),
        })
        await bump(tx, organizationId)
      }),

    byName: (organizationId, name) =>
      inOrganization(organizationId, async (tx) => {
        const row = await named(tx, organizationId, name)
        return row === undefined ? null : criterionOf(row)
      }),

    update: (organizationId, criterionId, change) =>
      inOrganization(organizationId, async (tx) => {
        await lock(tx, organizationId)
        const [row] = await tx
          .select()
          .from(fitCriteria)
          .where(
            and(eq(fitCriteria.organizationId, organizationId), eq(fitCriteria.id, criterionId))
          )
        if (row === undefined) {
          return null
        }
        const next = change(criterionOf(row))
        const clash = await named(tx, organizationId, next.name)
        if (clash !== undefined && clash.id !== criterionId) {
          throw new CriterionRefusedError()
        }
        await tx
          .update(fitCriteria)
          .set({
            name: next.name,
            field: next.field,
            condition: next.condition,
            weight: next.weight,
            enabled: next.enabled,
            updatedAt: new Date(next.updatedAt),
          })
          .where(
            and(eq(fitCriteria.organizationId, organizationId), eq(fitCriteria.id, criterionId))
          )
        await bump(tx, organizationId)
        return next
      }),

    remove: (organizationId, criterionId) =>
      inOrganization(organizationId, async (tx) => {
        await lock(tx, organizationId)
        const gone = await tx
          .delete(fitCriteria)
          .where(
            and(eq(fitCriteria.organizationId, organizationId), eq(fitCriteria.id, criterionId))
          )
          .returning({ id: fitCriteria.id })
        if (gone.length === 0) {
          return false
        }
        await bump(tx, organizationId)
        return true
      }),

    score: (organizationId, prospectId) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(fitScores)
          .where(
            and(eq(fitScores.organizationId, organizationId), eq(fitScores.prospectId, prospectId))
          )
        return row === undefined ? null : scoreOf(row)
      }),

    saveScore: (organizationId, score) =>
      inOrganization(organizationId, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${score.prospectId}`}, 1))`
        )
        const [previous] = await tx
          .select({ score: fitScores.score })
          .from(fitScores)
          .where(
            and(
              eq(fitScores.organizationId, organizationId),
              eq(fitScores.prospectId, score.prospectId)
            )
          )
        const values = {
          score: score.score,
          maxScore: score.maxScore,
          matches: score.matches,
          criteriaVersion: score.criteriaVersion,
          scoredAt: new Date(score.scoredAt),
        }
        await tx
          .insert(fitScores)
          .values({ organizationId, prospectId: score.prospectId, ...values })
          .onConflictDoUpdate({
            target: [fitScores.organizationId, fitScores.prospectId],
            set: values,
          })
        return previous?.score ?? null
      }),

    listScores: (organizationId, filter) =>
      inOrganization(organizationId, async (tx) => {
        const after = filter.after
        const rows = await tx
          .select()
          .from(fitScores)
          .where(
            and(
              eq(fitScores.organizationId, organizationId),
              gte(fitScores.score, filter.minScore),
              after === null
                ? undefined
                : or(
                    lt(fitScores.score, after.score),
                    and(
                      eq(fitScores.score, after.score),
                      lt(fitScores.prospectId, after.prospectId)
                    )
                  )
            )
          )
          .orderBy(desc(fitScores.score), desc(fitScores.prospectId))
          .limit(filter.limit + 1)
        const items = rows.slice(0, filter.limit).map(scoreOf)
        const last = items.at(-1)
        return {
          items,
          next:
            rows.length > filter.limit && last !== undefined
              ? { score: last.score, prospectId: last.prospectId }
              : null,
        }
      }),
  }
}

function scoreOf(row: typeof fitScores.$inferSelect) {
  return fitScoreSchema.parse({
    prospectId: row.prospectId,
    score: row.score,
    maxScore: row.maxScore,
    matches: row.matches,
    criteriaVersion: row.criteriaVersion,
    scoredAt: row.scoredAt.toISOString(),
  })
}
