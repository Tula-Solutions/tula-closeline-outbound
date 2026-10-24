import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import {
  type EnrichmentAttempt,
  type EnrichmentRun,
  type EnrichmentRunSet,
  enrichmentRunSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { enrichmentAttempts, enrichmentRuns, enrichmentSpend } from 'tula-closeline-db/schema'
import type { Claim, EnrichmentStore, RunFilter, RunPage } from '~/ports/store'

/** Runs one unit of work in a transaction scoped to one Organization (the container's `withOrganization`). */
export type InOrganization = <T>(
  organizationId: string,
  fn: (tx: Transaction) => Promise<T>
) => Promise<T>

type RunRow = typeof enrichmentRuns.$inferSelect
type AttemptRow = typeof enrichmentAttempts.$inferSelect

/** The contract's attempt from its row; `position` is the row's order and is not part of the contract. */
function attemptOf(row: AttemptRow): EnrichmentAttempt {
  return {
    provider: row.provider,
    group: row.fieldGroup,
    outcome: row.outcome,
    failure: row.failure,
    costMicros: row.costMicros,
    startedAt: row.startedAt.toISOString(),
    durationMs: row.durationMs,
  }
}

/** The contract's run from its row and its attempts; the stored JSON is parsed, not trusted. */
function runOf(row: RunRow, attempts: readonly AttemptRow[]): EnrichmentRun {
  return {
    id: enrichmentRunSchema.shape.id.parse(row.id),
    runSetId: enrichmentRunSchema.shape.runSetId.parse(row.runSetId),
    prospectId: enrichmentRunSchema.shape.prospectId.parse(row.prospectId),
    status: row.status,
    stopReason: row.stopReason,
    groups: enrichmentRunSchema.shape.groups.parse(row.groups),
    attempts: attempts.map(attemptOf),
    fields: enrichmentRunSchema.shape.fields.parse(row.fields),
    emailVerification: enrichmentRunSchema.shape.emailVerification.parse(row.emailVerification),
    costMicros: row.costMicros,
    ceilingMicros: row.ceilingMicros,
    requestedByUserId: enrichmentRunSchema.shape.requestedByUserId.parse(row.requestedByUserId),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt === null ? null : row.startedAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  }
}

/** Loads the attempts of these runs in one query (a page holds at most a hundred runs) and builds the runs. */
async function hydrate(tx: Transaction, rows: readonly RunRow[]): Promise<EnrichmentRun[]> {
  if (rows.length === 0) {
    return []
  }
  const attempts = await tx
    .select()
    .from(enrichmentAttempts)
    .where(
      inArray(
        enrichmentAttempts.runId,
        rows.map((row) => row.id)
      )
    )
    .orderBy(asc(enrichmentAttempts.runId), asc(enrichmentAttempts.position))
  return rows.map((row) =>
    runOf(
      row,
      attempts.filter((attempt) => attempt.runId === row.id)
    )
  )
}

/**
 * The store in Postgres, always inside the Organization's transaction (forced row-level security).
 * The run row is the idempotency record: (Organization, Prospect, request id) is unique, a worker
 * takes a run with one atomic update, and the budget is checked under an Organization-wide lock.
 * `started_at` doubles as the claim time, so a run whose worker died is taken again after the lease.
 */
export function createPostgresEnrichmentStore(inOrganization: InOrganization): EnrichmentStore {
  return {
    async createRuns(organizationId, runs) {
      if (runs.length === 0) {
        return 0
      }
      return inOrganization(organizationId, async (tx) => {
        const created = await tx
          .insert(enrichmentRuns)
          .values(
            runs.map((run) => ({
              id: run.id,
              organizationId,
              runSetId: run.runSetId,
              prospectId: run.prospectId,
              requestId: run.requestId,
              groups: [...run.groups],
              ceilingMicros: run.ceilingMicros,
              requestedByUserId: run.requestedByUserId,
              createdAt: run.createdAt,
            }))
          )
          .onConflictDoNothing({
            target: [
              enrichmentRuns.organizationId,
              enrichmentRuns.prospectId,
              enrichmentRuns.requestId,
            ],
          })
          .returning({ id: enrichmentRuns.id })
        return created.length
      })
    },

    async findByRequest(organizationId, prospectIds, requestId) {
      if (prospectIds.length === 0) {
        return []
      }
      return inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(enrichmentRuns)
          .where(
            and(
              eq(enrichmentRuns.organizationId, organizationId),
              eq(enrichmentRuns.requestId, requestId),
              inArray(enrichmentRuns.prospectId, [...prospectIds])
            )
          )
          .orderBy(desc(enrichmentRuns.createdAt), desc(enrichmentRuns.id))
        return hydrate(tx, rows)
      })
    },

    async claim(organizationId, runId, now, leaseSeconds): Promise<Claim> {
      return inOrganization(organizationId, async (tx) => {
        const expired = new Date(now.getTime() - leaseSeconds * 1000)
        const taken = await tx
          .update(enrichmentRuns)
          .set({ status: 'running', startedAt: now })
          .where(
            and(
              eq(enrichmentRuns.organizationId, organizationId),
              eq(enrichmentRuns.id, runId),
              or(
                eq(enrichmentRuns.status, 'queued'),
                and(
                  eq(enrichmentRuns.status, 'running'),
                  sql`${enrichmentRuns.startedAt} <= ${expired.toISOString()}::timestamptz`
                )
              )
            )
          )
          .returning()
        const row = taken[0]
        if (row !== undefined) {
          return { kind: 'claimed', run: (await hydrate(tx, [row]))[0] as EnrichmentRun }
        }
        const [current] = await tx
          .select({ status: enrichmentRuns.status })
          .from(enrichmentRuns)
          .where(
            and(eq(enrichmentRuns.organizationId, organizationId), eq(enrichmentRuns.id, runId))
          )
        if (current === undefined) {
          return { kind: 'missing' }
        }
        return current.status === 'running' ? { kind: 'busy' } : { kind: 'finished' }
      })
    },

    async reserveSpend(organizationId, month, provider, priceMicros, limitMicros) {
      return inOrganization(organizationId, async (tx) => {
        // One reservation at a time per Organization, so two runs cannot both pass the check.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`)
        const [sum] = await tx
          .select({ total: sql<string>`coalesce(sum(${enrichmentSpend.costMicros}), 0)` })
          .from(enrichmentSpend)
          .where(
            and(
              eq(enrichmentSpend.organizationId, organizationId),
              eq(enrichmentSpend.month, month)
            )
          )
        if (Number(sum?.total ?? 0) + priceMicros > limitMicros) {
          return false
        }
        await tx
          .insert(enrichmentSpend)
          .values({ organizationId, month, provider, costMicros: priceMicros, calls: 1 })
          .onConflictDoUpdate({
            target: [
              enrichmentSpend.organizationId,
              enrichmentSpend.month,
              enrichmentSpend.provider,
            ],
            set: {
              costMicros: sql`${enrichmentSpend.costMicros} + ${priceMicros}`,
              calls: sql`${enrichmentSpend.calls} + 1`,
              updatedAt: sql`now()`,
            },
          })
        return true
      })
    },

    async releaseSpend(organizationId, month, provider, priceMicros) {
      await inOrganization(organizationId, async (tx) => {
        await tx
          .update(enrichmentSpend)
          .set({
            costMicros: sql`greatest(0, ${enrichmentSpend.costMicros} - ${priceMicros})`,
            calls: sql`greatest(0, ${enrichmentSpend.calls} - 1)`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(enrichmentSpend.organizationId, organizationId),
              eq(enrichmentSpend.month, month),
              eq(enrichmentSpend.provider, provider)
            )
          )
      })
    },

    async recordAttempt(organizationId, runId, attempt, fields, verification) {
      await inOrganization(organizationId, async (tx) => {
        await tx.insert(enrichmentAttempts).values({
          organizationId,
          runId,
          position: attempt.position,
          provider: attempt.provider,
          fieldGroup: attempt.group,
          outcome: attempt.outcome,
          failure: attempt.failure,
          costMicros: attempt.costMicros,
          startedAt: new Date(attempt.startedAt),
          durationMs: attempt.durationMs,
        })
        await tx
          .update(enrichmentRuns)
          .set({
            costMicros: sql`${enrichmentRuns.costMicros} + ${attempt.costMicros}`,
            fields: sql`${enrichmentRuns.fields} || ${JSON.stringify(fields)}::jsonb`,
            ...(verification === undefined ? {} : { emailVerification: verification }),
          })
          .where(
            and(eq(enrichmentRuns.organizationId, organizationId), eq(enrichmentRuns.id, runId))
          )
      })
    },

    async finish(organizationId, runId, end) {
      await inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select({ fields: enrichmentRuns.fields })
          .from(enrichmentRuns)
          .where(
            and(eq(enrichmentRuns.organizationId, organizationId), eq(enrichmentRuns.id, runId))
          )
          .for('update')
        if (row === undefined) {
          throw new Error('run not found')
        }
        const fields = enrichmentRunSchema.shape.fields.parse(row.fields).map((field) => ({
          ...field,
          application:
            end.applications.find((entry) => entry.field === field.field)?.application ??
            field.application,
        }))
        await tx
          .update(enrichmentRuns)
          .set({
            status: end.status,
            stopReason: end.stopReason,
            emailVerification: end.emailVerification,
            fields,
            completedAt: end.completedAt,
          })
          .where(
            and(eq(enrichmentRuns.organizationId, organizationId), eq(enrichmentRuns.id, runId))
          )
      })
    },

    async getRun(organizationId, runId) {
      return inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(enrichmentRuns)
          .where(
            and(eq(enrichmentRuns.organizationId, organizationId), eq(enrichmentRuns.id, runId))
          )
        return (await hydrate(tx, rows))[0] ?? null
      })
    },

    async getRunSet(organizationId, runSetId): Promise<EnrichmentRunSet | null> {
      return inOrganization(organizationId, async (tx) => {
        const groups = await tx
          .select({
            status: enrichmentRuns.status,
            runs: sql<string>`count(*)`,
            cost: sql<string>`coalesce(sum(${enrichmentRuns.costMicros}), 0)`,
            createdAt: sql<Date>`min(${enrichmentRuns.createdAt})`,
            completedAt: sql<Date | null>`max(${enrichmentRuns.completedAt})`,
            requestedBy: sql<string | null>`min(${enrichmentRuns.requestedByUserId})`,
          })
          .from(enrichmentRuns)
          .where(
            and(
              eq(enrichmentRuns.organizationId, organizationId),
              eq(enrichmentRuns.runSetId, runSetId)
            )
          )
          .groupBy(enrichmentRuns.status)
        if (groups.length === 0) {
          return null
        }
        const counts: Record<RunRow['status'], number> = {
          queued: 0,
          running: 0,
          complete: 0,
          incomplete: 0,
          stopped: 0,
        }
        let total = 0
        let cost = 0
        let created = null as Date | null
        let completed = null as Date | null
        let requestedBy: string | null = null
        for (const group of groups) {
          const n = Number(group.runs)
          counts[group.status] = n
          total += n
          cost += Number(group.cost)
          const createdAt = new Date(group.createdAt)
          created = created === null || createdAt < created ? createdAt : created
          if (group.completedAt !== null) {
            const at = new Date(group.completedAt)
            completed = completed === null || at > completed ? at : completed
          }
          requestedBy = requestedBy ?? group.requestedBy
        }
        const done = counts.queued === 0 && counts.running === 0
        return {
          id: runSetId,
          total,
          counts,
          costMicros: cost,
          done,
          requestedByUserId: enrichmentRunSchema.shape.requestedByUserId.parse(requestedBy),
          createdAt: (created ?? new Date(0)).toISOString(),
          completedAt: done && completed !== null ? completed.toISOString() : null,
        }
      })
    },

    async listRuns(organizationId, filter: RunFilter): Promise<RunPage> {
      if (filter.requestedBy !== undefined && filter.requestedBy.length === 0) {
        return { items: [], next: null }
      }
      return inOrganization(organizationId, async (tx) => {
        const after = filter.after
        const conditions = [
          eq(enrichmentRuns.organizationId, organizationId),
          filter.requestedBy === undefined
            ? undefined
            : inArray(enrichmentRuns.requestedByUserId, [...filter.requestedBy]),
          filter.prospectId === undefined
            ? undefined
            : eq(enrichmentRuns.prospectId, filter.prospectId),
          filter.runSetId === undefined ? undefined : eq(enrichmentRuns.runSetId, filter.runSetId),
          filter.status === undefined ? undefined : eq(enrichmentRuns.status, filter.status),
          after === undefined
            ? undefined
            : or(
                lt(enrichmentRuns.createdAt, new Date(after.createdAt)),
                and(
                  eq(enrichmentRuns.createdAt, new Date(after.createdAt)),
                  lt(enrichmentRuns.id, after.id)
                )
              ),
        ]
        const rows = await tx
          .select()
          .from(enrichmentRuns)
          .where(and(...conditions))
          .orderBy(desc(enrichmentRuns.createdAt), desc(enrichmentRuns.id))
          .limit(filter.limit + 1)
        const page = rows.slice(0, filter.limit)
        const last = page.at(-1)
        return {
          items: await hydrate(tx, page),
          next:
            rows.length > filter.limit && last !== undefined
              ? { createdAt: last.createdAt.toISOString(), id: last.id }
              : null,
        }
      })
    },

    async monthSpend(organizationId, month) {
      return inOrganization(organizationId, async (tx) => {
        const [sum] = await tx
          .select({ total: sql<string>`coalesce(sum(${enrichmentSpend.costMicros}), 0)` })
          .from(enrichmentSpend)
          .where(
            and(
              eq(enrichmentSpend.organizationId, organizationId),
              eq(enrichmentSpend.month, month)
            )
          )
        return Number(sum?.total ?? 0)
      })
    },
  }
}
