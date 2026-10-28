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
import { createAnthropicModel } from '~/adapters/anthropic/model'
import { createLocalKeySecretBox, createUnconfiguredSecretBox } from '~/adapters/crypto/secret-box'
import { createSecretBoxVault } from '~/adapters/crypto/vault'
import { createExaWebSearch } from '~/adapters/exa/web-search'
import { createGmailMailTransport } from '~/adapters/gmail/mail-transport'
import { createGooglePushVerifier } from '~/adapters/gmail/push-verifier'
import { createGraphMailTransport } from '~/adapters/graph/mail-transport'
import { createHttpCoreProspects } from '~/adapters/http/core'
import { createHttpCoreSuppression } from '~/adapters/http/core-suppression'
import { createMemoryAudienceCheckStore } from '~/adapters/memory/audience-check-store'
import { createMemoryCore } from '~/adapters/memory/core'
import { createMemoryCoreSuppression } from '~/adapters/memory/core-suppression'
import {
  createMemoryApprovals,
  createMemoryDraftSource,
  createMemoryProspectContacts,
} from '~/adapters/memory/engine'
import { createMemoryLinkedInProvider } from '~/adapters/memory/linkedin-provider'
import { createMemoryMailTransport } from '~/adapters/memory/mail-transport'
import { createMemoryModel } from '~/adapters/memory/model'
import { createMemorySecretBox } from '~/adapters/memory/secret-box'
import { createMemoryWebSearch } from '~/adapters/memory/web-search'
import { createPostgresBrandVoiceStore } from '~/adapters/postgres/brand-voice-store'
import { createPostgresCampaignStore } from '~/adapters/postgres/campaign-store'
import { createPostgresEnrollmentStore } from '~/adapters/postgres/enrollment-store'
import { createPostgresFitStore } from '~/adapters/postgres/fit-store'
import { createPostgresLinkedinStore } from '~/adapters/postgres/linkedin-store'
import { createPostgresMailEventStore } from '~/adapters/postgres/mail-event-store'
import { createPostgresMailboxStore } from '~/adapters/postgres/mailbox-store'
import { createPostgresModelUsageStore } from '~/adapters/postgres/model-usage'
import { createPostgresProviderConfig } from '~/adapters/postgres/provider-config'
import { createPostgresSendStore } from '~/adapters/postgres/send-store'
import { createPostgresSignalStore } from '~/adapters/postgres/signal-store'
import { createPostgresEnrichmentStore } from '~/adapters/postgres/store'
import { createApolloProvider } from '~/adapters/providers/apollo'
import { createCircuit } from '~/adapters/providers/circuit'
import { createZeroBounceVerifier } from '~/adapters/providers/zerobounce'
import { createOutboundConsumer } from '~/consumer'
import { describeError } from '~/describe-error'
import { type Env, loadEnv } from '~/env'
import { SERVICE } from '~/info'
import { type OutboundEnvelope, registry } from '~/messages'
import type { BrandVoiceDeps } from '~/modules/brand-voice/deps'
import { campaignHandlers } from '~/modules/campaign/audience'
import type { CampaignDeps } from '~/modules/campaign/deps'
import type { EngineDeps } from '~/modules/engine/deps'
import { engineHandlers, stopForProspect } from '~/modules/engine/service'
import type { EnrichmentDeps } from '~/modules/enrichment/deps'
import { enrichmentHandlers } from '~/modules/enrichment/handlers'
import type { FitDeps } from '~/modules/fit/deps'
import { defaultSendSettings, type LinkedinDeps } from '~/modules/linkedin/deps'
import type { MailboxDeps } from '~/modules/mailbox/deps'
import type { MailEventDeps } from '~/modules/mailevent/deps'
import { mailEventHandlers } from '~/modules/mailevent/service'
import type { SendDeps } from '~/modules/send/deps'
import type { SignalDeps } from '~/modules/signal/deps'
import type { Model } from '~/ports/model'
import type { WebSearch } from '~/ports/web-search'
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
  /** Everything the signal module needs; its service functions take this first. */
  signals: SignalDeps
  /** Everything the mail event module needs: provider notifications and the unsubscribe page. */
  inboundMail: MailEventDeps
  /** Everything the fit module needs; its service functions take this first. */
  fit: FitDeps
  /** Everything the send pipeline needs. */
  send: SendDeps
  /** Everything the LinkedIn module needs; its service functions take this first. */
  linkedin: LinkedinDeps
  /** Everything the Sequence engine needs; `server.ts` runs its sweep on a timer. */
  engine: EngineDeps
  /** The model and web search: the real vendors when their keys are set, memory stand-ins when `local`, otherwise null. */
  ai: { model: Model | null; web: WebSearch | null }
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
  const secretBox =
    env.MAIL_SECRET_BOX_KEY !== undefined
      ? createLocalKeySecretBox(env.MAIL_SECRET_BOX_KEY)
      : env.ENVIRONMENT === 'local'
        ? createMemorySecretBox()
        : createUnconfiguredSecretBox()
  const vault = createSecretBoxVault(secretBox)
  const circuit = () =>
    createCircuit({
      failures: env.PROVIDER_CIRCUIT_FAILURES,
      openMs: env.PROVIDER_CIRCUIT_OPEN_MS,
      now: () => Date.now(),
    })
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
    config: createPostgresProviderConfig(inOrganization, vault),
    vault,
    providers: [createApolloProvider({ baseUrl: env.APOLLO_BASE_URL, guard: circuit() })],
    verifiers: [createZeroBounceVerifier({ baseUrl: env.ZEROBOUNCE_BASE_URL, guard: circuit() })],
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
    enrollments: createPostgresEnrollmentStore(inOrganization, database.db),
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
  // There is no event bus in this service yet; Signal and fit events are logged (ids and numbers only).
  const signalEvents: SignalDeps['events'] = async (organizationId, event) => {
    logger.info(event.name, { organizationId, ...event.payload })
  }
  const prospectsCore = coreHttp ?? core.prospects
  const signals: SignalDeps = {
    store: createPostgresSignalStore(inOrganization),
    core: prospectsCore,
    access: core.access,
    secretBox,
    clock: systemClock,
    events: signalEvents,
  }
  const fit: FitDeps = {
    store: createPostgresFitStore(inOrganization),
    core: prospectsCore,
    access: core.access,
    clock: systemClock,
    events: signalEvents,
  }
  const linkedin: LinkedinDeps = {
    store: createPostgresLinkedinStore(inOrganization),
    access: core.access,
    clock: systemClock,
    // No vendor adapter exists yet: only local runs get the stand-in, anywhere else connecting is unavailable.
    provider: env.ENVIRONMENT === 'local' ? createMemoryLinkedInProvider(systemClock) : null,
    // There is no event bus in this service yet; the change is logged until one exists.
    events: async (organizationId, event) => {
      logger.info('linkedin.channel_disabled', { organizationId, ...event })
    },
    guard: guardHttp ?? createMemoryContactGuard(),
    accountPaused: async (organizationId, event) => {
      logger.info('linkedin.account_paused', { organizationId, ...event })
    },
    send: defaultSendSettings(),
    logger,
  }
  const mailboxes: MailboxDeps = {
    store: createPostgresMailboxStore(inOrganization),
    access: core.access,
    clock: systemClock,
    secretBox,
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
  const send: SendDeps = {
    store: createPostgresSendStore(inOrganization),
    mailboxes,
    campaigns: campaigns.store,
    guard: campaigns.guard,
    clock: systemClock,
    logger,
    unsubscribe: { secret: env.MAIL_STATE_SECRET, url: env.MAIL_UNSUBSCRIBE_URL },
    organizationDailyCap: env.MAIL_ORG_DAILY_CAP,
  }
  const suppressionHttp =
    coreHttp === undefined
      ? undefined
      : createHttpCoreSuppression({
          baseUrl: env.CORE_URL as string,
          secret: env.CORE_INTERNAL_SECRET as string,
          environment: env.ENVIRONMENT,
          timeoutMs: env.CORE_CALL_TIMEOUT_MS,
          maxAttempts: env.CORE_CALL_MAX_TRIES,
          logger,
        })
  const inboundMail: MailEventDeps = {
    mailboxes,
    sends: send.store,
    enrollments: campaigns.enrollments,
    log: createPostgresMailEventStore(inOrganization),
    prospects: prospectsCore,
    suppression: suppressionHttp ?? createMemoryCoreSuppression(),
    clock: systemClock,
    logger,
    secret: env.MAIL_STATE_SECRET,
    verifyPush:
      env.GMAIL_PUSH_AUDIENCE !== undefined && env.GMAIL_PUSH_SERVICE_ACCOUNT !== undefined
        ? createGooglePushVerifier({
            audience: env.GMAIL_PUSH_AUDIENCE,
            serviceAccount: env.GMAIL_PUSH_SERVICE_ACCOUNT,
            now: () => systemClock.now().getTime(),
          })
        : // Without the audience and account the webhook cannot tell Google from anyone; only local runs open.
          async () => env.ENVIRONMENT === 'local',
    queue,
    stopProspect: (organizationId, prospectId, reason) =>
      stopForProspect(engine, organizationId, prospectId, reason),
    // There is no event bus in this service yet; the event is logged (ids only) until one exists.
    publish: async (organizationId, event) => {
      logger.info(event.name, { organizationId, ...event.payload })
    },
  }
  if (env.ENVIRONMENT !== 'local') {
    logger.warn('the Sequence engine uses in-memory drafts, approvals and contacts', {})
  }
  // shortcut: drafts (M06-T7), approvals (M09) and Prospect contacts are in-memory stand-ins; the
  // placeholder Draft is ungrounded, so nothing is sent unseen until the real ones replace them.
  const engine: EngineDeps = {
    enrollments: campaigns.enrollments,
    campaigns: campaigns.store,
    send,
    drafts: createMemoryDraftSource(() => new Date().toISOString()),
    approvals: createMemoryApprovals(),
    contacts: createMemoryProspectContacts(),
    queue,
    clock: systemClock,
    random: Math.random,
    logger,
    limits: {
      orgBatch: env.ENGINE_ORG_BATCH,
      stepPage: env.ENGINE_STEP_PAGE,
      leaseSeconds: env.ENGINE_LEASE_SECONDS,
    },
  }
  const local = env.ENVIRONMENT === 'local'
  const aiBounds = {
    timeoutMs: env.AI_CALL_TIMEOUT_MS,
    maxTries: env.AI_CALL_MAX_TRIES,
    retryBaseMs: env.AI_RETRY_BASE_MS,
    sleep: systemSleep,
    random: Math.random,
  }
  const ai: Container['ai'] = {
    model:
      env.ANTHROPIC_API_KEY !== undefined
        ? createAnthropicModel({
            ...aiBounds,
            apiKey: env.ANTHROPIC_API_KEY,
            baseUrl: env.ANTHROPIC_BASE_URL,
            model: env.ANTHROPIC_MODEL,
            noTraining: env.ANTHROPIC_NO_TRAINING_CONFIRMED === 'true',
            usage: createPostgresModelUsageStore(inOrganization),
            monthlyBudgetMicros: env.MODEL_MONTHLY_BUDGET_MICROS,
            inputMicrosPerMillion: env.MODEL_INPUT_MICROS_PER_MILLION,
            outputMicrosPerMillion: env.MODEL_OUTPUT_MICROS_PER_MILLION,
            now: () => new Date(systemClock.now()),
          })
        : local
          ? createMemoryModel()
          : null,
    web:
      env.EXA_API_KEY !== undefined
        ? createExaWebSearch({
            ...aiBounds,
            apiKey: env.EXA_API_KEY,
            baseUrl: env.EXA_BASE_URL,
            now: () => new Date(systemClock.now()),
          })
        : local
          ? createMemoryWebSearch()
          : null,
  }
  const consumer = createOutboundConsumer({
    queue,
    store: processed,
    logger,
    errorReporter: errors,
    handlers: {
      ...enrichmentHandlers(enrichment),
      ...campaignHandlers(campaigns),
      ...engineHandlers(engine),
      ...mailEventHandlers(inboundMail),
    },
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
    signals,
    inboundMail,
    fit,
    send,
    linkedin,
    engine,
    ai,
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
