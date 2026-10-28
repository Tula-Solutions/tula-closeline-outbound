import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  createFitCriterionRequestSchema,
  ERRORS,
  fitCriterionIdSchema,
  fitCriterionSchema,
  fitScoreSchema,
  listFitCriteriaQuerySchema,
  listFitCriteriaResponseSchema,
  listFitScoresQuerySchema,
  listFitScoresResponseSchema,
  prospectIdSchema,
  updateFitCriterionRequestSchema,
} from 'tula-closeline-contract'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import {
  contractRoute,
  failureResponses,
  rolesOf,
  type SignalRouteName,
} from '~/modules/signal/openapi'
import { signalCallerOf } from '~/modules/signal/router'
import type { FitDeps } from './deps'
import * as Fit from './service'

function requireRoles(name: SignalRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
})
const base = { tags: ['fit'], security: [{ [PUBLIC_SECURITY]: [] }] }
const criterionParams = z.object({ criterionId: fitCriterionIdSchema })

const listRoute = createRoute({
  ...contractRoute('listFitCriteria'),
  middleware: requireRoles('listFitCriteria'),
  ...base,
  summary: 'List the fit criteria, oldest first',
  request: { query: listFitCriteriaQuerySchema },
  responses: {
    200: json('A page of criteria with the version of the set.', listFitCriteriaResponseSchema),
    ...failureResponses('listFitCriteria'),
  },
})

const createRouteDef = createRoute({
  ...contractRoute('createFitCriterion'),
  middleware: requireRoles('createFitCriterion'),
  ...base,
  summary: 'Add a fit criterion',
  request: {
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
    body: {
      required: true,
      content: { 'application/json': { schema: createFitCriterionRequestSchema } },
    },
  },
  responses: {
    201: json('The criterion was added.', fitCriterionSchema),
    200: json('The same criterion already existed.', fitCriterionSchema),
    ...failureResponses('createFitCriterion'),
  },
})

const updateRoute = createRoute({
  ...contractRoute('updateFitCriterion'),
  middleware: requireRoles('updateFitCriterion'),
  ...base,
  summary: 'Change a fit criterion',
  request: {
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
    params: criterionParams,
    body: {
      required: true,
      content: { 'application/json': { schema: updateFitCriterionRequestSchema } },
    },
  },
  responses: {
    200: json('The changed criterion.', fitCriterionSchema),
    ...failureResponses('updateFitCriterion'),
  },
})

const deleteRoute = createRoute({
  ...contractRoute('deleteFitCriterion'),
  middleware: requireRoles('deleteFitCriterion'),
  ...base,
  summary: 'Remove a fit criterion',
  request: {
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
    params: criterionParams,
  },
  responses: {
    200: json('The criterion is gone.', z.strictObject({})),
    ...failureResponses('deleteFitCriterion'),
  },
})

const fitRoute = createRoute({
  ...contractRoute('getProspectFit'),
  middleware: requireRoles('getProspectFit'),
  ...base,
  summary: "Score a Prospect against the Organization's criteria",
  request: { params: z.object({ prospectId: prospectIdSchema }) },
  responses: {
    200: json('The score with each criterion matched, missed or unknown.', fitScoreSchema),
    ...failureResponses('getProspectFit'),
  },
})

const scoresRoute = createRoute({
  ...contractRoute('listFitScores'),
  middleware: requireRoles('listFitScores'),
  ...base,
  summary: 'List stored fit scores, highest first',
  request: { query: listFitScoresQuerySchema },
  responses: {
    200: json('A page of stored scores.', listFitScoresResponseSchema),
    ...failureResponses('listFitScores'),
  },
})

/** The fit routes under `/v1`. */
export function createFitRouter(deps: FitDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(listRoute, async (c) =>
    c.json(await Fit.listCriteria(deps, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(createRouteDef, async (c) => {
    c.req.valid('header')
    const result = await Fit.createCriterion(deps, callerOf(c), c.req.valid('json'))
    return c.json(result.criterion, result.replay ? 200 : 201)
  })
  router.openapi(updateRoute, async (c) => {
    c.req.valid('header')
    return c.json(
      await Fit.updateCriterion(
        deps,
        callerOf(c),
        c.req.valid('param').criterionId,
        c.req.valid('json')
      ),
      200
    )
  })
  router.openapi(deleteRoute, async (c) => {
    c.req.valid('header')
    return c.json(
      await Fit.deleteCriterion(deps, callerOf(c), c.req.valid('param').criterionId),
      200
    )
  })
  router.openapi(fitRoute, async (c) =>
    c.json(await Fit.getProspectFit(deps, signalCallerOf(c), c.req.valid('param').prospectId), 200)
  )
  router.openapi(scoresRoute, async (c) =>
    c.json(await Fit.listScores(deps, signalCallerOf(c), c.req.valid('query')), 200)
  )
  return router
}
