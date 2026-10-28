import type { OrganizationId } from 'tula-closeline-contract'
import type { PlaybookPassage, PlaybookSearch } from '~/ports/playbook-search'

/** The Playbook search in memory: passages seeded per Organization, highest score first. */
export type MemoryPlaybookSearch = PlaybookSearch & {
  /** Adds passages to one Organization's Playbook. */
  seed: (organizationId: OrganizationId, passages: readonly PlaybookPassage[]) => void
}

/** Builds the in-memory Playbook search. */
export function createMemoryPlaybookSearch(): MemoryPlaybookSearch {
  const byOrganization = new Map<string, PlaybookPassage[]>()
  return {
    seed: (organizationId, passages) => {
      byOrganization.set(organizationId, [
        ...(byOrganization.get(organizationId) ?? []),
        ...passages,
      ])
    },
    async search(organizationId, { limit }) {
      return [...(byOrganization.get(organizationId) ?? [])]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
  }
}
