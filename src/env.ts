import { regionSchema } from 'tula-closeline-contract'
import { requireSentryDsn, sentryDsnSchema } from 'tula-closeline-kit'
import { z } from 'zod'

/** The `closeline_outbound` login of the compose Postgres, used only when `ENVIRONMENT` is `local`. */
const LOCAL_DATABASE_URL =
  'postgres://closeline_outbound:closeline_outbound_local@127.0.0.1:5432/closeline'

/** The auth service's local address, used only when `ENVIRONMENT` is `local`. */
const LOCAL_AUTH_ORIGIN = 'http://127.0.0.1:3001'

/** The audience a local run expects in access tokens. */
const DEFAULT_AUTH_AUDIENCE = 'closeline'

/** The AWS Region a local run names; ElasticMQ ignores it but the SDK needs one. */
const LOCAL_AWS_REGION = 'us-east-1'

/** The keys that must be set in every environment but `local`, where they have defaults. */
const REQUIRED_OUTSIDE_LOCAL = [
  'REGION',
  'DATABASE_URL',
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'AWS_REGION',
  'QUEUE_URL',
  'CORE_URL',
  'CORE_INTERNAL_SECRET',
] as const

/**
 * A whole number written as digits only, within bounds. Stricter than `z.coerce.number()`, which
 * turns `''` into 0 and reads ` 5`, `0x10` and `1e1` as numbers.
 */
function integer(min: number, max: number) {
  return z
    .string()
    .regex(/^[0-9]{1,15}$/, 'must be a whole number written in digits')
    .transform(Number)
    .pipe(z.number().min(min).max(max))
}

/** The shortest shared secret core accepts, in characters (core's own floor). */
const MIN_INTERNAL_SECRET_LENGTH = 32

/** The most grace plus drain may add up to, so an orchestrator's kill window is not outlasted. */
const MAX_SHUTDOWN_TOTAL_MS = 60_000

const schema = z
  .object({
    /** Which deployment this is. No default: a deploy that forgets it must fail at boot. */
    ENVIRONMENT: z.enum(['local', 'dev', 'staging', 'prod']),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    /** The longest one readiness check may take before it counts as failed. */
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
    /** The longest shutdown waits for in-flight requests before closing them. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
    /** How long `/readyz` reports 503 before the server stops accepting, so the balancer moves on. */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    /** The largest request body accepted, in bytes; anything bigger is a 413. */
    MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1).max(104_857_600).default(1_048_576),

    /** The Region this deployment serves; every Organization lives in the Region of its deployment. */
    REGION: regionSchema.optional(),
    /** The Sentry DSN of this Region's project; optional in `local`, required elsewhere. */
    SENTRY_DSN: sentryDsnSchema,
    /** The git SHA of the running build, sent to the error tracker as the release. */
    GIT_SHA: z.string().min(1).max(64).optional(),

    /** Postgres connection string of the `closeline_outbound` login. It carries a password: never log it. */
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string')
      .optional(),
    /** Where the auth service publishes its signing keys (https; http only when local). */
    AUTH_JWKS_URL: z.url().optional(),
    /** The `iss` every access token must carry. */
    AUTH_ISSUER: z.string().min(1).max(2_048).optional(),
    /** The `aud` every access token must carry. */
    AUTH_AUDIENCE: z.string().min(1).max(2_048).optional(),

    /** The AWS Region of the queue (not the Closeline Region above). */
    AWS_REGION: z.string().min(1).max(64).optional(),
    /** The enrichment queue's URL. Unset in `local` means the in-memory queue; required elsewhere. */
    QUEUE_URL: z.url().max(2_048).optional(),
    /** Where ElasticMQ listens, for a local run against it. Accepted only when `local`. */
    QUEUE_ENDPOINT: z.url().max(2_048).optional(),
    /** Messages the queue consumer handles at once. */
    CONSUMER_CONCURRENCY: integer(1, 100).default(4),
    /** The longest the consumer waits for messages in flight when it stops, in ms. */
    CONSUMER_STOP_DEADLINE_MS: integer(1, 120_000).default(5_000),

    /**
     * The most one Organization may spend on enrichment providers in a calendar month (UTC), in
     * micro-dollars (1_000_000 = 1 USD). The default is 50 USD. Checked before every provider call.
     */
    ENRICHMENT_MONTHLY_BUDGET_MICROS: integer(0, 1_000_000_000_000).default(50_000_000),
    /** The most one run may spend, in micro-dollars (the run ceiling). The default is 1 USD. */
    ENRICHMENT_RUN_CEILING_MICROS: integer(0, 1_000_000_000_000).default(1_000_000),
    /** The longest one provider call may take before it counts as a timeout, in ms. */
    ENRICHMENT_PROVIDER_TIMEOUT_MS: integer(100, 120_000).default(10_000),
    /** The most times one provider call is tried (the first try included) on a retryable failure. */
    ENRICHMENT_PROVIDER_MAX_TRIES: integer(1, 5).default(2),
    /** The first retry delay before jitter, in ms; it doubles per try. */
    ENRICHMENT_RETRY_BASE_MS: integer(1, 60_000).default(200),
    /** How long a run stays claimed by one worker before another may take it over, in seconds. */
    ENRICHMENT_RUN_LEASE_SECONDS: integer(5, 3_600).default(120),

    /** Core's origin for the enrichment read and write-back. Unset in `local` means in-memory core; required elsewhere. */
    CORE_URL: z.url().max(2_048).optional(),
    /** The shared secret core accepts from this service (ADR 0013), sent as a bearer. Never log it. */
    CORE_INTERNAL_SECRET: z
      .string()
      .min(MIN_INTERNAL_SECRET_LENGTH, `must be at least ${MIN_INTERNAL_SECRET_LENGTH} characters`)
      .max(512)
      .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII with no space')
      .optional(),
    /** The longest one call to core may take, in ms. */
    CORE_CALL_TIMEOUT_MS: integer(100, 60_000).default(5_000),
    /** The most times one call to core is tried (the first included) on a network error or 503. */
    CORE_CALL_MAX_TRIES: integer(1, 5).default(3),
  })
  .refine((env) => env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS <= MAX_SHUTDOWN_TOTAL_MS, {
    message: `SHUTDOWN_GRACE_MS plus SHUTDOWN_TIMEOUT_MS must not exceed ${MAX_SHUTDOWN_TOTAL_MS} ms in total`,
    path: ['SHUTDOWN_TIMEOUT_MS'],
  })
  .refine((env) => env.CONSUMER_STOP_DEADLINE_MS <= env.SHUTDOWN_TIMEOUT_MS, {
    message: 'CONSUMER_STOP_DEADLINE_MS must not exceed SHUTDOWN_TIMEOUT_MS',
    path: ['CONSUMER_STOP_DEADLINE_MS'],
  })
  .superRefine(requireSentryDsn)
  .superRefine((env, context) => {
    // Messages name the key and the rule, never the value: a URL can carry credentials.
    if (env.ENVIRONMENT !== 'local') {
      for (const key of REQUIRED_OUTSIDE_LOCAL) {
        if (env[key] === undefined) {
          context.addIssue({ code: 'custom', path: [key], message: `${key} is required` })
        }
      }
      if (env.QUEUE_ENDPOINT !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['QUEUE_ENDPOINT'],
          message: 'QUEUE_ENDPOINT is accepted only when ENVIRONMENT is local',
        })
      }
    }
    if (env.CORE_URL !== undefined && env.CORE_INTERNAL_SECRET === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['CORE_INTERNAL_SECRET'],
        message: 'CORE_INTERNAL_SECRET is required when CORE_URL is set',
      })
    }
    if (env.QUEUE_ENDPOINT !== undefined && env.QUEUE_URL === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['QUEUE_ENDPOINT'],
        message: 'QUEUE_ENDPOINT needs QUEUE_URL',
      })
    }
  })
  .transform((env) => ({
    ...env,
    REGION: env.REGION ?? regionSchema.parse('us'),
    DATABASE_URL: env.DATABASE_URL ?? LOCAL_DATABASE_URL,
    AUTH_JWKS_URL: env.AUTH_JWKS_URL ?? `${LOCAL_AUTH_ORIGIN}/.well-known/jwks.json`,
    AUTH_ISSUER: env.AUTH_ISSUER ?? LOCAL_AUTH_ORIGIN,
    AUTH_AUDIENCE: env.AUTH_AUDIENCE ?? DEFAULT_AUTH_AUDIENCE,
    AWS_REGION: env.AWS_REGION ?? LOCAL_AWS_REGION,
  }))

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}
