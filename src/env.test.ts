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
  })
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
