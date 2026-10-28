import { postJson, type VendorBounds, VendorCallError } from '~/adapters/vendor-retry'
import { type WebResult, type WebSearch, WebSearchTimeoutError } from '~/ports/web-search'

/** Options for {@link createExaWebSearch}. */
export type ExaOptions = VendorBounds & {
  apiKey: string
  /** Exa's origin, e.g. `https://api.exa.ai`. */
  baseUrl: string
  now: () => Date
}

const MAX_TITLE = 300
const MAX_SNIPPET = 1_000
const MAX_URL = 2_048

/** A page from Exa's untrusted JSON, or null when it has no usable http(s) URL. */
function pageOf(value: unknown, retrievedAt: string): WebResult | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const r = value as Record<string, unknown>
  if (typeof r.url !== 'string' || r.url.length > MAX_URL) {
    return null
  }
  try {
    if (!['http:', 'https:'].includes(new URL(r.url).protocol)) {
      return null
    }
  } catch {
    return null
  }
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const highlight = Array.isArray(r.highlights)
    ? r.highlights.find((h) => typeof h === 'string')
    : ''
  return {
    url: r.url,
    title: str(r.title, MAX_TITLE),
    snippet: str(typeof r.text === 'string' ? r.text : highlight, MAX_SNIPPET),
    retrievedAt,
  }
}

/**
 * Exa's search API as a {@link WebSearch}. The request signal is the deadline: when it aborts,
 * the search throws {@link WebSearchTimeoutError} (Exa answers all at once, so nothing is partial).
 * Results are untrusted and cut to the limits above.
 */
export function createExaWebSearch(options: ExaOptions): WebSearch {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/search`
  return {
    async search({ query, maxResults, signal }) {
      let body: unknown
      try {
        body = await postJson(
          options,
          url,
          { 'x-api-key': options.apiKey },
          { query, numResults: maxResults, contents: { text: { maxCharacters: MAX_SNIPPET } } },
          signal
        )
      } catch (error) {
        if (error instanceof VendorCallError && error.failure === 'timeout') {
          throw new WebSearchTimeoutError([])
        }
        throw error instanceof VendorCallError ? new Error(`web search: ${error.failure}`) : error
      }
      const results = (body as { results?: unknown } | null)?.results
      if (!Array.isArray(results)) {
        throw new Error('web search: invalid_response')
      }
      const retrievedAt = options.now().toISOString()
      return results
        .map((r) => pageOf(r, retrievedAt))
        .filter((p): p is WebResult => p !== null)
        .slice(0, maxResults)
    },
  }
}
