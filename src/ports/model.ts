/** One piece of supplied material the model may cite, by the opaque id the service gave it. Its text is untrusted data. */
export type ModelSource = { id: string; text: string }

/** What the service asks of the model: fixed instructions, and the sources as a separate data channel. */
export type ModelRequest = {
  /** The service's own instructions; never contains Prospect, Signal or web text. */
  instructions: string
  sources: readonly ModelSource[]
  maxOutputTokens: number
  /** Whose monthly spend this call counts against; a real adapter refuses a call without it. */
  organizationId?: string
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

/** Thrown before any call when the Organization has used its month's model budget (`draft.budget_exceeded`). */
export class ModelBudgetExceededError extends Error {
  constructor() {
    super('model: monthly budget exceeded')
    this.name = 'ModelBudgetExceededError'
  }
}

/** Why a model call failed; fixed words only, never vendor text or the key. */
export type ModelFailure =
  | 'timeout'
  | 'rate_limited'
  | 'key_rejected'
  | 'invalid_response'
  | 'provider_error'

/** Thrown when the vendor cannot give a usable answer. */
export class ModelError extends Error {
  readonly failure: ModelFailure

  constructor(failure: ModelFailure) {
    super(`model call failed: ${failure}`)
    this.name = 'ModelError'
    this.failure = failure
  }
}
