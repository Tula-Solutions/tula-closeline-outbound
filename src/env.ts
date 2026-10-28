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
  'MAIL_STATE_SECRET',
  'MAIL_UNSUBSCRIBE_URL',
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

/**
 * The longest one provider step can take, in ms: every try runs to its timeout, and each retry
 * waits the base delay doubled per try at the top of the waterfall's 0.5x to 1.5x jitter.
 */
function worstProviderAttemptMs(env: {
  ENRICHMENT_PROVIDER_TIMEOUT_MS: number
  ENRICHMENT_PROVIDER_MAX_TRIES: number
  ENRICHMENT_RETRY_BASE_MS: number
}): number {
  const tries = env.ENRICHMENT_PROVIDER_MAX_TRIES
  const backoff = 1.5 * env.ENRICHMENT_RETRY_BASE_MS * (2 ** (tries - 1) - 1)
  return env.ENRICHMENT_PROVIDER_TIMEOUT_MS * tries + backoff
}

/** Google's own endpoints, used unless a local run points them at the fake provider. */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com'

/** Microsoft's own endpoints (tenant `common`: work, school and personal accounts). */
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const GRAPH_API_BASE_URL = 'https://graph.microsoft.com'

/** Where the portal receives the provider's redirect in a local run. */
const LOCAL_MAIL_REDIRECT_URI = 'http://127.0.0.1:3000/mailboxes/connect/callback'

/** The signing secret of connect attempts in a local run; any other environment must set its own. */
const LOCAL_MAIL_STATE_SECRET = 'local-only-mail-state-secret-do-not-use'

/** The shortest connect-attempt signing secret, in characters. */
const MIN_MAIL_STATE_SECRET_LENGTH = 32

/** The public unsubscribe page a local run links to (the portal's address). */
const LOCAL_MAIL_UNSUBSCRIBE_URL = 'http://127.0.0.1:3000/unsubscribe'

/** The keys of a Mailbox provider's endpoints, which must be https outside `local`. */
const MAIL_ENDPOINT_KEYS = [
  'GOOGLE_AUTH_URL',
  'GOOGLE_TOKEN_URL',
  'GOOGLE_REVOKE_URL',
  'GMAIL_API_BASE_URL',
  'MICROSOFT_AUTH_URL',
  'MICROSOFT_TOKEN_URL',
  'GRAPH_API_BASE_URL',
  'MAIL_OAUTH_REDIRECT_URI',
] as const

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

    /** The Google OAuth client for Gmail Mailboxes. Unset in `local` means the in-memory provider. */
    GOOGLE_CLIENT_ID: z.string().min(1).max(512).optional(),
    /** The Google OAuth client secret; required with `GOOGLE_CLIENT_ID`. Never log it. */
    GOOGLE_CLIENT_SECRET: z.string().min(1).max(512).optional(),
    /** Google's consent page; a local run may point it at the fake provider. */
    GOOGLE_AUTH_URL: z.url().max(2_048).default(GOOGLE_AUTH_URL),
    /** Google's token endpoint. */
    GOOGLE_TOKEN_URL: z.url().max(2_048).default(GOOGLE_TOKEN_URL),
    /** Google's revoke endpoint. */
    GOOGLE_REVOKE_URL: z.url().max(2_048).default(GOOGLE_REVOKE_URL),
    /** The Gmail API's origin. */
    GMAIL_API_BASE_URL: z.url().max(2_048).default(GMAIL_API_BASE_URL),
    /** The Microsoft (Entra) app for Outlook Mailboxes. Unset in `local` means the in-memory provider. */
    MICROSOFT_CLIENT_ID: z.string().min(1).max(512).optional(),
    /** The Microsoft app's client secret; required with `MICROSOFT_CLIENT_ID`. Never log it. */
    MICROSOFT_CLIENT_SECRET: z.string().min(1).max(512).optional(),
    /** Microsoft's consent page; a local run may point it at a fake. */
    MICROSOFT_AUTH_URL: z.url().max(2_048).default(MICROSOFT_AUTH_URL),
    /** Microsoft's token endpoint. */
    MICROSOFT_TOKEN_URL: z.url().max(2_048).default(MICROSOFT_TOKEN_URL),
    /** The Microsoft Graph origin. */
    GRAPH_API_BASE_URL: z.url().max(2_048).default(GRAPH_API_BASE_URL),
    /** Where the provider sends the person back to; the portal receives it and completes the connection. */
    MAIL_OAUTH_REDIRECT_URI: z.url().max(2_048).optional(),
    /** The secret that signs connect attempts (at least 32 characters). Required outside `local`. Never log it. */
    MAIL_STATE_SECRET: z
      .string()
      .min(
        MIN_MAIL_STATE_SECRET_LENGTH,
        `must be at least ${MIN_MAIL_STATE_SECRET_LENGTH} characters`
      )
      .max(512)
      .optional(),
    /** A local AES key (base64 of 32 bytes) for sealing tokens; refused in staging and prod, where KMS replaces it. */
    MAIL_SECRET_BOX_KEY: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be base64 of 32 bytes')
      .optional(),
    /** The longest one call to a Mailbox provider may take, in ms. */
    MAIL_CALL_TIMEOUT_MS: integer(100, 60_000).default(10_000),
    /** The most times one repeatable call to a Mailbox provider is tried (the first included). */
    MAIL_CALL_MAX_TRIES: integer(1, 5).default(3),
    /** The first retry delay of a Mailbox provider call, in ms; it doubles per try, jittered. */
    MAIL_RETRY_BASE_MS: integer(1, 60_000).default(200),
    /** Where the unsubscribe link in every email points (the public page); the signed token is appended. Required outside `local`. */
    MAIL_UNSUBSCRIBE_URL: z.url().max(2_048).optional(),
    /** The most emails the Organization sends in one UTC day across all its Mailboxes. */
    MAIL_ORG_DAILY_CAP: integer(1, 100_000).default(500),
  })
  .refine((env) => env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS <= MAX_SHUTDOWN_TOTAL_MS, {
    message: `SHUTDOWN_GRACE_MS plus SHUTDOWN_TIMEOUT_MS must not exceed ${MAX_SHUTDOWN_TOTAL_MS} ms in total`,
    path: ['SHUTDOWN_TIMEOUT_MS'],
  })
  .refine((env) => env.CONSUMER_STOP_DEADLINE_MS <= env.SHUTDOWN_TIMEOUT_MS, {
    message: 'CONSUMER_STOP_DEADLINE_MS must not exceed SHUTDOWN_TIMEOUT_MS',
    path: ['CONSUMER_STOP_DEADLINE_MS'],
  })
  .refine((env) => env.ENRICHMENT_RUN_LEASE_SECONDS * 1000 > worstProviderAttemptMs(env), {
    message:
      'ENRICHMENT_RUN_LEASE_SECONDS must be greater than the worst-case provider attempt time ' +
      '(ENRICHMENT_PROVIDER_TIMEOUT_MS times ENRICHMENT_PROVIDER_MAX_TRIES, plus the retry backoff)',
    path: ['ENRICHMENT_RUN_LEASE_SECONDS'],
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
    if (env.GOOGLE_CLIENT_ID !== undefined) {
      if (env.GOOGLE_CLIENT_SECRET === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['GOOGLE_CLIENT_SECRET'],
          message: 'GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set',
        })
      }
      if (env.MAIL_OAUTH_REDIRECT_URI === undefined && env.ENVIRONMENT !== 'local') {
        context.addIssue({
          code: 'custom',
          path: ['MAIL_OAUTH_REDIRECT_URI'],
          message: 'MAIL_OAUTH_REDIRECT_URI is required when GOOGLE_CLIENT_ID is set',
        })
      }
    }
    if (env.MICROSOFT_CLIENT_ID !== undefined) {
      if (env.MICROSOFT_CLIENT_SECRET === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['MICROSOFT_CLIENT_SECRET'],
          message: 'MICROSOFT_CLIENT_SECRET is required when MICROSOFT_CLIENT_ID is set',
        })
      }
      if (env.MAIL_OAUTH_REDIRECT_URI === undefined && env.ENVIRONMENT !== 'local') {
        context.addIssue({
          code: 'custom',
          path: ['MAIL_OAUTH_REDIRECT_URI'],
          message: 'MAIL_OAUTH_REDIRECT_URI is required when MICROSOFT_CLIENT_ID is set',
        })
      }
    }
    if (env.ENVIRONMENT === 'staging' || env.ENVIRONMENT === 'prod') {
      if (env.MAIL_SECRET_BOX_KEY !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['MAIL_SECRET_BOX_KEY'],
          message: 'MAIL_SECRET_BOX_KEY is accepted only when ENVIRONMENT is local or dev',
        })
      }
    }
    if (env.ENVIRONMENT !== 'local') {
      for (const key of MAIL_ENDPOINT_KEYS) {
        const value = env[key]
        if (value !== undefined && !value.startsWith('https://')) {
          context.addIssue({ code: 'custom', path: [key], message: `${key} must be https` })
        }
      }
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
    MAIL_STATE_SECRET: env.MAIL_STATE_SECRET ?? LOCAL_MAIL_STATE_SECRET,
    MAIL_OAUTH_REDIRECT_URI: env.MAIL_OAUTH_REDIRECT_URI ?? LOCAL_MAIL_REDIRECT_URI,
    MAIL_UNSUBSCRIBE_URL: env.MAIL_UNSUBSCRIBE_URL ?? LOCAL_MAIL_UNSUBSCRIBE_URL,
  }))

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}
