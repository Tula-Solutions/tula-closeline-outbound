import type { OpenAPIHono } from '@hono/zod-openapi'
import { formatId, type OrganizationId, type Role, type UserId } from 'tula-closeline-contract'
import {
  createLogger,
  createMemoryProcessedStore,
  createStaticKeySet,
  createTokenVerifier,
  type FixedClock,
  TokenVerificationError,
  type TokenVerifier,
} from 'tula-closeline-kit'
import {
  createMemoryContactGuard,
  createMemoryErrorReporter,
  createMemoryQueue,
  createTestJwks,
  createTestKeyPair,
  createVirtualTime,
  type MemoryContactGuard,
  type MemoryErrorReporter,
  type MemoryQueue,
  type MintTokenOptions,
  mintTestToken,
  type VirtualTime,
} from 'tula-closeline-kit/testing'
import { createSecretBoxVault } from '~/adapters/crypto/vault'
import { createMemoryAudienceCheckStore } from '~/adapters/memory/audience-check-store'
import { createMemoryBrandVoiceStore } from '~/adapters/memory/brand-voice-store'
import { createMemoryCampaignStore } from '~/adapters/memory/campaign-store'
import { createMemoryCore, type MemoryCore } from '~/adapters/memory/core'
import {
  createMemoryCoreSuppression,
  type MemoryCoreSuppression,
} from '~/adapters/memory/core-suppression'
import {
  createMemoryApprovals,
  createMemoryDraftSource,
  createMemoryProspectContacts,
} from '~/adapters/memory/engine'
import { createMemoryEnrollmentStore } from '~/adapters/memory/enrollment-store'
import { createMemoryFitStore } from '~/adapters/memory/fit-store'
import {
  createMemoryLinkedInProvider,
  type MemoryLinkedInProvider,
} from '~/adapters/memory/linkedin-provider'
import {
  createMemoryLinkedinStore,
  type MemoryLinkedinStore,
} from '~/adapters/memory/linkedin-store'
import { createMemoryMailEventStore } from '~/adapters/memory/mail-event-store'
import {
  createMemoryMailTransport,
  type MemoryMailTransport,
} from '~/adapters/memory/mail-transport'
import { createMemoryMailboxStore } from '~/adapters/memory/mailbox-store'
import { createMemoryModel } from '~/adapters/memory/model'
import { createMemoryProviderConfig } from '~/adapters/memory/provider-config'
import type { MemoryProvider, MemoryVerifier } from '~/adapters/memory/providers'
import { createMemorySecretBox } from '~/adapters/memory/secret-box'
import { createMemorySendStore } from '~/adapters/memory/send-store'
import { createMemorySignalStore } from '~/adapters/memory/signal-store'
import { createMemoryEnrichmentStore } from '~/adapters/memory/store'
import { createMemoryWebSearch } from '~/adapters/memory/web-search'
import { createApp } from '~/app'
import { createOutboundConsumer } from '~/consumer'
import type { Container, ErrorContext, ReadinessCheck } from '~/container'
import { loadEnv } from '~/env'
import type { AppEnv } from '~/http/types'
import { SERVICE } from '~/info'
import { type OutboundDefinition, registry } from '~/messages'
import { campaignHandlers } from '~/modules/campaign/audience'
import { engineHandlers } from '~/modules/engine/service'
import { enrichmentHandlers } from '~/modules/enrichment/handlers'
import {
  defaultSendSettings,
  type LinkedinAccountPaused,
  type LinkedinChannelDisabled,
} from '~/modules/linkedin/deps'
import type { MailboxStateChanged } from '~/modules/mailbox/deps'
import type { MailEvent } from '~/modules/mailevent/deps'
import type { SignalDeps, SignalEvent } from '~/modules/signal/deps'

/** The issuer and audience the test environment's tokens carry. */
const TEST_ISSUER = 'https://auth.test'
const TEST_AUDIENCE = 'closeline'

/** The container plus the observable side effects a test asserts on. */
export type TestDeps = Container & {
  clock: FixedClock
  /** Time that moves only when a test advances it; the queue, store and consumer share it. */
  time: VirtualTime
  queue: MemoryQueue<OutboundDefinition>
  /** Core in memory: seed Prospects, read what enrichment wrote, count the calls. */
  core: MemoryCore
  /** Contact Check stand-in: allow or deny a Prospect, or make the check unavailable. */
  guard: MemoryContactGuard
  /** The provider settings; a test sets them per Organization. */
  config: ReturnType<typeof createMemoryProviderConfig>
  /** The store in memory, to read spend. */
  store: ReturnType<typeof createMemoryEnrichmentStore>
  /** The kit's memory error reporter: what the consumer and the error handler would send to Sentry. */
  errors: MemoryErrorReporter
  /** The engine's Draft, approvals and contact stand-ins: shape a Draft, read what went to approvals. */
  engineDrafts: ReturnType<typeof createMemoryDraftSource>
  engineApprovals: ReturnType<typeof createMemoryApprovals>
  engineContacts: ReturnType<typeof createMemoryProspectContacts>
  /** The Gmail stand-in: consent as a person, revoke a grant, fail the provider, read what was sent. */
  mail: MemoryMailTransport
  /** The Outlook stand-in, same controls. */
  outlookMail: MemoryMailTransport
  /** The LinkedIn provider stand-in: complete a hosted login, change an account's status, fail it. */
  linkedinProvider: MemoryLinkedInProvider
  /** The LinkedIn store in memory, to set the channel's state. */
  linkedinStore: MemoryLinkedinStore
  /** Every `mailbox.state_changed` published, in order. */
  mailEvents: { organizationId: string; event: MailboxStateChanged }[]
  /** The mail event module's deps: provider notifications and the unsubscribe page. */
  inboundMail: Container['inboundMail']
  /** The suppression stand-in for core: what bounces, complaints and unsubscribes suppressed. */
  suppression: MemoryCoreSuppression
  /** Every `mail.*` event published, in order. */
  inboundEvents: { organizationId: string; event: MailEvent }[]
  /** Every `signal.recorded` and `prospect.fit_changed` published, in order. */
  signalEvents: { organizationId: string; event: SignalEvent }[]
  /** The `linkedin.channel_disabled` events published, in order. */
  linkedinEvents: { organizationId: string; event: LinkedinChannelDisabled }[]
  /** The `linkedin.account_paused` events published, in order. */
  linkedinPaused: { organizationId: string; event: LinkedinAccountPaused }[]
  /** Every JSON log line written, in order. */
  logLines: string[]
  /** Every call to `reportError`, in order. */
  reported: { error: unknown; context: ErrorContext }[]
}

/** What a test may replace in {@link createTestDeps}. */
export type TestDepsOverrides = {
  readinessChecks?: readonly ReadinessCheck[]
  env?: Record<string, string>
  /** The access-token verifier; defaults to one that rejects every token. */
  tokenVerifier?: TokenVerifier
  /** The providers the waterfall may ask; none by default. */
  providers?: readonly MemoryProvider[]
  /** The email verifiers; none by default. */
  verifiers?: readonly MemoryVerifier[]
  /** Messages handled at once; defaults to the environment's setting. */
  consumerConcurrency?: number
}

const REJECTING_VERIFIER: TokenVerifier = {
  verify: async () => {
    throw new TokenVerificationError('invalid')
  },
}

/** Builds a container of in-memory doubles and virtual time; `overrides` replace any field. */
export function createTestDeps(overrides: TestDepsOverrides = {}): TestDeps {
  const logLines: string[] = []
  const reported: TestDeps['reported'] = []
  const time = createVirtualTime()
  const errors = createMemoryErrorReporter()
  const logger = createLogger({
    service: SERVICE,
    level: 'debug',
    destination: { write: (line) => void logLines.push(line) },
  })
  const env = loadEnv({
    ENVIRONMENT: 'local',
    LOG_LEVEL: 'debug',
    // Every key that is required outside local, so a test may set any ENVIRONMENT.
    REGION: 'us',
    SENTRY_DSN: 'https://public@sentry.test/1',
    DATABASE_URL: 'postgres://closeline_outbound:closeline_outbound_local@127.0.0.1:5432/closeline',
    AUTH_JWKS_URL: `${TEST_ISSUER}/.well-known/jwks.json`,
    AUTH_ISSUER: TEST_ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    AWS_REGION: 'us-east-1',
    QUEUE_URL: 'https://sqs.test/000000000000/outbound',
    CORE_URL: 'https://core.test',
    CORE_INTERNAL_SECRET: 'testing-shared-secret-0123456789-abcdefg',
    MAIL_STATE_SECRET: 'testing-mail-state-secret-0123456789-abcdef',
    MAIL_UNSUBSCRIBE_URL: 'https://app.test/unsubscribe',
    ...overrides.env,
  })
  const queue = createMemoryQueue({ registry, clock: time.clock, sleep: time.sleep })
  const processed = createMemoryProcessedStore({ clock: time.clock })
  const core = createMemoryCore()
  const secretBox = createMemorySecretBox()
  const vault = createSecretBoxVault(secretBox)
  const config = createMemoryProviderConfig(vault)
  const store = createMemoryEnrichmentStore()
  const enrichment: Container['enrichment'] = {
    store,
    core: core.prospects,
    access: core.access,
    config,
    vault,
    providers: overrides.providers ?? [],
    verifiers: overrides.verifiers ?? [],
    queue,
    clock: time.clock,
    sleep: time.sleep,
    random: () => 0.5,
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

  const guard = createMemoryContactGuard()
  const campaigns: Container['campaigns'] = {
    store: createMemoryCampaignStore(),
    access: core.access,
    clock: time.clock,
    enrollments: createMemoryEnrollmentStore(),
    checks: createMemoryAudienceCheckStore(),
    audience: core.audience,
    guard,
    queue,
    logger,
  }

  const brandVoice: Container['brandVoice'] = {
    store: createMemoryBrandVoiceStore(),
    access: core.access,
    clock: time.clock,
  }

  const mail = createMemoryMailTransport({
    clock: time.clock,
    redirectUri: env.MAIL_OAUTH_REDIRECT_URI,
  })
  const outlookMail = createMemoryMailTransport({
    clock: time.clock,
    redirectUri: env.MAIL_OAUTH_REDIRECT_URI,
    provider: 'outlook',
  })
  const mailEvents: TestDeps['mailEvents'] = []
  const signalEvents: TestDeps['signalEvents'] = []
  const publishSignal: SignalDeps['events'] = async (organizationId, event) => {
    signalEvents.push({ organizationId, event })
  }
  const signals: Container['signals'] = {
    store: createMemorySignalStore(),
    core: core.prospects,
    access: core.access,
    secretBox: createMemorySecretBox(),
    clock: time.clock,
    events: publishSignal,
  }
  const fit: Container['fit'] = {
    store: createMemoryFitStore(),
    core: core.prospects,
    access: core.access,
    clock: time.clock,
    events: publishSignal,
  }
  const mailboxes: Container['mailboxes'] = {
    store: createMemoryMailboxStore(),
    access: core.access,
    clock: time.clock,
    secretBox,
    transports: { gmail: mail, outlook: outlookMail },
    stateSecret: env.MAIL_STATE_SECRET,
    events: async (organizationId, event) => {
      mailEvents.push({ organizationId, event })
    },
    logger,
  }

  const send: Container['send'] = {
    store: createMemorySendStore(() => time.clock.now().toISOString()),
    mailboxes,
    campaigns: campaigns.store,
    guard,
    clock: time.clock,
    logger,
    unsubscribe: { secret: env.MAIL_STATE_SECRET, url: env.MAIL_UNSUBSCRIBE_URL },
    organizationDailyCap: env.MAIL_ORG_DAILY_CAP,
  }

  const suppression = createMemoryCoreSuppression()
  const inboundEvents: TestDeps['inboundEvents'] = []
  const inboundMail: Container['inboundMail'] = {
    mailboxes,
    sends: send.store,
    enrollments: campaigns.enrollments,
    log: createMemoryMailEventStore(),
    prospects: core.prospects,
    suppression,
    clock: time.clock,
    logger,
    secret: env.MAIL_STATE_SECRET,
    publish: async (organizationId, event) => {
      inboundEvents.push({ organizationId, event })
    },
  }
  const engineDrafts = createMemoryDraftSource(() => time.clock.now().toISOString())
  const engineApprovals = createMemoryApprovals()
  const engineContacts = createMemoryProspectContacts()
  const engine: Container['engine'] = {
    enrollments: campaigns.enrollments,
    campaigns: campaigns.store,
    send,
    drafts: engineDrafts,
    approvals: engineApprovals,
    contacts: engineContacts,
    queue,
    clock: time.clock,
    random: Math.random,
    logger,
    limits: { orgBatch: 50, stepPage: 100, leaseSeconds: 600 },
  }

  const linkedinEvents: TestDeps['linkedinEvents'] = []
  const linkedinPaused: TestDeps['linkedinPaused'] = []
  const linkedinProvider = createMemoryLinkedInProvider(time.clock)
  const linkedinStore = createMemoryLinkedinStore()
  const linkedin: Container['linkedin'] = {
    store: linkedinStore,
    access: core.access,
    clock: time.clock,
    provider: linkedinProvider,
    events: async (organizationId, event) => {
      linkedinEvents.push({ organizationId, event })
    },
    guard,
    accountPaused: async (organizationId, event) => {
      linkedinPaused.push({ organizationId, event })
    },
    // No waiting in tests, no jitter, and no gap between sends unless a test sets one.
    send: defaultSendSettings({ sleep: async () => {}, random: () => 0, minGapMs: 0, jitterMs: 0 }),
    logger,
  }

  return {
    env,
    logger,
    clock: time.clock,
    time,
    tokenVerifier: overrides.tokenVerifier ?? REJECTING_VERIFIER,
    withOrganization: () => {
      throw new Error('this test container has no database; use the integration harness')
    },
    queue,
    processed,
    enrichment,
    campaigns,
    brandVoice,
    mailboxes,
    signals,
    fit,
    signalEvents,
    send,
    linkedin,
    engine,
    engineDrafts,
    engineApprovals,
    engineContacts,
    ai: { model: createMemoryModel(), web: createMemoryWebSearch() },
    linkedinProvider,
    linkedinStore,
    mail,
    outlookMail,
    mailEvents,
    inboundMail,
    suppression,
    inboundEvents,
    linkedinEvents,
    linkedinPaused,
    core,
    guard,
    config,
    store,
    consumer: createOutboundConsumer({
      queue,
      store: processed,
      logger,
      errorReporter: errors,
      handlers: {
        ...enrichmentHandlers(enrichment),
        ...campaignHandlers(campaigns),
        ...engineHandlers(engine),
      },
      concurrency: overrides.consumerConcurrency ?? env.CONSUMER_CONCURRENCY,
      sleep: time.sleep,
    }),
    readinessChecks: overrides.readinessChecks ?? [],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      reported.push({ error, context })
    },
    close: async () => undefined,
    errors,
    logLines,
    reported,
  }
}

/** Who a minted access token names. */
export type TestIdentity = { userId: UserId; organizationId: OrganizationId; role: Role }

/** A fresh user id, for a test that needs one nobody else has. */
export function newUserId(): UserId {
  return formatId('usr', crypto.randomUUID())
}

/** A fresh Organization id. */
export function newOrganizationId(): OrganizationId {
  return formatId('org', crypto.randomUUID())
}

/** The app, its container, and what a test needs to call it as someone. */
export type TestApp = {
  app: OpenAPIHono<AppEnv>
  deps: TestDeps
  /** The `Authorization` header of a valid access token for `identity`. */
  bearer(identity: TestIdentity): Promise<{ authorization: string }>
  /** A token signed by a key the service does not trust, for `identity`. */
  bearerFromUnknownKey(identity: TestIdentity): Promise<{ authorization: string }>
  /** A token signed by the trusted key with `claims` or an `audience` or `issuer` overridden. */
  bearerWith(
    identity: TestIdentity,
    options: Pick<MintTokenOptions, 'audience' | 'issuer' | 'claims'>
  ): Promise<{ authorization: string }>
}

/**
 * The whole app over a fresh container, with a verifier that accepts the tokens `bearer` signs
 * (a real Ed25519 key pair, verified the way production verifies) and nothing else.
 */
export async function createTestApp(overrides: TestDepsOverrides = {}): Promise<TestApp> {
  const keyPair = await createTestKeyPair()
  const strangerKeyPair = await createTestKeyPair('stranger')
  // The verifier and the minted tokens read the deps' clock, whatever a test advances it to.
  const holder: { deps?: TestDeps } = {}
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    keys: await createStaticKeySet(createTestJwks(keyPair)),
    clock: { now: () => holder.deps?.clock.now() ?? new Date('2026-01-01T00:00:00Z') },
  })
  const deps = createTestDeps({ tokenVerifier: verifier, ...overrides })
  holder.deps = deps
  const mint = async (
    pair: typeof keyPair,
    identity: TestIdentity,
    options: Pick<MintTokenOptions, 'audience' | 'issuer' | 'claims'> = {}
  ) => ({
    authorization: `Bearer ${await mintTestToken({
      keyPair: pair,
      clock: deps.clock,
      ...options,
      claims: {
        sub: identity.userId,
        org: identity.organizationId,
        role: identity.role,
        ...options.claims,
      },
    })}`,
  })

  return {
    app: createApp(deps),
    deps,
    bearer: (identity) => mint(keyPair, identity),
    bearerFromUnknownKey: (identity) => mint(strangerKeyPair, identity),
    bearerWith: (identity, options) => mint(keyPair, identity, options),
  }
}
