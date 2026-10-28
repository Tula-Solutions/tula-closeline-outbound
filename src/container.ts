import { sql } from 'drizzle-orm'
import type { RequestId } from 'tula-closeline-contract'
import { createDb, type Transaction, withOrganization } from 'tula-closeline-db'
import {
  type Clock,
  createErrorReporter,
  createHttpContactGuard,
  createLogger,
  createMemoryProcessedStore,
  createRemoteKeySet,
  createTokenVerifier,
  type LogDestination,
  type Logger,
  type ProcessedStore,
  type Queue,
  systemClock,
  systemSleep,
  type TokenVerifier,
} from 'tula-closeline-kit'
import { type Consumer, createSqsQueue } from 'tula-closeline-kit/queue'
import { createMemoryContactGuard, createMemoryQueue } from 'tula-closeline-kit/testing'
import { createLocalKeySecretBox, createUnconfiguredSecretBox } from '~/adapters/crypto/secret-box'
import { createGmailMailTransport } from '~/adapters/gmail/mail-transport'
import { createGraphMailTransport } from '~/adapters/graph/mail-transport'
import { createHttpCoreProspects } from '~/adapters/http/core'
import { createMemoryAudienceCheckStore } from '~/adapters/memory/audience-check-store'
import { createMemoryCore } from '~/adapters/memory/core'
import { createMemoryLinkedInProvider } from '~/adapters/memory/linkedin-provider'
import { createMemoryMailTransport } from '~/adapters/memory/mail-transport'
import { createMemorySecretBox } from '~/adapters/memory/secret-box'
import { createPostgresBrandVoiceStore } from '~/adapters/postgres/brand-voice-store'
import { createPostgresCampaignStore } from '~/adapters/postgres/campaign-store'
import { createPostgresEnrollmentStore } from '~/adapters/postgres/enrollment-store'
import { createPostgresLinkedinStore } from '~/adapters/postgres/linkedin-store'
import { createPostgresMailboxStore } from '~/adapters/postgres/mailbox-store'
import { createPostgresProviderConfig } from '~/adapters/postgres/provider-config'
import { createPostgresEnrichmentStore } from '~/adapters/postgres/store'
import { createOutboundConsumer } from '~/consumer'
import { describeError } from '~/describe-error'
import { type Env, loadEnv } from '~/env'
import { SERVICE } from '~/info'
import { type OutboundEnvelope, registry } from '~/messages'
import type { BrandVoiceDeps } from '~/modules/brand-voice/deps'
import { campaignHandlers } from '~/modules/campaign/audience'
import type { CampaignDeps } from '~/modules/campaign/deps'
import type { EnrichmentDeps } from '~/modules/enrichment/deps'
import { enrichmentHandlers } from '~/modules/enrichment/handlers'
import type { LinkedinDeps } from '~/modules/linkedin/deps'
import type { MailboxDeps } from '~/modules/mailbox/deps'
import type { CredentialVault } from '~/ports/provider-config'
import { trackerSafe } from '~/tracker-safe'

/** One dependency probe for `/readyz`: resolve when healthy, reject or stall when not. */
export type ReadinessCheck = {
  /** A short stable name, reported to the caller, never an address or credential. */
  name: string
  /** Probes the dependency; `signal` aborts when the check has run out of time. */
  run: (signal: AbortSignal) => Promise<void>
}

/** What `reportError` is told about the request that failed. */
export type ErrorContext = {
  requestId: RequestId
  /** The Organization of the verified token, when the request got that far. */
  organizationId?: string | undefined
  method: string
  /** The path only, never the query string, which can carry secrets. */
  path: string
  /** The HTTP status of the response sent to the client, which can differ from the error's own. */
  status: number
}

/** Everything a request needs from outside the process, built once in {@link createContainer}. */
export type Container = {
  env: Env
  logger: Logger
  clock: Clock
  /** Checks access tokens offline against the auth service's published keys. */
  tokenVerifier: TokenVerifier
  /** Runs `fn` in a transaction scoped to one Organization; no bare connection is handed out. */
  withOrganization: <T>(organizationId: string, fn: (tx: Transaction) => Promise<T>) => Promise<T>
  /** The enrichment queue: SQS when `QUEUE_URL` is set, otherwise in memory (local and tests only). */
  queue: Queue<OutboundEnvelope>
  /** Which queue messages are done. In memory: the run row is the idempotency record, see ADR notes. */
  processed: ProcessedStore
  /** Everything the enrichment module needs; its service functions take this first. */
  enrichment: EnrichmentDeps
  /** Everything the campaign module needs; its service functions take this first. */
  campaigns: CampaignDeps
  /** Everything the brand-voice module needs. */
  brandVoice: BrandVoiceDeps
  /** Everything the mailbox module needs; its service functions take this first. */
  mailboxes: MailboxDeps
  /** Everything the LinkedIn module needs; its service functions take this first. */
  linkedin: LinkedinDeps
  /** The queue consumer; built here, started by `server.ts` and stopped on shutdown. */
  consumer: Consumer
  /** Probes run by `/readyz`: the database. */
  readinessChecks: readonly ReadinessCheck[]
  /**
   * The one place unexpected errors go. It logs through the kit logger today; the error tracker is
   * wired in here and nowhere else. It must not throw and must not return anything to a client.
   */
  reportError: (error: unknown, context: ErrorContext) => void
  /**
   * Set once shutdown begins: `/readyz` answers 503 from then on, before the server stops.
   * `drainingSince` is when the first signal arrived (epoch ms from `clock`), for shutdown only.
   */
  lifecycle: { draining: boolean; drainingSince?: number }
  /** Delivers pending error reports and releases the database connections; safe to call twice. */
  close: () => Promise<void>
}

/**
 * Calls `reportError` so that it can neither throw nor leave a rejected promise behind, even if
 * an implementation wrongly went async.
 */
export function reportSafely(container: Container, error: unknown, context: ErrorContext): void {
  try {
    const result: unknown = container.reportError(error, context)
    if (result instanceof Promise) {
      result.catch(() => {})
    }
  } catch {
    // A failing reporter must never turn a handled error into a dropped response.
  }
}

/** Options for {@link createContainer}. */
export type ContainerOptions = {
  /** Where log lines go; defaults to stdout. */
  logDestination?: LogDestination
}

/** How long `close` waits for the error reporter to deliver what it holds. */
const REPORTER_CLOSE_MS = 2_000

/** The SQS queue when `QUEUE_URL` is set, otherwise the kit's memory queue. */
function createQueue(env: Env): Queue<OutboundEnvelope> {
  if (env.QUEUE_URL === undefined) {
    return createMemoryQueue({ registry, clock: systemClock })
  }
  return createSqsQueue({
    queueUrl: env.QUEUE_URL,
    region: env.AWS_REGION,
    environment: env.ENVIRONMENT,
    registry,
    ...(env.QUEUE_ENDPOINT === undefined ? {} : { endpoint: env.QUEUE_ENDPOINT }),
  })
}

/** No key management exists yet (ADR pending), so no credential opens and every provider is skipped. */
const unconfiguredVault: CredentialVault = { open: async () => null }

/**
 * The single composition root: the only place adapters and process-wide objects are constructed.
 * Core's Prospect read and write-back use the HTTP adapter outside `local` or whenever `CORE_URL`
 * is set, the memory one otherwise. Core's access check and the providers are still memory
 * adapters until their real ones exist, so outside `local` the service warns about those.
 */
export function createContainer(env: Env = loadEnv(), options: ContainerOptions = {}): Container {
  const logger = createLogger({
    service: SERVICE,
    level: env.LOG_LEVEL,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  })
  const errors = trackerSafe(
    createErrorReporter({
      dsn: env.SENTRY_DSN,
      service: SERVICE,
      environment: env.ENVIRONMENT,
      region: env.REGION,
      release: env.GIT_SHA,
      logger,
    })
  )
  const database = createDb(env.DATABASE_URL)
  const keys = createRemoteKeySet({
    url: env.AUTH_JWKS_URL,
    allowInsecureLocalhost: env.ENVIRONMENT === 'local',
    clock: systemClock,
    logger,
  })
  if (env.ENVIRONMENT !== 'local') {
    logger.warn('ports still on fakes', {
      ports: [
        'core access check',
        'membership id and Team lookup',
        'enrichment providers',
        'email verifiers',
        'audience listing from core',
        'audience check results',
      ],
    })
  }
  const inOrganization: Container['withOrganization'] = (organizationId, fn) =>
    withOrganization(database.db, organizationId, fn)
  const queue = createQueue(env)
  const processed = createMemoryProcessedStore({ clock: systemClock })
  const core = createMemoryCore()
  const coreHttp =
    env.ENVIRONMENT !== 'local' || env.CORE_URL !== undefined
      ? createHttpCoreProspects({
          // The env schema guarantees both are set in this case.
          baseUrl: env.CORE_URL as string,
          secret: env.CORE_INTERNAL_SECRET as string,
          environment: env.ENVIRONMENT,
          timeoutMs: env.CORE_CALL_TIMEOUT_MS,
          maxAttempts: env.CORE_CALL_MAX_TRIES,
          retryBaseMs: env.ENRICHMENT_RETRY_BASE_MS,
          logger,
        })
      : undefined
  // Fails closed: the memory guard denies every Prospect, so local without core sends nothing.
  const guardHttp =
    env.ENVIRONMENT !== 'local' || env.CORE_URL !== undefined
      ? createHttpContactGuard({
          baseUrl: env.CORE_URL as string,
          secret: env.CORE_INTERNAL_SECRET as string,
          environment: env.ENVIRONMENT,
          caller: 'outbound',
          logger,
        })
      : undefined
  const enrichment: EnrichmentDeps = {
    store: createPostgresEnrichmentStore(inOrganization),
    core: coreHttp ?? core.prospects,
    access: core.access,
    config: createPostgresProviderConfig(inOrganization, unconfiguredVault),
    providers: [],
    verifiers: [],
    queue,
    clock: systemClock,
    sleep: systemSleep,
    random: Math.random,
    logger,
    limits: {
      monthlyBudgetMicros: env.ENRICHMENT_MONTHLY_BUDGET_MICROS,
      runCeilingMicros: env.ENRICHMENT_RUN_CEILING_MICROS,
      providerTimeoutMs: env.ENRICHMENT_PROVIDER_TIMEOUT_MS,
      providerMaxTries: env.ENRICHMENT_PROVIDER_MAX_TRIES,
      retryBaseMs: env.ENRICHMENT_RETRY_BASE_MS,
      runLeaseSeconds: env.ENRICHMENT_RUN_LEASE_SECONDS,
    },
  }
  const campaigns: CampaignDeps = {
    store: createPostgresCampaignStore(inOrganization),
    access: core.access,
    clock: systemClock,
    enrollments: createPostgresEnrollmentStore(inOrganization),
    checks: createMemoryAudienceCheckStore(),
    audience: core.audience,
    guard: guardHttp ?? createMemoryContactGuard(),
    queue,
    logger,
  }
  const brandVoice: BrandVoiceDeps = {
    store: createPostgresBrandVoiceStore(inOrganization),
    access: core.access,
    clock: systemClock,
  }
  const linkedin: LinkedinDeps = {
    store: createPostgresLinkedinStore(inOrganization),
    access: core.access,
    clock: systemClock,
    // No vendor adapter exists yet: only local runs get the stand-in, anywhere else connecting is unavailable.
    provider: env.ENVIRONMENT === 'local' ? createMemoryLinkedInProvider(systemClock) : null,
    logger,
  }
  const mailboxes: MailboxDeps = {
    store: createPostgresMailboxStore(inOrganization),
    access: core.access,
    clock: systemClock,
    secretBox:
      env.MAIL_SECRET_BOX_KEY !== undefined
        ? createLocalKeySecretBox(env.MAIL_SECRET_BOX_KEY)
        : env.ENVIRONMENT === 'local'
          ? createMemorySecretBox()
          : createUnconfiguredSecretBox(),
    transports: {
      gmail:
        env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined
          ? createGmailMailTransport({
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              redirectUri: env.MAIL_OAUTH_REDIRECT_URI,
              authUrl: env.GOOGLE_AUTH_URL,
              tokenUrl: env.GOOGLE_TOKEN_URL,
              revokeUrl: env.GOOGLE_REVOKE_URL,
              apiBaseUrl: env.GMAIL_API_BASE_URL,
              timeoutMs: env.MAIL_CALL_TIMEOUT_MS,
              maxTries: env.MAIL_CALL_MAX_TRIES,
              retryBaseMs: env.MAIL_RETRY_BASE_MS,
            })
          : env.ENVIRONMENT === 'local'
            ? createMemoryMailTransport({
                clock: systemClock,
                redirectUri: env.MAIL_OAUTH_REDIRECT_URI,
              })
            : undefined,
      outlook:
        env.MICROSOFT_CLIENT_ID !== undefined && env.MICROSOFT_CLIENT_SECRET !== undefined
          ? createGraphMailTransport({
              clientId: env.MICROSOFT_CLIENT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
              redirectUri: env.MAIL_OAUTH_REDIRECT_URI,
              authUrl: env.MICROSOFT_AUTH_URL,
              tokenUrl: env.MICROSOFT_TOKEN_URL,
              apiBaseUrl: env.GRAPH_API_BASE_URL,
              timeoutMs: env.MAIL_CALL_TIMEOUT_MS,
              maxTries: env.MAIL_CALL_MAX_TRIES,
              retryBaseMs: env.MAIL_RETRY_BASE_MS,
            })
          : env.ENVIRONMENT === 'local'
            ? createMemoryMailTransport({
                clock: systemClock,
                redirectUri: env.MAIL_OAUTH_REDIRECT_URI,
                provider: 'outlook',
              })
            : undefined,
    },
    stateSecret: env.MAIL_STATE_SECRET,
    // There is no event bus in this service yet; the change is logged until one exists.
    events: async (organizationId, event) => {
      logger.info('mailbox.state_changed', { organizationId, ...event })
    },
    logger,
  }
  const consumer = createOutboundConsumer({
    queue,
    store: processed,
    logger,
    errorReporter: errors,
    handlers: { ...enrichmentHandlers(enrichment), ...campaignHandlers(campaigns) },
    concurrency: env.CONSUMER_CONCURRENCY,
  })

  return {
    env,
    logger,
    clock: systemClock,
    tokenVerifier: createTokenVerifier({
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      keys,
      clock: systemClock,
    }),
    withOrganization: inOrganization,
    queue,
    processed,
    enrichment,
    campaigns,
    brandVoice,
    mailboxes,
    linkedin,
    consumer,
    readinessChecks: [
      {
        name: 'database',
        run: async () => {
          await database.db.execute(sql`select 1`)
        },
      },
    ],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      logger.error('unhandled error', { ...context, error: describeError(error) })
      errors.capture(error, context)
    },
    close: async () => {
      coreHttp?.close()
      guardHttp?.close()
      await errors.close(REPORTER_CLOSE_MS)
      await database.close()
    },
  }
}
