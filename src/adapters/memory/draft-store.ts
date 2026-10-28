import type { OutreachDraft } from 'tula-closeline-contract'
import type { DraftStore } from '~/ports/draft-store'

type Entry = { draft: OutreachDraft; requestKey: string; regenerateKey: string | null }

/** The Draft store in process memory, for tests; the same behaviour as the Postgres one. */
export function createMemoryDraftStore(): DraftStore {
  const entries = new Map<string, Entry>()
  const at = (organizationId: string, draftId: string) =>
    entries.get(`${organizationId}:${draftId}`)
  const byKey = (organizationId: string, key: string) =>
    [...entries.entries()].find(
      ([id, entry]) => id.startsWith(`${organizationId}:`) && entry.requestKey === key
    )?.[1]
  return {
    async get(organizationId, draftId) {
      return at(organizationId, draftId)?.draft ?? null
    },
    async byRequestKey(organizationId, key) {
      return byKey(organizationId, key)?.draft ?? null
    },
    async regeneratedBy(organizationId, draftId, key) {
      const entry = at(organizationId, draftId)
      return entry?.regenerateKey === key ? entry.draft : null
    },
    async insert(organizationId, draft, requestKey) {
      const winner = byKey(organizationId, requestKey)
      if (winner !== undefined) {
        return winner.draft.prospectId === draft.prospectId
          ? { draft: winner.draft, created: false }
          : 'reused'
      }
      entries.set(`${organizationId}:${draft.id}`, { draft, requestKey, regenerateKey: null })
      return { draft, created: true }
    },
    async revise(organizationId, next, regenerateKey) {
      const entry = at(organizationId, next.id)
      if (entry === undefined) {
        return 'missing'
      }
      if (entry.regenerateKey === regenerateKey) {
        return { draft: entry.draft, created: false }
      }
      if (entry.draft.revision !== next.revision - 1) {
        return 'stale'
      }
      entries.set(`${organizationId}:${next.id}`, { ...entry, draft: next, regenerateKey })
      return { draft: next, created: true }
    },
  }
}
