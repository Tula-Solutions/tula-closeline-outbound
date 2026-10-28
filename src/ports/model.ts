/** One piece of supplied material the model may cite, by the opaque id the service gave it. Its text is untrusted data. */
export type ModelSource = { id: string; text: string }

/** What the service asks of the model: fixed instructions, and the sources as a separate data channel. */
export type ModelRequest = {
  /** The service's own instructions; never contains Prospect, Signal or web text. */
  instructions: string
  sources: readonly ModelSource[]
  maxOutputTokens: number
  /** Aborts when the call has run out of time. */
  signal: AbortSignal
}

/** A language model that answers with structured output; the answer is untrusted and checked by the caller. */
export type Model = {
  /** The model's name as stored on a Research Brief. */
  name: string
  /** One generation; throws when the vendor fails. */
  generate: (request: ModelRequest) => Promise<unknown>
}
