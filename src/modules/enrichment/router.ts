import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  createEnrichmentRequestSchema,
  ERRORS,
  enrichmentRunIdSchema,
  enrichmentRunSchema,
  enrichmentRunSetIdSchema,
  enrichmentRunSetSchema,
  listEnrichmentRunsQuerySchema,
  listEnrichmentRunsResponseSchema,
  type RequestId,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { EnrichmentDeps } from './deps'
import { contractRoute, type EnrichmentRouteName, failureResponses, rolesOf } from './openapi'
import * as Enrichment from './service'

/** The caller of a request, with their own bearer token for core's view rules, and the request id. */
function contextOf(c: Context<AuthedEnv>): Enrichment.EnrichCaller {
  const header = c.req.header('authorization') ?? ''
  return {
    ...callerOf(c),
    bearer: header.replace(/^Bearer\s+/i, ''),
    requestId: c.get('requestId') as RequestId,
  }
}

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: EnrichmentRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const createRunSet = createRoute({
  ...contractRoute('createEnrichment'),
  middleware: requireRoles('createEnrichment'),
  tags: ['enrichment'],
  summary: 'Enrich one Prospect or a bounded set',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: requiredIdempotencyKeyHeader('Makes a repeat of the same request charge once.'),
    body: {
      required: true,
      content: { 'application/json': { schema: createEnrichmentRequestSchema } },
    },
  },
  responses: {
    202: {
      description: 'The runs were queued; poll the run set.',
      content: { 'application/json': { schema: enrichmentRunSetSchema } },
    },
    200: {
      description: 'The same request was already accepted; this is its run set.',
      content: { 'application/json': { schema: enrichmentRunSetSchema } },
    },
    ...failureResponses('createEnrichment'),
  },
})

const getRunSetRoute = createRoute({
  ...contractRoute('getEnrichmentRunSet'),
  middleware: requireRoles('getEnrichmentRunSet'),
  tags: ['enrichment'],
  summary: 'Read the progress of a run set',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: z.object({ runSetId: enrichmentRunSetIdSchema }) },
  responses: {
    200: {
      description: 'The run set with its counts.',
      content: { 'application/json': { schema: enrichmentRunSetSchema } },
    },
    ...failureResponses('getEnrichmentRunSet'),
  },
})

const getRunRoute = createRoute({
  ...contractRoute('getEnrichmentRun'),
  middleware: requireRoles('getEnrichmentRun'),
  tags: ['enrichment'],
  summary: 'Read one enrichment run with its attempts',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: z.object({ runId: enrichmentRunIdSchema }) },
  responses: {
    200: {
      description: 'The run, its attempts, fields and cost.',
      content: { 'application/json': { schema: enrichmentRunSchema } },
    },
    ...failureResponses('getEnrichmentRun'),
  },
})

const listRunsRoute = createRoute({
  ...contractRoute('listEnrichmentRuns'),
  middleware: requireRoles('listEnrichmentRuns'),
  tags: ['enrichment'],
  summary: 'List enrichment runs',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listEnrichmentRunsQuerySchema },
  responses: {
    200: {
      description: 'A page of runs, newest first.',
      content: { 'application/json': { schema: listEnrichmentRunsResponseSchema } },
    },
    ...failureResponses('listEnrichmentRuns'),
  },
})

/** The enrichment routes under `/v1`. */
export function createEnrichmentRouter(deps: EnrichmentDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(createRunSet, async (c) => {
    c.req.valid('header')
    const key = c.req.header('idempotency-key') ?? ''
    const { runSet, replay } = await Enrichment.create(deps, contextOf(c), c.req.valid('json'), key)
    return c.json(runSet, replay ? 200 : 202)
  })
  router.openapi(getRunSetRoute, async (c) =>
    c.json(await Enrichment.getRunSet(deps, contextOf(c), c.req.valid('param').runSetId), 200)
  )
  router.openapi(getRunRoute, async (c) =>
    c.json(await Enrichment.getRun(deps, contextOf(c), c.req.valid('param').runId), 200)
  )
  router.openapi(listRunsRoute, async (c) => {
    const query = c.req.valid('query')
    return c.json(await Enrichment.list(deps, contextOf(c), query), 200)
  })
  return router
}
