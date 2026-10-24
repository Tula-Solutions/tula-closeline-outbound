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

/** The result of trying to take a run for execution. */
export type Claim =
  | { kind: 'claimed'; run: EnrichmentRun }
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
  /** Creates the runs queued. A run whose (Prospect, request id) exists is skipped; returns how many were created. */
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
   * Reserves `priceMicros` against the month's budget before a provider call. False, and nothing
   * reserved, when the month's spend plus the price would pass `limitMicros`. Serialised per Organization.
   */
  reserveSpend: (
    organizationId: OrganizationId,
    month: string,
    provider: ProviderKey,
    priceMicros: number,
    limitMicros: number
  ) => Promise<boolean>
  /** Gives back a reservation for a call that was not billed. */
  releaseSpend: (
    organizationId: OrganizationId,
    month: string,
    provider: ProviderKey,
    priceMicros: number
  ) => Promise<void>
  /** Records one attempt, adds its cost to the run, and stores the fields and the email verdict it found, together. */
  recordAttempt: (
    organizationId: OrganizationId,
    runId: EnrichmentRunId,
    attempt: EnrichmentAttempt & { position: number },
    fields: readonly Provenance[],
    verification?: StoredVerification
  ) => Promise<void>
  /** Ends a run. */
  finish: (organizationId: OrganizationId, runId: EnrichmentRunId, end: Finish) => Promise<void>
  /** One run with its attempts, or null. */
  getRun: (organizationId: OrganizationId, runId: EnrichmentRunId) => Promise<EnrichmentRun | null>
  /** One run set's progress, or null. */
  getRunSet: (
    organizationId: OrganizationId,
    runSetId: EnrichmentRunSetId
  ) => Promise<EnrichmentRunSet | null>
  /** A page of runs, newest first (created time, then id). */
  listRuns: (organizationId: OrganizationId, filter: RunFilter) => Promise<RunPage>
  /** What the Organization has spent on providers in the month (`YYYY-MM-01`), in micro-dollars. */
  monthSpend: (organizationId: OrganizationId, month: string) => Promise<number>
}
