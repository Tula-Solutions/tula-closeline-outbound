import { expect, test } from 'bun:test'
import { loadEnv } from './env'

test('configuration falls back to defaults for everything but the environment', () => {
  expect(loadEnv({ ENVIRONMENT: 'local' })).toEqual({
    ENVIRONMENT: 'local',
    PORT: 3000,
    LOG_LEVEL: 'info',
    READINESS_TIMEOUT_MS: 2_000,
    SHUTDOWN_TIMEOUT_MS: 10_000,
    SHUTDOWN_GRACE_MS: 5_000,
    MAX_REQUEST_BODY_BYTES: 1_048_576,
    REGION: 'us',
    DATABASE_URL: 'postgres://closeline_outbound:closeline_outbound_local@127.0.0.1:5432/closeline',
    AUTH_JWKS_URL: 'http://127.0.0.1:3001/.well-known/jwks.json',
    AUTH_ISSUER: 'http://127.0.0.1:3001',
    AUTH_AUDIENCE: 'closeline',
    AWS_REGION: 'us-east-1',
    CONSUMER_CONCURRENCY: 4,
    CONSUMER_STOP_DEADLINE_MS: 5_000,
    ENRICHMENT_MONTHLY_BUDGET_MICROS: 50_000_000,
    ENRICHMENT_RUN_CEILING_MICROS: 1_000_000,
    ENRICHMENT_PROVIDER_TIMEOUT_MS: 10_000,
    ENRICHMENT_PROVIDER_MAX_TRIES: 2,
    ENRICHMENT_RETRY_BASE_MS: 200,
    ENRICHMENT_RUN_LEASE_SECONDS: 120,
    APOLLO_BASE_URL: 'https://api.apollo.io',
    ZEROBOUNCE_BASE_URL: 'https://api.zerobounce.net',
    PROVIDER_CIRCUIT_FAILURES: 5,
    PROVIDER_CIRCUIT_OPEN_MS: 30_000,
    CORE_CALL_TIMEOUT_MS: 5_000,
    CORE_CALL_MAX_TRIES: 3,
    GOOGLE_AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
    GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
    GOOGLE_REVOKE_URL: 'https://oauth2.googleapis.com/revoke',
    GMAIL_API_BASE_URL: 'https://gmail.googleapis.com',
    MICROSOFT_AUTH_URL: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    MICROSOFT_TOKEN_URL: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    GRAPH_API_BASE_URL: 'https://graph.microsoft.com',
    MAIL_OAUTH_REDIRECT_URI: 'http://127.0.0.1:3000/mailboxes/connect/callback',
    MAIL_STATE_SECRET: 'local-only-mail-state-secret-do-not-use',
    MAIL_CALL_TIMEOUT_MS: 10_000,
    MAIL_CALL_MAX_TRIES: 3,
    MAIL_RETRY_BASE_MS: 200,
    MAIL_UNSUBSCRIBE_URL: 'http://127.0.0.1:3000/unsubscribe',
    MAIL_ORG_DAILY_CAP: 500,
    ENGINE_ENABLED: 'false',
    ENGINE_SWEEP_INTERVAL_MS: 30_000,
    ENGINE_ORG_BATCH: 50,
    ENGINE_STEP_PAGE: 100,
    ENGINE_LEASE_SECONDS: 600,
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_NO_TRAINING_CONFIRMED: 'false',
    MODEL_MONTHLY_BUDGET_MICROS: 50_000_000,
    MODEL_INPUT_MICROS_PER_MILLION: 3_000_000,
    MODEL_OUTPUT_MICROS_PER_MILLION: 15_000_000,
    EXA_BASE_URL: 'https://api.exa.ai',
    AI_CALL_TIMEOUT_MS: 20_000,
    AI_CALL_MAX_TRIES: 2,
    AI_RETRY_BASE_MS: 200,
  })
})

test('a Google client id needs its secret', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', GOOGLE_CLIENT_ID: 'id' })).toThrow(
    /GOOGLE_CLIENT_SECRET.*is required/s
  )
})

test('a Microsoft client id needs its secret, and its endpoints are https outside local', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', MICROSOFT_CLIENT_ID: 'id' })).toThrow(
    /MICROSOFT_CLIENT_SECRET.*is required/s
  )
  expect(() =>
    loadEnv({ ENVIRONMENT: 'dev', GRAPH_API_BASE_URL: 'http://127.0.0.1:3200' })
  ).toThrow(/GRAPH_API_BASE_URL must be https/)
})

test('the local AES key is refused in staging and prod', () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  expect(loadEnv({ ENVIRONMENT: 'local', MAIL_SECRET_BOX_KEY: key }).MAIL_SECRET_BOX_KEY).toBe(key)
  expect(() => loadEnv({ ENVIRONMENT: 'staging', MAIL_SECRET_BOX_KEY: key })).toThrow(
    /MAIL_SECRET_BOX_KEY/
  )
})

test('a short state secret is refused', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', MAIL_STATE_SECRET: 'short' })).toThrow(
    /MAIL_STATE_SECRET/
  )
})

test('a provider endpoint must be https outside local', () => {
  expect(
    loadEnv({ ENVIRONMENT: 'local', GOOGLE_TOKEN_URL: 'http://127.0.0.1:3010/token' })
      .GOOGLE_TOKEN_URL
  ).toBe('http://127.0.0.1:3010/token')
  expect(() =>
    loadEnv({ ENVIRONMENT: 'dev', GOOGLE_TOKEN_URL: 'http://127.0.0.1:3010/token' })
  ).toThrow(/GOOGLE_TOKEN_URL must be https/)
})

test('a deploy without ENVIRONMENT fails at boot instead of running as local', () => {
  expect(() => loadEnv({})).toThrow()
})

test.each([
  ['an unknown environment', { ENVIRONMENT: 'production' }],
  ['an unknown log level', { LOG_LEVEL: 'verbose' }],
  ['a port out of range', { PORT: '70000' }],
  ['a zero readiness timeout', { READINESS_TIMEOUT_MS: '0' }],
  ['a non-numeric shutdown timeout', { SHUTDOWN_TIMEOUT_MS: 'soon' }],
  ['a negative shutdown grace', { SHUTDOWN_GRACE_MS: '-1' }],
  ['a zero body limit', { MAX_REQUEST_BODY_BYTES: '0' }],
  ['a body limit above 100 MB', { MAX_REQUEST_BODY_BYTES: '104857601' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', ...source })).toThrow()
})

test('a grace period plus drain timeout above 60 s is rejected, naming both keys', () => {
  const source = { ENVIRONMENT: 'local', SHUTDOWN_GRACE_MS: '30001', SHUTDOWN_TIMEOUT_MS: '30000' }

  expect(() => loadEnv(source)).toThrow(/SHUTDOWN_GRACE_MS.*SHUTDOWN_TIMEOUT_MS/s)
})

test('a grace period plus drain timeout of exactly 60 s is accepted', () => {
  const env = loadEnv({
    ENVIRONMENT: 'local',
    SHUTDOWN_GRACE_MS: '30000',
    SHUTDOWN_TIMEOUT_MS: '30000',
  })

  expect(env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS).toBe(60_000)
})

test.each([
  ['a monthly budget written with a unit', { ENRICHMENT_MONTHLY_BUDGET_MICROS: '5e7' }],
  ['an empty run ceiling', { ENRICHMENT_RUN_CEILING_MICROS: '' }],
  ['a negative run ceiling', { ENRICHMENT_RUN_CEILING_MICROS: '-1' }],
  ['a provider timeout under 100 ms', { ENRICHMENT_PROVIDER_TIMEOUT_MS: '99' }],
  ['no provider tries at all', { ENRICHMENT_PROVIDER_MAX_TRIES: '0' }],
  ['a consumer deadline longer than the shutdown timeout', { CONSUMER_STOP_DEADLINE_MS: '10001' }],
  ['a queue endpoint without a queue', { QUEUE_ENDPOINT: 'http://127.0.0.1:9324' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', ...source })).toThrow()
})

test('outside local, the database, auth, queue and Region keys are required, by name', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'prod' })).toThrow(/DATABASE_URL.*is required/s)
  expect(() => loadEnv({ ENVIRONMENT: 'prod' })).toThrow(/QUEUE_URL.*is required/s)
})

test('the budget and the run ceiling are read in micro-dollars', () => {
  const env = loadEnv({
    ENVIRONMENT: 'local',
    ENRICHMENT_MONTHLY_BUDGET_MICROS: '2000000',
    ENRICHMENT_RUN_CEILING_MICROS: '40000',
  })

  expect(env.ENRICHMENT_MONTHLY_BUDGET_MICROS).toBe(2_000_000)
  expect(env.ENRICHMENT_RUN_CEILING_MICROS).toBe(40_000)
})

const CORE_SECRET = 'core-shared-secret-0123456789-abcdefgh'

test('a core address needs the shared secret, and the message never shows the secret', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', CORE_URL: 'http://127.0.0.1:3002' })).toThrow(
    /CORE_INTERNAL_SECRET.*is required/s
  )
  const env = loadEnv({
    ENVIRONMENT: 'local',
    CORE_URL: 'http://127.0.0.1:3002',
    CORE_INTERNAL_SECRET: CORE_SECRET,
  })
  expect(env.CORE_URL).toBe('http://127.0.0.1:3002')
  expect(env.CORE_INTERNAL_SECRET).toBe(CORE_SECRET)
})

test.each([
  ['a short secret', { CORE_INTERNAL_SECRET: 'short' }],
  ['a secret with a space', { CORE_INTERNAL_SECRET: `${CORE_SECRET} x` }],
  ['an address that is not a URL', { CORE_URL: 'core' }],
  ['a zero call timeout', { CORE_CALL_TIMEOUT_MS: '0' }],
  ['no call tries at all', { CORE_CALL_MAX_TRIES: '0' }],
])('configuration rejects %s for core at boot', (_name, source) => {
  const attempt = () =>
    loadEnv({
      ENVIRONMENT: 'local',
      CORE_URL: 'http://127.0.0.1:3002',
      CORE_INTERNAL_SECRET: CORE_SECRET,
      ...source,
    })
  expect(attempt).toThrow()
  try {
    attempt()
  } catch (error) {
    expect(String(error)).not.toContain(CORE_SECRET)
  }
})

test('outside local, the core address and the shared secret are required, by name', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'prod' })).toThrow(/CORE_URL.*is required/s)
  expect(() => loadEnv({ ENVIRONMENT: 'prod' })).toThrow(/CORE_INTERNAL_SECRET.*is required/s)
})

test('a run lease no longer than the worst-case provider attempt time is rejected, naming the key', () => {
  // 3 tries of 10 s, plus backoff of 1 s and 2 s at 1.5x jitter: 34.5 s at worst.
  const source = {
    ENVIRONMENT: 'local',
    ENRICHMENT_PROVIDER_TIMEOUT_MS: '10000',
    ENRICHMENT_PROVIDER_MAX_TRIES: '3',
    ENRICHMENT_RETRY_BASE_MS: '1000',
  }

  expect(() => loadEnv({ ...source, ENRICHMENT_RUN_LEASE_SECONDS: '34' })).toThrow(
    /ENRICHMENT_RUN_LEASE_SECONDS/
  )
  expect(
    loadEnv({ ...source, ENRICHMENT_RUN_LEASE_SECONDS: '35' }).ENRICHMENT_RUN_LEASE_SECONDS
  ).toBe(35)
})

test('the model and web search are unconfigured by default and Anthropic needs no-training confirmation off by default', () => {
  const env = loadEnv({ ENVIRONMENT: 'local' })
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(env.EXA_API_KEY).toBeUndefined()
  expect(env.ANTHROPIC_NO_TRAINING_CONFIRMED).toBe('false')
})
