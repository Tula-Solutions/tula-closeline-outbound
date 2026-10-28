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
import {
  type Claim,
  type EnrichmentStore,
  type Finish,
  type Lease,
  LeaseLostError,
  type NewRun,
  type Provenance,
  type RunFilter,
  type RunPage,
  type SpendRow,
  type StoredVerification,
} from '~/ports/store'

type Row = {
  run: EnrichmentRun
  requestId: string
  /** The last claim or renewal, in ms; the lease runs out `leaseSeconds` after it. */
  heartbeatAt: number | null
  lease: Lease | null
}

/** A reservation on the budget by one run, with the time it was taken; open until `released`. */
type Hold = { runId: string; month: string; priceMicros: number; at: number; released: boolean }

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
  /** Reservations by Organization, then hold key; a released one stays, like its Postgres row. */
  const holds = new Map<string, Map<string, Hold>>()

  const holdsOf = (organizationId: OrganizationId): Map<string, Hold> => {
    let found = holds.get(organizationId)
    if (found === undefined) {
      found = new Map()
      holds.set(organizationId, found)
    }
    return found
  }
  /** The row of a run the caller still holds the lease of; otherwise {@link LeaseLostError}. */
  const held = (organizationId: OrganizationId, runId: string, lease: Lease): Row => {
    const row = rowsOf(organizationId).get(runId)
    if (row === undefined || row.run.status !== 'running' || row.lease !== lease) {
      throw new LeaseLostError()
    }
    return row
  }

  /** Releases the open reservations of one run. */
  const releaseRun = (organizationId: OrganizationId, runId: string): void => {
    for (const hold of holdsOf(organizationId).values()) {
      if (hold.runId === runId) {
        hold.released = true
      }
    }
  }

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
    for (const hold of holdsOf(organizationId).values()) {
      if (hold.month === month && !hold.released) {
        sum += hold.priceMicros
      }
    }
    return sum
  }

  return {
    spendOf,

    async createRuns(organizationId, runs: readonly NewRun[]) {
      const own = rowsOf(organizationId)
      const first = runs[0]
      // One run set per idempotency key: a second request under the key creates nothing.
      if (first !== undefined && [...own.values()].some((r) => r.run.runSetId === first.runSetId)) {
        return 0
      }
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
          heartbeatAt: null,
          lease: null,
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
        row.heartbeatAt !== null &&
        now.getTime() < row.heartbeatAt + leaseSeconds * 1000
      ) {
        return { kind: 'busy' }
      }
      run.status = 'running'
      // The true start stays through a takeover; the token and heartbeat belong to this claim.
      run.startedAt = run.startedAt ?? now.toISOString()
      row.heartbeatAt = now.getTime()
      row.lease = crypto.randomUUID()
      // The worker that held the run is fenced out, so whatever it had reserved is dead.
      releaseRun(organizationId, runId)
      return { kind: 'claimed', run: copy(run), lease: row.lease }
    },

    async renewLease(organizationId, runId, lease, now) {
      const row = held(organizationId, runId, lease)
      row.heartbeatAt = now.getTime()
      return lease
    },

    async reserveSpend(organizationId, request) {
      held(organizationId, request.runId, request.lease)
      const month = `${request.now.toISOString().slice(0, 7)}-01`
      const own = holdsOf(organizationId)
      for (const hold of own.values()) {
        if (request.now.getTime() >= hold.at + request.holdSeconds * 1000) {
          hold.released = true
        }
      }
      releaseRun(organizationId, request.runId)
      if (total(organizationId, month) + request.priceMicros > request.limitMicros) {
        return null
      }
      const holdKey = `${request.runId}:${crypto.randomUUID()}`
      own.set(holdKey, {
        runId: request.runId,
        month,
        priceMicros: request.priceMicros,
        at: request.now.getTime(),
        released: false,
      })
      return { month, priceMicros: request.priceMicros, holdKey }
    },

    async releaseSpend(organizationId, runId, lease) {
      try {
        held(organizationId, runId, lease)
      } catch (error) {
        if (error instanceof LeaseLostError) {
          return
        }
        throw error
      }
      releaseRun(organizationId, runId)
    },

    async recordAttempt(
      organizationId,
      runId,
      lease,
      attempt: EnrichmentAttempt & { position: number },
      fields: readonly Provenance[],
      extra
    ) {
      const row = held(organizationId, runId, lease)
      if (row.run.attempts.length !== attempt.position) {
        throw new Error('attempt position taken')
      }
      const verification: StoredVerification | undefined = extra?.verification
      const reservation = extra?.reservation
      if (reservation !== undefined) {
        releaseRun(organizationId, runId)
        if (attempt.costMicros > 0) {
          const entries = spendOf(organizationId, reservation.month)
          const entry = entries.get(attempt.provider) ?? { costMicros: 0, calls: 0 }
          entries.set(attempt.provider, {
            costMicros: entry.costMicros + attempt.costMicros,
            calls: entry.calls + 1,
          })
        }
      }
      const { position: _position, ...stored } = attempt
      row.run.attempts.push(stored)
      row.run.costMicros += attempt.costMicros
      row.run.fields.push(...fields)
      if (verification !== undefined) {
        row.run.emailVerification = verification
      }
    },

    async finish(organizationId, runId, lease, end: Finish) {
      const row = held(organizationId, runId, lease)
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

    async listSpend(organizationId, filter) {
      const all: SpendRow[] = []
      for (const [key, byProvider] of spend) {
        const [org, month] = key.split('|') as [string, string]
        if (org !== organizationId || (filter.month !== undefined && month !== filter.month)) {
          continue
        }
        for (const [provider, entry] of byProvider) {
          all.push({ month, provider, ...entry })
        }
      }
      all.sort((a, b) => b.month.localeCompare(a.month) || a.provider.localeCompare(b.provider))
      const after = filter.after
      const rest = after
        ? all.filter(
            (r) => r.month < after.month || (r.month === after.month && r.provider > after.provider)
          )
        : all
      const items = rest.slice(0, filter.limit)
      const last = items.at(-1)
      return {
        items,
        next:
          rest.length > items.length && last !== undefined
            ? { month: last.month, provider: last.provider }
            : null,
      }
    },
  }
}
