import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  briefIdSchema,
  createBriefRequestSchema,
  ERRORS,
  listBriefsQuerySchema,
  listBriefsResponseSchema,
  prospectIdSchema,
  researchBriefSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { signalCallerOf } from '~/modules/signal/router'
import type { ResearchDeps } from './deps'
import { contractRoute, failureResponses, type ResearchRouteName, rolesOf } from './openapi'
import * as Research from './service'

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
export function requireRoles(name: ResearchRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const prospectParams = z.object({ prospectId: prospectIdSchema })
const briefResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: researchBriefSchema } },
})

const createRouteDef = createRoute({
  ...contractRoute('createBrief'),
  middleware: requireRoles('createBrief'),
  tags: ['research'],
  summary: 'Build (or reuse) the Research Brief of a Prospect',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    params: prospectParams,
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
    body: {
      required: false,
      content: { 'application/json': { schema: createBriefRequestSchema } },
    },
  },
  responses: {
    200: briefResponse('The cached Brief, still current for the Prospect.'),
    201: briefResponse('A new Brief.'),
    ...failureResponses('createBrief'),
  },
})

const getRouteDef = createRoute({
  ...contractRoute('getBrief'),
  middleware: requireRoles('getBrief'),
  tags: ['research'],
  summary: 'Read a Research Brief',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: z.object({ briefId: briefIdSchema }) },
  responses: { 200: briefResponse('The Brief.'), ...failureResponses('getBrief') },
})

const listRouteDef = createRoute({
  ...contractRoute('listBriefs'),
  middleware: requireRoles('listBriefs'),
  tags: ['research'],
  summary: "List a Prospect's Research Briefs",
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: prospectParams, query: listBriefsQuerySchema },
  responses: {
    200: {
      description: 'A page of Briefs, newest first.',
      content: { 'application/json': { schema: listBriefsResponseSchema } },
    },
    ...failureResponses('listBriefs'),
  },
})

/** The Research Brief routes under `/v1`. */
export function createResearchRouter(deps: ResearchDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(createRouteDef, async (c) => {
    const idempotencyKey = c.req.valid('header')['idempotency-key'] ?? ''
    const body = c.req.valid('json') ?? { refresh: false }
    const result = await Research.createBrief(
      deps,
      signalCallerOf(c),
      c.req.valid('param').prospectId,
      { ...body, idempotencyKey }
    )
    return c.json(result.brief, result.created ? 201 : 200)
  })
  router.openapi(getRouteDef, async (c) =>
    c.json(await Research.getBrief(deps, signalCallerOf(c), c.req.valid('param').briefId), 200)
  )
  router.openapi(listRouteDef, async (c) =>
    c.json(
      await Research.listBriefs(
        deps,
        signalCallerOf(c),
        c.req.valid('param').prospectId,
        c.req.valid('query')
      ),
      200
    )
  )
  return router
}
