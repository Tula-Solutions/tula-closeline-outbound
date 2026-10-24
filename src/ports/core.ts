import type {
  EnrichedFieldName,
  FIELD_APPLICATIONS,
  OrganizationId,
  ProspectId,
  ProviderKey,
  Role,
  UserId,
} from 'tula-closeline-contract'
import type { ProspectValues } from '~/ports/enrichment-provider'

/** How core applied a field: `written`, or kept as `suggested` (an own value, or one core cannot store: a taken email or domain, a bad LinkedIn address, a company field with no company). */
export type FieldApplication = (typeof FIELD_APPLICATIONS)[number]

/** What the waterfall reads of a Prospect. */
export type EnrichmentInput = {
  prospectId: ProspectId
  values: ProspectValues
}

/** One field to write back, with the provider it came from. */
export type EnrichedFieldWrite = {
  field: EnrichedFieldName
  value: string
  provider: ProviderKey
  confidence: number
  obtainedAt: string
}

/** Write-back to core (ADR 0013 internal auth: shared secret bearer plus X-Organization-Id, so every call names the Organization). Never overwrites an Organization's own value: that comes back `suggested`. A replay on (prospectId, runId) returns the original results for 24 hours. */
export type CoreProspects = {
  /** The Prospect's current values, or null when it is not there. */
  getEnrichmentInput: (
    organizationId: OrganizationId,
    prospectId: ProspectId
  ) => Promise<EnrichmentInput | null>
  /** Writes fields with source `enrichment:<provider>`; idempotent on (Prospect, run id). */
  writeEnrichedFields: (
    organizationId: OrganizationId,
    prospectId: ProspectId,
    write: { runId: string; fields: readonly EnrichedFieldWrite[] }
  ) => Promise<{ results: { field: EnrichedFieldName; application: FieldApplication }[] }>
}

/** The caller of a request, as access to a Prospect is judged. */
export type AccessCaller = {
  /** The caller's own bearer token, forwarded to core so core's view rules decide. */
  bearer: string
  organizationId: OrganizationId
  userId: UserId
  role: Role
}

/** Which Prospects the caller may enrich, as core sees them. */
export type CoreAccess = {
  /** Ids the caller cannot see (or that do not exist) and ids that have no email address. */
  inspect: (
    caller: AccessCaller,
    prospectIds: readonly ProspectId[]
  ) => Promise<{ notVisible: ProspectId[]; withoutEmail: ProspectId[] }>
  /** The Reps on the Manager's Team, at most one page of them. */
  teamRepIds: (organizationId: OrganizationId, managerId: UserId) => Promise<readonly UserId[]>
}
