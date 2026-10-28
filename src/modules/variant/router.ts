import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  ERRORS,
  promoteVariantResponseSchema,
  stepVariantResultsSchema,
  stepVariantsParamsSchema,
  variantParamsSchema,
} from 'tula-closeline-contract'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { CampaignDeps } from '~/modules/campaign/deps'
import {
  type CampaignRouteName,
  contractRoute,
  failureResponses,
  rolesOf,
} from '~/modules/campaign/openapi'
import * as Variants from './service'

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: CampaignRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const resultsRoute = createRoute({
  ...contractRoute('getVariantResults'),
  middleware: requireRoles('getVariantResults'),
  tags: ['campaigns'],
  summary: 'Read the results of the variants of an email Step',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: stepVariantsParamsSchema },
  responses: {
    200: {
      description: 'Per-variant counts and reply rates, or not_enough_data below the sample.',
      content: { 'application/json': { schema: stepVariantResultsSchema } },
    },
    ...failureResponses('getVariantResults'),
  },
})

const promoteRoute = createRoute({
  ...contractRoute('promoteVariant'),
  middleware: requireRoles('promoteVariant'),
  tags: ['campaigns'],
  summary: 'Promote a variant to the winner of its Step',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    params: variantParamsSchema,
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
  },
  responses: {
    200: {
      description: 'The winner of the Step, new or already chosen.',
      content: { 'application/json': { schema: promoteVariantResponseSchema } },
    },
    ...failureResponses('promoteVariant'),
  },
})

/** The variant routes under `/v1`. */
export function createVariantRouter(deps: CampaignDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(resultsRoute, async (c) => {
    const { campaignId, stepKey } = c.req.valid('param')
    return c.json(await Variants.results(deps, callerOf(c), campaignId, stepKey), 200)
  })
  router.openapi(promoteRoute, async (c) => {
    c.req.valid('header')
    const { campaignId, stepKey, variantKey } = c.req.valid('param')
    return c.json(await Variants.promote(deps, callerOf(c), campaignId, stepKey, variantKey), 200)
  })
  return router
}
