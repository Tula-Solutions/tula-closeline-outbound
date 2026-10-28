import type { ResearchBrief } from 'tula-closeline-contract'
import type { BriefStore } from '~/ports/brief-store'

const newestFirst = (a: ResearchBrief, b: ResearchBrief) =>
  a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)

/** The Brief store in process memory, for tests; the same behaviour as the Postgres one. */
export function createMemoryBriefStore(): BriefStore {
  const byOrganization = new Map<string, ResearchBrief[]>()
  const keyed = new Map<string, ResearchBrief>()
  const of = (organizationId: string) => byOrganization.get(organizationId) ?? []
  const forProspect = (organizationId: string, prospectId: string) =>
    of(organizationId)
      .filter((brief) => brief.prospectId === prospectId)
      .sort(newestFirst)
  return {
    async newest(organizationId, prospectId) {
      return forProspect(organizationId, prospectId)[0] ?? null
    },
    async byRequestKey(organizationId, key) {
      return keyed.get(`${organizationId}:${key}`) ?? null
    },
    async insert(organizationId, brief, requestKey) {
      const winner = keyed.get(`${organizationId}:${requestKey}`)
      if (winner !== undefined) {
        return { brief: winner, created: false }
      }
      keyed.set(`${organizationId}:${requestKey}`, brief)
      byOrganization.set(organizationId, [...of(organizationId), brief])
      return { brief, created: true }
    },
    async get(organizationId, briefId) {
      return of(organizationId).find((brief) => brief.id === briefId) ?? null
    },
    async list(organizationId, prospectId, after, limit) {
      return forProspect(organizationId, prospectId)
        .filter(
          (brief) =>
            after === null ||
            brief.createdAt < after.createdAt ||
            (brief.createdAt === after.createdAt && brief.id < after.id)
        )
        .slice(0, limit)
    },
  }
}
