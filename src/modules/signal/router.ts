import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  ERRORS,
  listSignalsQuerySchema,
  listSignalsResponseSchema,
  prospectIdSchema,
  recordNoteRequestSchema,
  rotateSignalWebhookResponseSchema,
  SIGNAL_WEBHOOK_SIGNATURE_HEADER,
  SIGNAL_WEBHOOK_TIMESTAMP_HEADER,
  setSignalSettingsRequestSchema,
  signalIdSchema,
  signalSchema,
  signalSettingsSchema,
  signalWebhookResponseSchema,
} from 'tula-closeline-contract'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import type { SignalDeps } from './deps'
import { contractRoute, failureResponses, rolesOf, type SignalRouteName } from './openapi'
import * as Signals from './service'

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: SignalRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

/** The caller with their own bearer, which core needs to apply its view rules. */
export function signalCallerOf(c: Context<AuthedEnv>): Signals.SignalCaller {
  const header = c.req.header('authorization') ?? ''
  return { ...callerOf(c), bearer: header.replace(/^Bearer\s+/i, '') }
}

const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
})
const prospectParams = z.object({ prospectId: prospectIdSchema })
const base = { tags: ['signals'], security: [{ [PUBLIC_SECURITY]: [] }] }

const recordRoute = createRoute({
  ...contractRoute('recordSignalNote'),
  middleware: requireRoles('recordSignalNote'),
  ...base,
  summary: 'Record a note about a Prospect as a Signal',
  request: {
    headers: requiredIdempotencyKeyHeader('Makes a repeat of the same note record nothing more.'),
    params: prospectParams,
    body: { required: true, content: { 'application/json': { schema: recordNoteRequestSchema } } },
  },
  responses: {
    201: json('The note was recorded.', signalSchema),
    200: json('The same note was already recorded under this key.', signalSchema),
    ...failureResponses('recordSignalNote'),
  },
})

const listRoute = createRoute({
  ...contractRoute('listProspectSignals'),
  middleware: requireRoles('listProspectSignals'),
  ...base,
  summary: "List a Prospect's Signals, newest first",
  request: { params: prospectParams, query: listSignalsQuerySchema },
  responses: {
    200: json('A page of Signals; expired ones only with fresh=false.', listSignalsResponseSchema),
    ...failureResponses('listProspectSignals'),
  },
})

const getRoute = createRoute({
  ...contractRoute('getSignal'),
  middleware: requireRoles('getSignal'),
  ...base,
  summary: 'Read one Signal',
  request: { params: z.object({ signalId: signalIdSchema }) },
  responses: { 200: json('The Signal.', signalSchema), ...failureResponses('getSignal') },
})

const getSettingsRoute = createRoute({
  ...contractRoute('getSignalSettings'),
  middleware: requireRoles('getSignalSettings'),
  ...base,
  summary: "Read the Organization's Signal settings",
  responses: {
    200: json('The settings.', signalSettingsSchema),
    ...failureResponses('getSignalSettings'),
  },
})

const setSettingsRoute = createRoute({
  ...contractRoute('setSignalSettings'),
  middleware: requireRoles('setSignalSettings'),
  ...base,
  summary: 'Save which Signal kinds are on and how long each stays fresh',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: setSignalSettingsRequestSchema } },
    },
  },
  responses: {
    200: json('The saved settings.', signalSettingsSchema),
    ...failureResponses('setSignalSettings'),
  },
})

const rotateRoute = createRoute({
  ...contractRoute('rotateSignalWebhookSecret'),
  middleware: requireRoles('rotateSignalWebhookSecret'),
  ...base,
  summary: 'Make a new webhook signing secret; it is shown once',
  request: {
    headers: requiredIdempotencyKeyHeader('Required; a retry makes another secret.'),
  },
  responses: {
    200: json('The new secret, shown once.', rotateSignalWebhookResponseSchema),
    ...failureResponses('rotateSignalWebhookSecret'),
  },
})

/** The Signal routes under `/v1` (the webhook is separate, outside token authentication). */
export function createSignalRouter(deps: SignalDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(recordRoute, async (c) => {
    const result = await Signals.recordNote(
      deps,
      signalCallerOf(c),
      c.req.valid('param').prospectId,
      c.req.valid('json'),
      c.req.header('idempotency-key') ?? ''
    )
    return c.json(result.signal, result.replay ? 200 : 201)
  })
  router.openapi(listRoute, async (c) =>
    c.json(
      await Signals.listForProspect(
        deps,
        signalCallerOf(c),
        c.req.valid('param').prospectId,
        c.req.valid('query')
      ),
      200
    )
  )
  router.openapi(getRoute, async (c) =>
    c.json(await Signals.getOne(deps, signalCallerOf(c), c.req.valid('param').signalId), 200)
  )
  router.openapi(getSettingsRoute, async (c) =>
    c.json(await Signals.getSettings(deps, callerOf(c)), 200)
  )
  router.openapi(setSettingsRoute, async (c) =>
    c.json(await Signals.setSettings(deps, callerOf(c), c.req.valid('json')), 200)
  )
  router.openapi(rotateRoute, async (c) => {
    c.req.valid('header')
    return c.json(await Signals.rotateWebhookSecret(deps, callerOf(c)), 200)
  })
  return router
}

const webhookRoute = createRoute({
  ...contractRoute('receiveSignalWebhook'),
  tags: ['signals'],
  security: [],
  summary: "Receive a website visit from the Organization's own site, signed with its secret",
  request: {
    params: z.object({ organizationId: z.string().max(100) }),
    headers: z.object({
      [SIGNAL_WEBHOOK_TIMESTAMP_HEADER]: z.string().max(20).optional(),
      [SIGNAL_WEBHOOK_SIGNATURE_HEADER]: z.string().max(100).optional(),
    }),
  },
  responses: {
    201: json('The visit was recorded.', signalWebhookResponseSchema),
    200: json('The event id was already recorded; nothing changed.', signalWebhookResponseSchema),
    ...failureResponses('receiveSignalWebhook'),
  },
})

/** The signed webhook; it reads the raw body itself because the signature covers its exact bytes. */
export function createSignalWebhookRouter(deps: SignalDeps): OpenAPIHono<AppEnv> {
  const router = createRouter<AppEnv>()
  router.openapi(webhookRoute, async (c) => {
    const result = await Signals.receiveWebhook(deps, {
      organizationId: c.req.valid('param').organizationId,
      rawBody: await c.req.text(),
      timestamp: c.req.header(SIGNAL_WEBHOOK_TIMESTAMP_HEADER),
      signature: c.req.header(SIGNAL_WEBHOOK_SIGNATURE_HEADER),
    })
    const { created, ...body } = result
    return c.json(body, created ? 201 : 200)
  })
  return router
}
