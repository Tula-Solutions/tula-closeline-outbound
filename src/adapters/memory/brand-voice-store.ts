import type { BrandVoice, OrganizationId } from 'tula-closeline-contract'
import type { BrandVoiceStore } from '~/ports/brand-voice-store'

/** The Brand Voice store in process memory, for tests and local runs of one instance. */
export function createMemoryBrandVoiceStore(): BrandVoiceStore {
  const organizations = new Map<string, BrandVoice[]>()
  const versions = (organizationId: OrganizationId) => {
    let found = organizations.get(organizationId)
    if (found === undefined) {
      found = []
      organizations.set(organizationId, found)
    }
    return found
  }
  return {
    async current(organizationId) {
      const newest = versions(organizationId).at(-1)
      return newest === undefined ? null : structuredClone(newest)
    },
    async save(organizationId, decide) {
      const all = versions(organizationId)
      const newest = all.at(-1)
      const decision = decide(newest === undefined ? null : structuredClone(newest))
      if (decision.kind === 'save') {
        all.push(structuredClone(decision.voice))
        return structuredClone(decision.voice)
      }
      if (newest === undefined) {
        throw new Error('a save with nothing current cannot be unchanged')
      }
      return structuredClone(newest)
    },
    async list(organizationId, before, limit) {
      const rest = versions(organizationId)
        .filter((voice) => before === null || voice.version < before)
        .reverse()
      const items = rest.slice(0, limit).map((voice) => structuredClone(voice))
      const last = items.at(-1)
      return { items, next: rest.length > limit && last !== undefined ? last.version : null }
    },
  }
}
