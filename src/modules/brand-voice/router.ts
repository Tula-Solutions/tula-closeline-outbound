import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  brandVoiceSchema,
  ERRORS,
  listBrandVoiceVersionsQuerySchema,
  listBrandVoiceVersionsResponseSchema,
} from 'tula-closeline-contract'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { BrandVoiceDeps } from './deps'
import { contractRoute, failureResponses, rolesOf, type VoiceRouteName } from './openapi'
import { setVoiceBodySchema } from './schema'
import * as BrandVoices from './service'

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: VoiceRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const voiceResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: brandVoiceSchema } },
})

const getRoute = createRoute({
  ...contractRoute('getBrandVoice'),
  middleware: requireRoles('getBrandVoice'),
  tags: ['brand-voice'],
  summary: "Read the Organization's current Brand Voice",
  security: [{ [PUBLIC_SECURITY]: [] }],
  responses: {
    200: voiceResponse('The current Brand Voice.'),
    ...failureResponses('getBrandVoice'),
  },
})

const setRoute = createRoute({
  ...contractRoute('setBrandVoice'),
  middleware: requireRoles('setBrandVoice'),
  tags: ['brand-voice'],
  summary: 'Save the Brand Voice as a new version',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
    body: { required: true, content: { 'application/json': { schema: setVoiceBodySchema } } },
  },
  responses: {
    200: voiceResponse('The saved version (the current one again for a repeat).'),
    ...failureResponses('setBrandVoice'),
  },
})

const listRoute = createRoute({
  ...contractRoute('listBrandVoiceVersions'),
  middleware: requireRoles('listBrandVoiceVersions'),
  tags: ['brand-voice'],
  summary: 'List the saved Brand Voice versions',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listBrandVoiceVersionsQuerySchema },
  responses: {
    200: {
      description: 'A page of versions, newest first.',
      content: { 'application/json': { schema: listBrandVoiceVersionsResponseSchema } },
    },
    ...failureResponses('listBrandVoiceVersions'),
  },
})

/** The Brand Voice routes under `/v1`. */
export function createBrandVoiceRouter(deps: BrandVoiceDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(getRoute, async (c) => c.json(await BrandVoices.get(deps, callerOf(c)), 200))
  router.openapi(setRoute, async (c) => {
    c.req.valid('header')
    return c.json(await BrandVoices.set(deps, callerOf(c), c.req.valid('json')), 200)
  })
  router.openapi(listRoute, async (c) =>
    c.json(await BrandVoices.listVersions(deps, callerOf(c), c.req.valid('query')), 200)
  )
  return router
}
