import {
  type EnrichedFieldName,
  enrichmentInputResponseSchema,
  writeEnrichedFieldsResponseSchema,
} from 'tula-closeline-contract'
import {
  createInternalClient,
  type Environment,
  type InternalCallError,
  type InternalClient,
  type InternalClientOptions,
  type Logger,
} from 'tula-closeline-kit'
import { CoreProspectNotFoundError, type CoreProspects, type EnrichmentInput } from '~/ports/core'
import type { ProspectValues } from '~/ports/enrichment-provider'

/** The one route the not-found answer may come from, for the `area.reason` it carries. */
const PROSPECT_NOT_FOUND = 'enrichment.prospect_not_found'

/**
 * Why a call to core produced no usable answer: core's `area.reason` code, or the transport failure.
 * Only a missing Prospect is terminal; every other failure (401, 403, 400 included) propagates so the
 * queue redelivers it, bounded by the queue's redelivery limit and dead-letter handling.
 */
export class CoreCallError extends Error {
  /** Core's `area.reason` code, or `core.unreachable`, `core.invalid_response`. */
  readonly code: string
  /** The transport failure kind (`timeout`, `connection`, ...) when there was no answer. */
  readonly failure: string | undefined
  /** The HTTP status when core answered. */
  readonly status: number | undefined

  /** Builds the error from fixed words only: never a secret, a field value or core's message. */
  constructor(init: { code: string; failure?: string; status?: number; route: string }) {
    super(
      `core call ${init.route} failed: ${init.code}${init.status === undefined ? '' : ` (${init.status})`}`
    )
    this.name = 'CoreCallError'
    this.code = init.code
    this.failure = init.failure
    this.status = init.status
  }
}

/** Options for {@link createHttpCoreProspects}. */
export type HttpCoreOptions = {
  /** Core's origin. */
  baseUrl: string
  /** The shared secret core accepts for this service (ADR 0013). Never logged. */
  secret: string
  environment: Environment
  /** The bound on one attempt, in ms. */
  timeoutMs: number
  /** Attempts in all, the first included. */
  maxAttempts: number
  /** The first retry delay's ceiling before jitter, in ms; it doubles. */
  retryBaseMs?: number
  logger?: Pick<Logger, 'warn'>
  /** Injected for tests. */
  sleep?: InternalClientOptions['sleep']
  /** Injected for tests. */
  random?: () => number
}

/** The `area.reason` code in an error answer, or undefined when the body is not one. */
function codeOf(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null || !('error' in json)) {
    return undefined
  }
  const error = json.error
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  return typeof error.code === 'string' && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(error.code)
    ? error.code
    : undefined
}

/** Whether core answered 404 with the not-found code; a 404 with another code is not it. */
function isProspectNotFound(answer: { status: number; json: unknown }): boolean {
  return answer.status === 404 && codeOf(answer.json) === PROSPECT_NOT_FOUND
}

/** Core's two internal enrichment routes over HTTP, as the port the waterfall reads and writes through. */
export function createHttpCoreProspects(options: HttpCoreOptions): CoreProspects & {
  /** Closes the connections; safe to call twice. */
  close: () => void
} {
  const client: InternalClient = createInternalClient({
    baseUrl: options.baseUrl,
    secret: options.secret,
    environment: options.environment,
    userAgent: 'tula-closeline-outbound',
    timeoutMs: options.timeoutMs,
    retry: {
      maxAttempts: options.maxAttempts,
      ...(options.retryBaseMs === undefined ? {} : { baseDelayMs: options.retryBaseMs }),
    },
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
  })

  /** Sends one call; resolves with the answer, or throws a {@link CoreCallError} with fixed words. */
  async function call(
    route: string,
    request: Parameters<InternalClient['request']>[0]
  ): Promise<{ status: number; json: unknown }> {
    try {
      return await client.request(request)
    } catch (error) {
      const failure = (error as InternalCallError).failure
      throw new CoreCallError({
        code: 'core.unreachable',
        route,
        ...(typeof failure === 'string' ? { failure } : {}),
      })
    }
  }

  /** Turns an answer that is not 200 into the right error. */
  function reject(route: string, answer: { status: number; json: unknown }): never {
    if (isProspectNotFound(answer)) {
      throw new CoreProspectNotFoundError()
    }
    throw new CoreCallError({
      code: codeOf(answer.json) ?? 'core.unexpected_status',
      route,
      status: answer.status,
    })
  }

  return {
    async getEnrichmentInput(organizationId, prospectId): Promise<EnrichmentInput | null> {
      const route = 'getEnrichmentInput'
      const answer = await call(route, {
        method: 'GET',
        path: `/internal/v1/prospects/${prospectId}/enrichment-input`,
        headers: { 'X-Organization-Id': organizationId },
      })
      if (answer.status !== 200) {
        if (isProspectNotFound(answer)) {
          return null
        }
        return reject(route, answer)
      }
      const parsed = enrichmentInputResponseSchema.safeParse(answer.json)
      if (!parsed.success) {
        throw new CoreCallError({ code: 'core.invalid_response', route, status: 200 })
      }
      return { prospectId: parsed.data.prospectId, values: valuesOf(parsed.data) }
    },

    // shortcut: core has no internal email lookup route yet, so a webhook that names a Prospect
    // by email is answered as not found; upgrade when core offers the route.
    async findProspectIdByEmail() {
      return null
    },

    async writeEnrichedFields(organizationId, prospectId, write) {
      const route = 'writeEnrichedFields'
      const answer = await call(route, {
        method: 'POST',
        path: `/internal/v1/prospects/${prospectId}/enriched-fields`,
        headers: { 'X-Organization-Id': organizationId },
        body: { runId: write.runId, fields: write.fields },
        // Core is idempotent on (Prospect, runId); the key only lets the client retry the POST.
        idempotencyKey: `${prospectId}:${write.runId}`,
      })
      if (answer.status !== 200) {
        return reject(route, answer)
      }
      const parsed = writeEnrichedFieldsResponseSchema.safeParse(answer.json)
      if (!parsed.success) {
        throw new CoreCallError({ code: 'core.invalid_response', route, status: 200 })
      }
      return { results: parsed.data.results }
    },

    close: () => client.close(),
  }
}

/** The values core holds, by field; a `null` is a field core does not hold and is left out. */
function valuesOf(input: {
  email: string | null
  firstName: string | null
  lastName: string | null
  jobTitle: string | null
  companyName: string | null
  companyDomain: string | null
}): ProspectValues {
  const values: ProspectValues = {}
  const fields: EnrichedFieldName[] = [
    'email',
    'firstName',
    'lastName',
    'jobTitle',
    'companyName',
    'companyDomain',
  ]
  for (const field of fields) {
    const value = input[field as keyof typeof input]
    if (value !== null && value !== '') {
      values[field] = value
    }
  }
  return values
}
