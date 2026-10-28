import {
  type EnrichedFieldName,
  formatId,
  type MembershipId,
  type OrganizationId,
  type ProspectId,
  type ProviderKey,
  type UserId,
} from 'tula-closeline-contract'
import {
  type AccessCaller,
  type CoreAccess,
  CoreProspectNotFoundError,
  type CoreProspects,
  type EnrichmentInput,
  type FieldApplication,
} from '~/ports/core'
import type { ProspectValues } from '~/ports/enrichment-provider'

type Stored = {
  ownerId: UserId
  values: ProspectValues
  /** Fields whose value an import or a person set: enrichment never replaces these. */
  owned: Set<EnrichedFieldName>
  sources: Map<EnrichedFieldName, string>
  suggestions: Map<EnrichedFieldName, { value: string; source: string }>
  replays: Map<string, { field: EnrichedFieldName; application: FieldApplication }[]>
}

/** The Membership id this fake core gives a user: the same hex under the `mem` prefix. */
export function membershipOf(userId: UserId): MembershipId {
  return formatId('mem', userId.slice(userId.indexOf('_') + 1))
}

/** What a test seeds a Prospect with. */
export type SeedProspect = {
  id: ProspectId
  ownerId: UserId
  values?: ProspectValues
  /** Fields set by an import or a person, as opposed to empty ones. */
  owned?: readonly EnrichedFieldName[]
}

/** Core in process memory: the two ports over one set of Prospects, and what tests look at. */
export type MemoryCore = {
  prospects: CoreProspects
  access: CoreAccess
  /** Adds a Prospect to an Organization. */
  seed: (organizationId: OrganizationId, prospect: SeedProspect) => void
  /** Puts Reps on a Manager's Team. */
  setTeam: (organizationId: OrganizationId, managerId: UserId, repIds: readonly UserId[]) => void
  /** Sets a field the way an import does, so enrichment may no longer replace it. */
  importField: (
    organizationId: OrganizationId,
    prospectId: ProspectId,
    field: EnrichedFieldName,
    value: string
  ) => void
  /** The Prospect's values and the source of each. */
  read: (
    organizationId: OrganizationId,
    prospectId: ProspectId
  ) => { values: ProspectValues; sources: Record<string, string> } | undefined
  /** What enrichment offered but did not write over an Organization's own value. */
  suggestionsOf: (
    organizationId: OrganizationId,
    prospectId: ProspectId
  ) => Record<string, { value: string; source: string }>
  /** How many write calls core received, replays included. */
  writeCalls: () => number
}

/**
 * Core's side of enrichment in process memory. Like core (`prospect/fields.ts`), it never lets
 * enrichment replace a value an import or a person set: that value stays and the provider's is
 * kept as `suggested`. A write is idempotent on (Prospect, run id).
 */
export function createMemoryCore(): MemoryCore {
  const prospects = new Map<string, Stored>()
  const teams = new Map<string, readonly UserId[]>()
  let writes = 0

  const key = (organizationId: string, prospectId: string) => `${organizationId}|${prospectId}`
  const find = (organizationId: string, prospectId: string) =>
    prospects.get(key(organizationId, prospectId))

  const core: MemoryCore = {
    seed(organizationId, prospect) {
      prospects.set(key(organizationId, prospect.id), {
        ownerId: prospect.ownerId,
        values: { ...prospect.values },
        owned: new Set(prospect.owned ?? []),
        sources: new Map(),
        suggestions: new Map(),
        replays: new Map(),
      })
    },
    setTeam(organizationId, managerId, repIds) {
      teams.set(`${organizationId}|${managerId}`, repIds)
    },
    importField(organizationId, prospectId, field, value) {
      const found = find(organizationId, prospectId)
      if (found === undefined) {
        throw new Error('prospect not found')
      }
      found.values[field] = value
      found.owned.add(field)
      found.sources.set(field, 'import')
    },
    read(organizationId, prospectId) {
      const found = find(organizationId, prospectId)
      return found === undefined
        ? undefined
        : { values: { ...found.values }, sources: Object.fromEntries(found.sources) }
    },
    suggestionsOf(organizationId, prospectId) {
      return Object.fromEntries(find(organizationId, prospectId)?.suggestions ?? [])
    },
    writeCalls: () => writes,

    prospects: {
      async getEnrichmentInput(organizationId, prospectId): Promise<EnrichmentInput | null> {
        const found = find(organizationId, prospectId)
        return found === undefined ? null : { prospectId, values: { ...found.values } }
      },
      async findProspectIdByEmail(organizationId, email) {
        for (const [entry, found] of prospects) {
          if (
            entry.startsWith(`${organizationId}|`) &&
            found.values.email?.toLowerCase() === email.toLowerCase()
          ) {
            return entry.slice(organizationId.length + 1) as ProspectId
          }
        }
        return null
      },
      async writeEnrichedFields(organizationId, prospectId, write) {
        writes += 1
        const found = find(organizationId, prospectId)
        if (found === undefined) {
          throw new CoreProspectNotFoundError()
        }
        const replay = found.replays.get(write.runId)
        if (replay !== undefined) {
          return { results: replay.map((entry) => ({ ...entry })) }
        }
        const results = write.fields.map((entry) => {
          const source = `enrichment:${entry.provider as ProviderKey}`
          if (found.owned.has(entry.field)) {
            found.suggestions.set(entry.field, { value: entry.value, source })
            return { field: entry.field, application: 'suggested' as const }
          }
          found.values[entry.field] = entry.value
          found.sources.set(entry.field, source)
          return { field: entry.field, application: 'written' as const }
        })
        found.replays.set(write.runId, results)
        return { results: results.map((entry) => ({ ...entry })) }
      },
    },

    access: {
      async inspect(caller: AccessCaller, prospectIds) {
        const reps = new Set<string>(teams.get(`${caller.organizationId}|${caller.userId}`) ?? [])
        const notVisible: ProspectId[] = []
        const withoutEmail: ProspectId[] = []
        for (const id of prospectIds) {
          const found = find(caller.organizationId, id)
          const sees =
            found !== undefined &&
            (caller.role === 'owner' ||
              caller.role === 'admin' ||
              found.ownerId === caller.userId ||
              (caller.role === 'manager' && reps.has(found.ownerId)))
          if (!sees) {
            notVisible.push(id)
          } else if (found.values.email === undefined) {
            withoutEmail.push(id)
          }
        }
        return { notVisible, withoutEmail }
      },
      async teamRepIds(organizationId, managerId) {
        return teams.get(`${organizationId}|${managerId}`) ?? []
      },
      async membershipIdOf(_organizationId, userId) {
        return membershipOf(userId)
      },
    },
  }
  return core
}
