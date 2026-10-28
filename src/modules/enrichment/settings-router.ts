import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  ERRORS,
  listProvidersQuerySchema,
  listProvidersResponseSchema,
  providerKeySchema,
  providerSettingsSchema,
  setProviderRequestSchema,
  setWaterfallRequestSchema,
  waterfallSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { EnrichmentDeps } from './deps'
import { contractRoute, type EnrichmentRouteName, failureResponses, rolesOf } from './openapi'
import * as Settings from './settings'

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: EnrichmentRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const idempotency = requiredIdempotencyKeyHeader(
  'Required; the call sets a state, so a repeat changes nothing more.'
)

const listRoute = createRoute({
  ...contractRoute('listEnrichmentProviders'),
  middleware: requireRoles('listEnrichmentProviders'),
  tags: ['enrichment'],
  summary: 'List enrichment providers',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listProvidersQuerySchema },
  responses: {
    200: {
      description: 'A page of providers; no key is ever returned.',
      content: { 'application/json': { schema: listProvidersResponseSchema } },
    },
    ...failureResponses('listEnrichmentProviders'),
  },
})

const setProviderRoute = createRoute({
  ...contractRoute('setEnrichmentProvider'),
  middleware: requireRoles('setEnrichmentProvider'),
  tags: ['enrichment'],
  summary: 'Switch a provider on or off and store its key',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: idempotency,
    params: z.object({ provider: providerKeySchema }),
    body: {
      required: true,
      content: { 'application/json': { schema: setProviderRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "The provider's settings, which hold no key.",
      content: { 'application/json': { schema: providerSettingsSchema } },
    },
    ...failureResponses('setEnrichmentProvider'),
  },
})

const getWaterfallRoute = createRoute({
  ...contractRoute('getEnrichmentWaterfall'),
  middleware: requireRoles('getEnrichmentWaterfall'),
  tags: ['enrichment'],
  summary: 'Read the provider order',
  security: [{ [PUBLIC_SECURITY]: [] }],
  responses: {
    200: {
      description: 'The order per field group and its version.',
      content: { 'application/json': { schema: waterfallSchema } },
    },
    ...failureResponses('getEnrichmentWaterfall'),
  },
})

const setWaterfallRoute = createRoute({
  ...contractRoute('setEnrichmentWaterfall'),
  middleware: requireRoles('setEnrichmentWaterfall'),
  tags: ['enrichment'],
  summary: 'Save the provider order',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: idempotency,
    body: {
      required: true,
      content: { 'application/json': { schema: setWaterfallRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The saved order and its new version.',
      content: { 'application/json': { schema: waterfallSchema } },
    },
    ...failureResponses('setEnrichmentWaterfall'),
  },
})

/** The provider settings and waterfall routes under `/v1/enrichment`. */
export function createSettingsRouter(deps: EnrichmentDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(listRoute, async (c) =>
    c.json(await Settings.listProviders(deps, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(setProviderRoute, async (c) => {
    c.req.valid('header')
    return c.json(
      await Settings.setProvider(
        deps,
        callerOf(c),
        c.req.valid('param').provider,
        c.req.valid('json')
      ),
      200
    )
  })
  router.openapi(getWaterfallRoute, async (c) =>
    c.json(await Settings.getWaterfall(deps, callerOf(c)), 200)
  )
  router.openapi(setWaterfallRoute, async (c) => {
    c.req.valid('header')
    return c.json(await Settings.setWaterfall(deps, callerOf(c), c.req.valid('json')), 200)
  })
  return router
}
