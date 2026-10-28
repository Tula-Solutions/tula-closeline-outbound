import type { Play } from 'tula-closeline-contract'
import type { PlayFilter, PlayStore } from '~/ports/play-store'

/** Newest first: later created time, then larger id. */
function newestFirst(a: Play, b: Play): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

function matches(play: Play, filter: PlayFilter): boolean {
  return (
    (filter.status === undefined || play.status === filter.status) &&
    (filter.intent === undefined || play.intent === filter.intent) &&
    (filter.source === undefined || play.source === filter.source)
  )
}

/** The Play store in process memory, for tests and local runs of one instance. */
export function createMemoryPlayStore(): PlayStore {
  const organizations = new Map<string, Map<string, Play>>()
  const plays = (organizationId: string) => {
    let found = organizations.get(organizationId)
    if (found === undefined) {
      found = new Map()
      organizations.set(organizationId, found)
    }
    return found
  }
  return {
    async insertIfAbsent(organizationId, play) {
      const all = plays(organizationId)
      const existing = all.get(play.id)
      if (existing !== undefined) {
        return { play: structuredClone(existing), created: false }
      }
      all.set(play.id, structuredClone(play))
      return { play: structuredClone(play), created: true }
    },
    async find(organizationId, id) {
      const found = plays(organizationId).get(id)
      return found === undefined ? null : structuredClone(found)
    },
    async list(organizationId, filter, after, limit) {
      const sorted = [...plays(organizationId).values()]
        .filter((play) => matches(play, filter))
        .sort(newestFirst)
      const start =
        after === null
          ? 0
          : sorted.findIndex((play) => newestFirst({ ...play, ...after }, play) < 0)
      const rest = start === -1 ? [] : sorted.slice(start)
      const items = rest.slice(0, limit).map((play) => structuredClone(play))
      const last = items[items.length - 1]
      return {
        items,
        next:
          rest.length > limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      }
    },
    async modify(organizationId, id, change) {
      const all = plays(organizationId)
      const found = all.get(id)
      if (found === undefined) {
        return null
      }
      const next = structuredClone(change(structuredClone(found)))
      all.set(id, next)
      return structuredClone(next)
    },
  }
}
