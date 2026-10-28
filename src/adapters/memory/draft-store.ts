import type { OutreachDraft } from 'tula-closeline-contract'
import type { DraftStore } from '~/ports/draft-store'

/** How many regeneration keys a Draft remembers; mirrors the database. */
const MAX_REGENERATE_KEYS = 32

type Entry = {
  draft: OutreachDraft
  requestKey: string
  regenerateKeys: string[]
  variantKey: string | null
}

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
      const entry = byKey(organizationId, key)
      return entry === undefined ? null : { draft: entry.draft, variantKey: entry.variantKey }
    },
    async regeneratedBy(organizationId, draftId, key) {
      const entry = at(organizationId, draftId)
      return entry?.regenerateKeys.includes(key) ? entry.draft : null
    },
    async insert(organizationId, draft, requestKey, variantKey) {
      const winner = byKey(organizationId, requestKey)
      if (winner !== undefined) {
        return winner.draft.prospectId === draft.prospectId
          ? { draft: winner.draft, variantKey: winner.variantKey, created: false }
          : 'reused'
      }
      entries.set(`${organizationId}:${draft.id}`, {
        draft,
        requestKey,
        regenerateKeys: [],
        variantKey,
      })
      return { draft, variantKey, created: true }
    },
    async revise(organizationId, next, regenerateKey) {
      const entry = at(organizationId, next.id)
      if (entry === undefined) {
        return 'missing'
      }
      if (entry.regenerateKeys.includes(regenerateKey)) {
        return { draft: entry.draft, variantKey: entry.variantKey, created: false }
      }
      if (entry.draft.revision !== next.revision - 1) {
        return 'stale'
      }
      entries.set(`${organizationId}:${next.id}`, {
        ...entry,
        draft: next,
        regenerateKeys: [...entry.regenerateKeys, regenerateKey].slice(-MAX_REGENERATE_KEYS),
      })
      return { draft: next, variantKey: entry.variantKey, created: true }
    },
  }
}
