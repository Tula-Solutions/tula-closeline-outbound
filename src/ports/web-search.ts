/** One web page found by a search. All text is untrusted data. */
export type WebResult = { url: string; title: string; snippet: string; retrievedAt: string }

/** What a search asks for. */
export type WebSearchRequest = {
  query: string
  /** The most results wanted; the adapter returns no more. */
  maxResults: number
  /** Aborts when the deadline has passed. */
  signal: AbortSignal
}

/** A web search whose deadline passed; `partial` holds what had arrived by then. */
export class WebSearchTimeoutError extends Error {
  readonly partial: readonly WebResult[]

  constructor(partial: readonly WebResult[]) {
    super('web search: timeout')
    this.name = 'WebSearchTimeoutError'
    this.partial = partial
  }
}

/** A live web search; throws {@link WebSearchTimeoutError} when `signal` aborts. */
export type WebSearch = {
  search: (request: WebSearchRequest) => Promise<readonly WebResult[]>
}
