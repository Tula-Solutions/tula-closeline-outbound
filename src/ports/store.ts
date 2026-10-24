import type {
  EnrichmentAttempt,
  EnrichmentRun,
  EnrichmentRunId,
  EnrichmentRunSet,
  EnrichmentRunSetId,
  FieldGroup,
  OrganizationId,
  ProspectId,
  ProviderKey,
  UserId,
} from 'tula-closeline-contract'

/** The contract's field provenance entry, as stored on a run. */
export type Provenance = EnrichmentRun['fields'][number]

/** The email verification result, as stored on a run. */
export type StoredVerification = NonNullable<EnrichmentRun['emailVerification']>

/** A run to create, queued. */
export type NewRun = {
  id: EnrichmentRunId
  runSetId: EnrichmentRunSetId
  prospectId: ProspectId
  requestId: string
  groups: readonly FieldGroup[]
  ceilingMicros: number
  requestedByUserId: UserId
  createdAt: Date
}

/**
 * The fencing token of a run lease: it changes at every claim and every renewal, and every write
 * by the leaseholder is checked against it, so a worker whose lease passed to another is refused.
 */
export type Lease = string

/** Thrown by a store write when the caller's {@link Lease} is no longer the run's current one. */
export class LeaseLostError extends Error {
  constructor() {
    super('the run lease passed to another worker')
    this.name = 'LeaseLostError'
  }
}

/** Budget held for one provider call; it names the month it was taken from, whatever the date is later. */
export type Reservation = { month: string; priceMicros: number }

/** What a reservation asks for. */
export type ReserveRequest = {
  runId: EnrichmentRunId
  lease: Lease
  provider: ProviderKey
  priceMicros: number
  limitMicros: number
  /** When the reservation is made; it decides the month and starts the hold's expiry. */
  now: Date
  /** How long a hold counts against the month before it is treated as left by a crash. */
  holdSeconds: number
}

/** The result of trying to take a run for execution. */
export type Claim =
  | { kind: 'claimed'; run: EnrichmentRun; lease: Lease }
  | { kind: 'busy' }
  | { kind: 'finished' }
  | { kind: 'missing' }

/** How a run ends. */
export type Finish = {
  status: 'complete' | 'incomplete' | 'stopped'
  stopReason: 'monthly_budget' | 'run_ceiling' | null
  emailVerification: StoredVerification | null
  /** How core applied each stored field; the fields are kept `suggested` until core has answered. */
  applications: readonly { field: Provenance['field']; application: Provenance['application'] }[]
  completedAt: Date
}

/** One page of runs, newest first. */
export type RunPage = { items: EnrichmentRun[]; next: { createdAt: string; id: string } | null }

/** What a list of runs is narrowed by. */
export type RunFilter = {
  /** Only runs requested by these users; undefined means every run of the Organization. */
  requestedBy?: readonly UserId[] | undefined
  prospectId?: ProspectId | undefined
  runSetId?: EnrichmentRunSetId | undefined
  status?: EnrichmentRun['status'] | undefined
  after?: { createdAt: string; id: string } | undefined
  limit: number
}

/** Where enrichment runs, their attempts and the Organization's spend are kept. */
export type EnrichmentStore = {
  /**
   * Creates the runs queued, all or none. They share one run set id, and that id is derived from the
   * idempotency key, so when the run set already has runs (an earlier or a concurrent request with
   * the same key) nothing is created and the result is 0. A run whose (Prospect, request id) exists
   * is skipped; returns how many were created.
   */
  createRuns: (organizationId: OrganizationId, runs: readonly NewRun[]) => Promise<number>
  /** The runs already made for these Prospects under this request id. */
  findByRequest: (
    organizationId: OrganizationId,
    prospectIds: readonly ProspectId[],
    requestId: string
  ) => Promise<EnrichmentRun[]>
  /**
   * Takes a queued run, or a running one whose lease has run out, for execution by one worker.
   * Exactly one concurrent caller gets `claimed`.
   */
  claim: (
    organizationId: OrganizationId,
    runId: EnrichmentRunId,
    now: Date,
    leaseSeconds: number
  ) => Promise<Claim>
  /**
   * Renews the lease of a run the worker still holds and returns the new token. Throws
   * {@link LeaseLostError} when another worker has taken the run.
   */
  renewLease: (
    organizationId: OrganizationId,
    runId: EnrichmentRunId,
    lease: Lease,
    now: Date
  ) => Promise<Lease>
  /**
   * Holds `priceMicros` against the month's budget before a provider call; null, and nothing held,
   * when the month's spend and holds plus the price would pass the limit. Serialised per
   * Organization. One hold per run at a time; a hold older than `holdSeconds` (a worker that died)
   * stops counting, and claiming the run again drops it. Throws {@link LeaseLostError}.
   */
  reserveSpend: (
    organizationId: OrganizationId,
    request: ReserveRequest
  ) => Promise<Reservation | null>
  /** Gives back a hold for a call that was not billed, in the month it was taken from. */
  releaseSpend: (
    organizationId: OrganizationId,
    runId: EnrichmentRunId,
    lease: Lease,
    reservation: Reservation
  ) => Promise<void>
  /**
   * Records one attempt, adds its cost to the run, and stores the fields and the email verdict it
   * found, together. When the attempt was made under a `reservation`, the same transaction turns
   * the hold into spend of exactly the attempt's cost (nothing for a failed call), so no crash can
   * leave a hold without its attempt. Throws {@link LeaseLostError}.
   */
  recordAttempt: (
    organizationId: OrganizationId,
    runId: EnrichmentRunId,
    lease: Lease,
    attempt: EnrichmentAttempt & { position: number },
    fields: readonly Provenance[],
    extra?: { verification?: StoredVerification | undefined; reservation?: Reservation | undefined }
  ) => Promise<void>
  /** Ends a run. Throws {@link LeaseLostError}. */
  finish: (
    organizationId: OrganizationId,
    runId: EnrichmentRunId,
    lease: Lease,
    end: Finish
  ) => Promise<void>
  /** One run with its attempts, or null. */
  getRun: (organizationId: OrganizationId, runId: EnrichmentRunId) => Promise<EnrichmentRun | null>
  /** One run set's progress, or null. */
  getRunSet: (
    organizationId: OrganizationId,
    runSetId: EnrichmentRunSetId
  ) => Promise<EnrichmentRunSet | null>
  /** A page of runs, newest first (created time, then id). */
  listRuns: (organizationId: OrganizationId, filter: RunFilter) => Promise<RunPage>
  /** What the Organization has spent on providers in the month (`YYYY-MM-01`), holds included, in micro-dollars. */
  monthSpend: (organizationId: OrganizationId, month: string) => Promise<number>
}
