import { type WebResult, type WebSearch, WebSearchTimeoutError } from '~/ports/web-search'

/** The web search in memory: fixed pages, optionally stalling after some results until the deadline. */
export type MemoryWebSearch = WebSearch & {
  /** Every query asked, in order (for tests; real adapters never keep them). */
  queries: string[]
  /** Sets the pages every search finds. */
  setPages: (pages: readonly WebResult[]) => void
  /** Makes searches return only `count` results and then wait for the deadline; null stops stalling. */
  stallAfter: (count: number | null) => void
}

/** Builds the in-memory web search. */
export function createMemoryWebSearch(): MemoryWebSearch {
  let pages: readonly WebResult[] = []
  let stall: number | null = null
  const queries: string[] = []
  return {
    queries,
    setPages: (next) => {
      pages = next
    },
    stallAfter: (count) => {
      stall = count
    },
    async search({ query, maxResults, signal }) {
      queries.push(query)
      const found = pages.slice(0, maxResults)
      if (stall === null) {
        return found
      }
      const partial = found.slice(0, stall)
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new WebSearchTimeoutError(partial)
    },
  }
}
