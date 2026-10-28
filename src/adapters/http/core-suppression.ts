import {
  createInternalClient,
  type Environment,
  type InternalClient,
  type Logger,
} from 'tula-closeline-kit'
import type { CoreSuppression } from '~/ports/core-suppression'

/** Options for {@link createHttpCoreSuppression}. */
export type HttpCoreSuppressionOptions = {
  baseUrl: string
  /** The shared secret core accepts for this service (ADR 0013). Never logged. */
  secret: string
  environment: Environment
  /** The bound on one attempt, in ms. */
  timeoutMs: number
  /** Attempts in all, the first included. */
  maxAttempts: number
  logger?: Pick<Logger, 'warn'>
}

/** Core said no, or could not be reached; the message holds fixed words and a status only. */
export class CoreSuppressionError extends Error {
  constructor(route: string, status?: number) {
    super(`core call ${route} failed${status === undefined ? '' : ` (${status})`}`)
    this.name = 'CoreSuppressionError'
  }
}

/** Core's two internal suppression routes over HTTP; both are idempotent on `sourceRef`, so a retry is safe. */
export function createHttpCoreSuppression(
  options: HttpCoreSuppressionOptions
): CoreSuppression & { close: () => void } {
  const client: InternalClient = createInternalClient({
    baseUrl: options.baseUrl,
    secret: options.secret,
    environment: options.environment,
    userAgent: 'tula-closeline-outbound',
    timeoutMs: options.timeoutMs,
    retry: { maxAttempts: options.maxAttempts },
    ...(options.logger ? { logger: options.logger } : {}),
  })

  async function post(route: string, path: string, body: unknown, organizationId: string) {
    let status: number
    try {
      ;({ status } = await client.request({
        method: 'POST',
        path,
        headers: { 'X-Organization-Id': organizationId },
        body,
        idempotencyKey: (body as { sourceRef: string }).sourceRef,
      }))
    } catch {
      throw new CoreSuppressionError(route)
    }
    if (status !== 200) {
      throw new CoreSuppressionError(route, status)
    }
  }

  return {
    recordDeliveryFailure: (organizationId, failure) =>
      post(
        'recordDeliveryFailure',
        '/internal/v1/delivery-failures',
        { organizationId, ...failure },
        organizationId
      ),
    withdrawEmailConsent: (organizationId, withdrawal) =>
      post(
        'withdrawEmailConsent',
        '/internal/v1/consent-withdrawals',
        { organizationId, channel: 'email', stopAll: false, ...withdrawal },
        organizationId
      ),
    close: () => client.close(),
  }
}
