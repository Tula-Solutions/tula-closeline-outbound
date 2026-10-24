import type {
  EnrichmentAttempt,
  EnrichmentRun,
  EnrichmentRunId,
  EnrichmentRunSet,
  EnrichmentRunSetId,
  OrganizationId,
  ProspectId,
  ProviderKey,
} from 'tula-closeline-contract'
import type {
  Claim,
  EnrichmentStore,
  Finish,
  NewRun,
  Provenance,
  RunFilter,
  RunPage,
  StoredVerification,
} from '~/ports/store'

type Row = { run: EnrichmentRun; requestId: string; claimedAt: number | null }

type Spend = { costMicros: number; calls: number }

/** Newest first: later created time, then larger id. */
function newestFirst(a: EnrichmentRun, b: EnrichmentRun): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** A copy that the caller can hold without seeing later changes. */
function copy(run: EnrichmentRun): EnrichmentRun {
  return structuredClone(run)
}

/**
 * The store in process memory, for tests and local runs of one instance. It keeps the behaviour of
 * the Postgres adapter: the (Prospect, request id) uniqueness, the claim with a lease, and the
 * budget check that reserves before a call.
 */
export function createMemoryEnrichmentStore(): EnrichmentStore & {
  /** Every reservation made, in order, for tests that assert on spend. */
  spendOf: (organizationId: OrganizationId, month: string) => Map<ProviderKey, Spend>
} {
  const rows = new Map<string, Map<string, Row>>()
  const spend = new Map<string, Map<ProviderKey, Spend>>()

  const rowsOf = (organizationId: OrganizationId): Map<string, Row> => {
    let found = rows.get(organizationId)
    if (found === undefined) {
      found = new Map()
      rows.set(organizationId, found)
    }
    return found
  }
  const spendOf = (organizationId: OrganizationId, month: string): Map<ProviderKey, Spend> => {
    const key = `${organizationId}|${month}`
    let found = spend.get(key)
    if (found === undefined) {
      found = new Map()
      spend.set(key, found)
    }
    return found
  }
  const total = (organizationId: OrganizationId, month: string): number => {
    let sum = 0
    for (const entry of spendOf(organizationId, month).values()) {
      sum += entry.costMicros
    }
    return sum
  }

  return {
    spendOf,

    async createRuns(organizationId, runs: readonly NewRun[]) {
      const own = rowsOf(organizationId)
      let created = 0
      for (const input of runs) {
        const clash = [...own.values()].some(
          (row) => row.requestId === input.requestId && row.run.prospectId === input.prospectId
        )
        if (clash) {
          continue
        }
        own.set(input.id, {
          requestId: input.requestId,
          claimedAt: null,
          run: {
            id: input.id,
            runSetId: input.runSetId,
            prospectId: input.prospectId,
            status: 'queued',
            stopReason: null,
            groups: [...input.groups],
            attempts: [],
            fields: [],
            emailVerification: null,
            costMicros: 0,
            ceilingMicros: input.ceilingMicros,
            requestedByUserId: input.requestedByUserId,
            createdAt: input.createdAt.toISOString(),
            startedAt: null,
            completedAt: null,
          },
        })
        created += 1
      }
      return created
    },

    async findByRequest(organizationId, prospectIds: readonly ProspectId[], requestId) {
      const wanted = new Set<string>(prospectIds)
      return [...rowsOf(organizationId).values()]
        .filter((row) => row.requestId === requestId && wanted.has(row.run.prospectId))
        .map((row) => copy(row.run))
        .sort(newestFirst)
    },

    async claim(organizationId, runId, now, leaseSeconds): Promise<Claim> {
      const row = rowsOf(organizationId).get(runId)
      if (row === undefined) {
        return { kind: 'missing' }
      }
      const { run } = row
      if (run.status === 'complete' || run.status === 'incomplete' || run.status === 'stopped') {
        return { kind: 'finished' }
      }
      if (
        run.status === 'running' &&
        row.claimedAt !== null &&
        now.getTime() < row.claimedAt + leaseSeconds * 1000
      ) {
        return { kind: 'busy' }
      }
      run.status = 'running'
      // Like the Postgres store, where startedAt is also the lease start: the latest claim.
      run.startedAt = now.toISOString()
      row.claimedAt = now.getTime()
      return { kind: 'claimed', run: copy(run) }
    },

    async reserveSpend(organizationId, month, provider, priceMicros, limitMicros) {
      if (total(organizationId, month) + priceMicros > limitMicros) {
        return false
      }
      const entries = spendOf(organizationId, month)
      const entry = entries.get(provider) ?? { costMicros: 0, calls: 0 }
      entries.set(provider, {
        costMicros: entry.costMicros + priceMicros,
        calls: entry.calls + 1,
      })
      return true
    },

    async releaseSpend(organizationId, month, provider, priceMicros) {
      const entries = spendOf(organizationId, month)
      const entry = entries.get(provider)
      if (entry !== undefined) {
        entries.set(provider, {
          costMicros: Math.max(0, entry.costMicros - priceMicros),
          calls: Math.max(0, entry.calls - 1),
        })
      }
    },

    async recordAttempt(
      organizationId,
      runId,
      attempt: EnrichmentAttempt & { position: number },
      fields: readonly Provenance[],
      verification?: StoredVerification
    ) {
      const row = rowsOf(organizationId).get(runId)
      if (row === undefined) {
        throw new Error('run not found')
      }
      if (row.run.attempts.length !== attempt.position) {
        throw new Error('attempt position taken')
      }
      const { position: _position, ...stored } = attempt
      row.run.attempts.push(stored)
      row.run.costMicros += attempt.costMicros
      row.run.fields.push(...fields)
      if (verification !== undefined) {
        row.run.emailVerification = verification
      }
    },

    async finish(organizationId, runId, end: Finish) {
      const row = rowsOf(organizationId).get(runId)
      if (row === undefined) {
        throw new Error('run not found')
      }
      row.run.status = end.status
      row.run.stopReason = end.stopReason
      row.run.emailVerification = end.emailVerification
      row.run.completedAt = end.completedAt.toISOString()
      row.run.fields = row.run.fields.map((field) => ({
        ...field,
        application:
          end.applications.find((entry) => entry.field === field.field)?.application ??
          field.application,
      }))
    },

    async getRun(organizationId, runId: EnrichmentRunId) {
      const row = rowsOf(organizationId).get(runId)
      return row === undefined ? null : copy(row.run)
    },

    async getRunSet(
      organizationId,
      runSetId: EnrichmentRunSetId
    ): Promise<EnrichmentRunSet | null> {
      const runs = [...rowsOf(organizationId).values()]
        .map((row) => row.run)
        .filter((run) => run.runSetId === runSetId)
      const first = runs[0]
      if (first === undefined) {
        return null
      }
      const counts = { queued: 0, running: 0, complete: 0, incomplete: 0, stopped: 0 }
      for (const run of runs) {
        counts[run.status] += 1
      }
      const done = counts.queued === 0 && counts.running === 0
      const completed = runs.map((run) => run.completedAt).filter((at): at is string => at !== null)
      return {
        id: runSetId,
        total: runs.length,
        counts,
        costMicros: runs.reduce((sum, run) => sum + run.costMicros, 0),
        done,
        requestedByUserId: first.requestedByUserId,
        createdAt: runs.map((run) => run.createdAt).sort()[0] ?? first.createdAt,
        completedAt: done ? ([...completed].sort().at(-1) ?? null) : null,
      }
    },

    async listRuns(organizationId, filter: RunFilter): Promise<RunPage> {
      const requesters = filter.requestedBy === undefined ? undefined : new Set(filter.requestedBy)
      const matching = [...rowsOf(organizationId).values()]
        .map((row) => row.run)
        .filter(
          (run) =>
            (requesters === undefined ||
              (run.requestedByUserId !== null && requesters.has(run.requestedByUserId))) &&
            (filter.prospectId === undefined || run.prospectId === filter.prospectId) &&
            (filter.runSetId === undefined || run.runSetId === filter.runSetId) &&
            (filter.status === undefined || run.status === filter.status) &&
            (filter.after === undefined ||
              run.createdAt < filter.after.createdAt ||
              (run.createdAt === filter.after.createdAt && run.id < filter.after.id))
        )
        .sort(newestFirst)
      const page = matching.slice(0, filter.limit)
      const last = page.at(-1)
      return {
        items: page.map(copy),
        next:
          matching.length > filter.limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      }
    },

    async monthSpend(organizationId, month) {
      return total(organizationId, month)
    },
  }
}
