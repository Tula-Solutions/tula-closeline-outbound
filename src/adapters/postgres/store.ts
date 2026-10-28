import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import {
  type EnrichmentAttempt,
  type EnrichmentRun,
  type EnrichmentRunSet,
  enrichmentRunSchema,
  formatId,
  type ProviderKey,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  enrichmentAttempts,
  enrichmentReservations,
  enrichmentRuns,
  enrichmentSpend,
} from 'tula-closeline-db/schema'
import {
  type Claim,
  type EnrichmentStore,
  type Lease,
  LeaseLostError,
  type RunFilter,
  type RunPage,
} from '~/ports/store'

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

/**
 * Releases the open reservations that match, at the time they are released. `greatest` keeps the
 * row's `released_at >= created_at` check true when a test clock runs ahead of the database's.
 */
function releaseOpen(tx: Transaction, organizationId: string, match: ReturnType<typeof and>) {
  return tx
    .update(enrichmentReservations)
    .set({ releasedAt: sql`greatest(now(), ${enrichmentReservations.createdAt})` })
    .where(
      and(
        eq(enrichmentReservations.organizationId, organizationId),
        isNull(enrichmentReservations.releasedAt),
        match
      )
    )
}

/** What the Organization has spent in the month, plus the reservations still open against it. */
async function monthTotal(tx: Transaction, organizationId: string, month: string): Promise<number> {
  const [spent] = await tx
    .select({ total: sql<string>`coalesce(sum(${enrichmentSpend.costMicros}), 0)` })
    .from(enrichmentSpend)
    .where(
      and(eq(enrichmentSpend.organizationId, organizationId), eq(enrichmentSpend.month, month))
    )
  const [held] = await tx
    .select({ total: sql<string>`coalesce(sum(${enrichmentReservations.amountMicros}), 0)` })
    .from(enrichmentReservations)
    .where(
      and(
        eq(enrichmentReservations.organizationId, organizationId),
        eq(enrichmentReservations.month, month),
        isNull(enrichmentReservations.releasedAt)
      )
    )
  return Number(spent?.total ?? 0) + Number(held?.total ?? 0)
}

/** Locks the run's row and proves the caller still holds its lease; otherwise {@link LeaseLostError}. */
async function assertLease(
  tx: Transaction,
  organizationId: string,
  runId: string,
  lease: Lease
): Promise<void> {
  const [row] = await tx
    .select({ id: enrichmentRuns.id })
    .from(enrichmentRuns)
    .where(
      and(
        eq(enrichmentRuns.organizationId, organizationId),
        eq(enrichmentRuns.id, runId),
        eq(enrichmentRuns.status, 'running'),
        eq(enrichmentRuns.leaseToken, lease)
      )
    )
    .for('update')
  if (row === undefined) {
    throw new LeaseLostError()
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
 * A claim sets a fresh `lease_token` and `heartbeat_at`; a run whose heartbeat is older than the
 * lease is taken again. The token is the fencing token: every write by the leaseholder checks that
 * it is still the one the worker claimed with. `started_at` is the true start and never moves
 * after the first claim. A reservation is a row in `enrichment_reservations`, open until released.
 */
export function createPostgresEnrichmentStore(inOrganization: InOrganization): EnrichmentStore {
  return {
    async createRuns(organizationId, runs) {
      if (runs.length === 0) {
        return 0
      }
      const runSetId = runs[0]?.runSetId
      return inOrganization(organizationId, async (tx) => {
        // One run set per idempotency key: serialise requests under the key, and let only the first create.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`runset:${organizationId}:${runSetId}`}))`
        )
        const [present] = await tx
          .select({ id: enrichmentRuns.id })
          .from(enrichmentRuns)
          .where(
            and(
              eq(enrichmentRuns.organizationId, organizationId),
              runSetId === undefined ? undefined : eq(enrichmentRuns.runSetId, runSetId)
            )
          )
          .limit(1)
        if (present !== undefined) {
          return 0
        }
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
          .set({
            status: 'running',
            startedAt: sql`coalesce(${enrichmentRuns.startedAt}, ${now.toISOString()}::timestamptz)`,
            leaseToken: crypto.randomUUID(),
            heartbeatAt: now,
          })
          .where(
            and(
              eq(enrichmentRuns.organizationId, organizationId),
              eq(enrichmentRuns.id, runId),
              or(
                eq(enrichmentRuns.status, 'queued'),
                and(
                  eq(enrichmentRuns.status, 'running'),
                  sql`coalesce(${enrichmentRuns.heartbeatAt}, ${enrichmentRuns.startedAt}) <= ${expired.toISOString()}::timestamptz`
                )
              )
            )
          )
          .returning()
        const row = taken[0]
        if (row !== undefined) {
          // The worker that held the run is fenced out by the new claim, so its hold is dead.
          await releaseOpen(tx, organizationId, eq(enrichmentReservations.runId, runId))
          return {
            kind: 'claimed',
            run: (await hydrate(tx, [row]))[0] as EnrichmentRun,
            lease: row.leaseToken as string,
          }
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

    async renewLease(organizationId, runId, lease, now) {
      return inOrganization(organizationId, async (tx) => {
        const renewed = await tx
          .update(enrichmentRuns)
          .set({ heartbeatAt: now })
          .where(
            and(
              eq(enrichmentRuns.organizationId, organizationId),
              eq(enrichmentRuns.id, runId),
              eq(enrichmentRuns.status, 'running'),
              eq(enrichmentRuns.leaseToken, lease)
            )
          )
          .returning({ id: enrichmentRuns.id })
        if (renewed.length === 0) {
          throw new LeaseLostError()
        }
        return lease
      })
    },

    async reserveSpend(organizationId, request) {
      const { runId, lease, provider, priceMicros, limitMicros, now, holdSeconds } = request
      const month = `${now.toISOString().slice(0, 7)}-01`
      return inOrganization(organizationId, async (tx) => {
        await assertLease(tx, organizationId, runId, lease)
        // One reservation at a time per Organization, so two runs cannot both pass the check.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`)
        // Reservations a dead worker left: this month's open rows are at most one per live run.
        await releaseOpen(
          tx,
          organizationId,
          and(
            eq(enrichmentReservations.month, month),
            sql`${enrichmentReservations.createdAt} <= ${new Date(now.getTime() - holdSeconds * 1000).toISOString()}::timestamptz`
          )
        )
        // One reservation per run at a time.
        await releaseOpen(tx, organizationId, eq(enrichmentReservations.runId, runId))
        if ((await monthTotal(tx, organizationId, month)) + priceMicros > limitMicros) {
          return null
        }
        const holdKey = `${runId}:${crypto.randomUUID()}`
        const [inserted] = await tx
          .insert(enrichmentReservations)
          .values({
            id: formatId('ersv', crypto.randomUUID()),
            organizationId,
            runId,
            provider,
            month,
            amountMicros: priceMicros,
            holdKey,
            createdAt: now,
          })
          .onConflictDoNothing({
            target: [enrichmentReservations.organizationId, enrichmentReservations.holdKey],
          })
          .returning({ id: enrichmentReservations.id })
        if (inserted === undefined) {
          // Unreachable in practice: the key ends in a fresh random uuid. Never hold budget silently.
          throw new Error('reservation key taken')
        }
        return { month, priceMicros, holdKey }
      })
    },

    async releaseSpend(organizationId, runId, lease, reservation) {
      await inOrganization(organizationId, async (tx) => {
        try {
          await assertLease(tx, organizationId, runId, lease)
        } catch (error) {
          if (error instanceof LeaseLostError) {
            return
          }
          throw error
        }
        await releaseOpen(
          tx,
          organizationId,
          eq(enrichmentReservations.holdKey, reservation.holdKey)
        )
      })
    },

    async recordAttempt(organizationId, runId, lease, attempt, fields, extra) {
      const verification = extra?.verification
      const reservation = extra?.reservation
      await inOrganization(organizationId, async (tx) => {
        await assertLease(tx, organizationId, runId, lease)
        if (reservation !== undefined) {
          // The hold becomes spend of the attempt's cost, in the month it was taken from.
          await releaseOpen(
            tx,
            organizationId,
            eq(enrichmentReservations.holdKey, reservation.holdKey)
          )
          if (attempt.costMicros > 0) {
            await tx
              .insert(enrichmentSpend)
              .values({
                organizationId,
                month: reservation.month,
                provider: attempt.provider,
                costMicros: attempt.costMicros,
                calls: 1,
              })
              .onConflictDoUpdate({
                target: [
                  enrichmentSpend.organizationId,
                  enrichmentSpend.month,
                  enrichmentSpend.provider,
                ],
                set: {
                  costMicros: sql`${enrichmentSpend.costMicros} + ${attempt.costMicros}`,
                  calls: sql`${enrichmentSpend.calls} + 1`,
                  updatedAt: sql`now()`,
                },
              })
          }
        }
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

    async finish(organizationId, runId, lease, end) {
      await inOrganization(organizationId, async (tx) => {
        await assertLease(tx, organizationId, runId, lease)
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
      return inOrganization(organizationId, (tx) => monthTotal(tx, organizationId, month))
    },

    async listSpend(organizationId, filter) {
      return inOrganization(organizationId, async (tx) => {
        const after = filter.after
        const rows = await tx
          .select()
          .from(enrichmentSpend)
          .where(
            and(
              eq(enrichmentSpend.organizationId, organizationId),
              filter.month === undefined ? undefined : eq(enrichmentSpend.month, filter.month),
              after === undefined
                ? undefined
                : or(
                    lt(enrichmentSpend.month, after.month),
                    and(
                      eq(enrichmentSpend.month, after.month),
                      gt(enrichmentSpend.provider, after.provider)
                    )
                  )
            )
          )
          .orderBy(desc(enrichmentSpend.month), asc(enrichmentSpend.provider))
          .limit(filter.limit + 1)
        const page = rows.slice(0, filter.limit)
        const last = page.at(-1)
        return {
          items: page.map((r) => ({
            month: r.month,
            provider: r.provider as ProviderKey,
            costMicros: Number(r.costMicros),
            calls: r.calls,
          })),
          next:
            rows.length > filter.limit && last !== undefined
              ? { month: last.month, provider: last.provider }
              : null,
        }
      })
    },
  }
}
