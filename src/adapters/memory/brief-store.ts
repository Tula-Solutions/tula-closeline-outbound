import type { BriefOutcome, BriefStore, StoredBrief } from '~/ports/brief-store'

const newestFirst = (a: StoredBrief, b: StoredBrief) =>
  a.brief.createdAt === b.brief.createdAt
    ? b.brief.id.localeCompare(a.brief.id)
    : b.brief.createdAt.localeCompare(a.brief.createdAt)

/**
 * The Brief store in process memory, for tests and local runs of one instance.
 * shortcut: core serves no Prospect `updatedAt` and the db has no fingerprint column, so there is no
 * Postgres store yet; upgrade when core exposes the Prospect version.
 */
export function createMemoryBriefStore(): BriefStore {
  const byOrganization = new Map<string, StoredBrief[]>()
  const of = (organizationId: string) => byOrganization.get(organizationId) ?? []
  const keyed = new Map<string, { requestHash: string; outcome: Promise<BriefOutcome> }>()
  return {
    async once(organizationId, key, requestHash, build) {
      const id = `${organizationId}:${key}`
      const seen = keyed.get(id)
      if (seen !== undefined) {
        return seen.requestHash === requestHash ? seen.outcome : 'reused'
      }
      const outcome = build()
      keyed.set(id, { requestHash, outcome })
      // A failure is not remembered, so the client can retry under the same key.
      outcome.catch(() => keyed.delete(id))
      return outcome
    },
    async newest(organizationId, prospectId) {
      return (
        of(organizationId)
          .filter((stored) => stored.brief.prospectId === prospectId)
          .sort(newestFirst)[0] ?? null
      )
    },
    async insert(organizationId, stored) {
      byOrganization.set(organizationId, [...of(organizationId), stored])
    },
    async get(organizationId, briefId) {
      return of(organizationId).find((stored) => stored.brief.id === briefId)?.brief ?? null
    },
    async list(organizationId, prospectId, after, limit) {
      return of(organizationId)
        .filter((stored) => stored.brief.prospectId === prospectId)
        .sort(newestFirst)
        .filter(
          (stored) =>
            after === null ||
            stored.brief.createdAt < after.createdAt ||
            (stored.brief.createdAt === after.createdAt && stored.brief.id < after.id)
        )
        .slice(0, limit)
        .map((stored) => stored.brief)
    },
  }
}
