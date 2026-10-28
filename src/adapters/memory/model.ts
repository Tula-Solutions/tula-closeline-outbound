import type { Model, ModelRequest } from '~/ports/model'

/** The model in memory: answers from a script, or by citing each source it was given. */
export type MemoryModel = Model & {
  /** Every request made, in order. */
  requests: ModelRequest[]
  /** Queues the next answer: a value, a function of the request, or an Error to throw. */
  script: (next: unknown | ((request: ModelRequest) => unknown)) => void
}

/** Builds the in-memory model; with nothing scripted it states each source back, citing it. */
export function createMemoryModel(): MemoryModel {
  const queue: unknown[] = []
  const requests: ModelRequest[] = []
  return {
    name: 'memory-model',
    requests,
    script: (next) => void queue.push(next),
    async generate(request) {
      requests.push(request)
      const next = queue.shift()
      if (next === undefined) {
        return {
          statements: request.sources.slice(0, 20).map((s) => ({ text: s.text, sourceId: s.id })),
          angle: { text: 'Open with what changed for them recently.', sourceIds: [] },
        }
      }
      const answer = typeof next === 'function' ? next(request) : next
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    },
  }
}
