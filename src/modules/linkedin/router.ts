import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  acceptLinkedinRiskRequestSchema,
  ERRORS,
  LINKEDIN_ERRORS,
  LINKEDIN_LIMIT_ISSUE_MESSAGE,
  linkedinAccountIdSchema,
  linkedinAccountPageSchema,
  linkedinAccountSchema,
  linkedinRiskAcceptancePageSchema,
  linkedinRiskAcceptanceSchema,
  linkedinRiskStatementSchema,
  linkedinSettingsSchema,
  listLinkedinAccountsQuerySchema,
  listLinkedinRiskAcceptancesQuerySchema,
  startLinkedinConnectionRequestSchema,
  startLinkedinConnectionResponseSchema,
  updateLinkedinAccountLimitsRequestSchema,
  updateLinkedinSettingsRequestSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { LinkedinDeps } from './deps'
import { contractRoute, failureResponses, type LinkedinRouteName, rolesOf } from './openapi'
import * as Linkedin from './service'

const accountParamsSchema = z.strictObject({ accountId: linkedinAccountIdSchema })

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: LinkedinRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const startRoute = createRoute({
  ...contractRoute('startConnection'),
  middleware: requireRoles('startConnection'),
  tags: ['linkedin'],
  summary: "Start connecting the calling Rep's LinkedIn account",
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
    body: {
      required: false,
      content: { 'application/json': { schema: startLinkedinConnectionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "The provider's hosted login and when it expires.",
      content: { 'application/json': { schema: startLinkedinConnectionResponseSchema } },
    },
    ...failureResponses('startConnection'),
  },
})

const listRoute = createRoute({
  ...contractRoute('listAccounts'),
  middleware: requireRoles('listAccounts'),
  tags: ['linkedin'],
  summary: 'List the LinkedIn accounts the caller may see',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listLinkedinAccountsQuerySchema },
  responses: {
    200: {
      description: 'A page of accounts, newest connection first.',
      content: { 'application/json': { schema: linkedinAccountPageSchema } },
    },
    ...failureResponses('listAccounts'),
  },
})

const getRoute = createRoute({
  ...contractRoute('getAccount'),
  middleware: requireRoles('getAccount'),
  tags: ['linkedin'],
  summary: 'Read one LinkedIn account',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: accountParamsSchema },
  responses: {
    200: {
      description: 'The account.',
      content: { 'application/json': { schema: linkedinAccountSchema } },
    },
    ...failureResponses('getAccount'),
  },
})

const disconnectRoute = createRoute({
  ...contractRoute('disconnectAccount'),
  middleware: requireRoles('disconnectAccount'),
  tags: ['linkedin'],
  summary: 'Disconnect a LinkedIn account',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: accountParamsSchema },
  responses: {
    204: { description: 'The account is disconnected.' },
    ...failureResponses('disconnectAccount'),
  },
})

const statementRoute = createRoute({
  ...contractRoute('getRiskStatement'),
  middleware: requireRoles('getRiskStatement'),
  tags: ['linkedin'],
  summary: 'Read the current LinkedIn risk statement',
  security: [{ [PUBLIC_SECURITY]: [] }],
  responses: {
    200: {
      description: 'The statement and its wording version.',
      content: { 'application/json': { schema: linkedinRiskStatementSchema } },
    },
    ...failureResponses('getRiskStatement'),
  },
})

const acceptRoute = createRoute({
  ...contractRoute('acceptRisk'),
  middleware: requireRoles('acceptRisk'),
  tags: ['linkedin'],
  summary: 'Accept the LinkedIn risk in writing',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
    body: {
      required: true,
      content: { 'application/json': { schema: acceptLinkedinRiskRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'The recorded acceptance.',
      content: { 'application/json': { schema: linkedinRiskAcceptanceSchema } },
    },
    ...failureResponses('acceptRisk'),
  },
})

const revokeRoute = createRoute({
  ...contractRoute('revokeRiskAcceptance'),
  middleware: requireRoles('revokeRiskAcceptance'),
  tags: ['linkedin'],
  summary: 'Revoke the active LinkedIn risk acceptance',
  security: [{ [PUBLIC_SECURITY]: [] }],
  responses: {
    204: { description: 'The acceptance is revoked, or there was none.' },
    ...failureResponses('revokeRiskAcceptance'),
  },
})

const acceptancesRoute = createRoute({
  ...contractRoute('listRiskAcceptances'),
  middleware: requireRoles('listRiskAcceptances'),
  tags: ['linkedin'],
  summary: 'List the risk acceptances of the Organization',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listLinkedinRiskAcceptancesQuerySchema },
  responses: {
    200: {
      description: 'A page of acceptances, newest first.',
      content: { 'application/json': { schema: linkedinRiskAcceptancePageSchema } },
    },
    ...failureResponses('listRiskAcceptances'),
  },
})

const settingsRoute = createRoute({
  ...contractRoute('getSettings'),
  middleware: requireRoles('getSettings'),
  tags: ['linkedin'],
  summary: 'Read the LinkedIn channel settings',
  security: [{ [PUBLIC_SECURITY]: [] }],
  responses: {
    200: {
      description: 'The switch, the wording version and whether the channel is usable.',
      content: { 'application/json': { schema: linkedinSettingsSchema } },
    },
    ...failureResponses('getSettings'),
  },
})

const updateLimitsRoute = createRoute({
  ...contractRoute('updateAccountLimits'),
  middleware: requireRoles('updateAccountLimits'),
  tags: ['linkedin'],
  summary: "Lower or raise one account's send limits, up to the ceiling",
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    params: accountParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateLinkedinAccountLimitsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The account with its new limits.',
      content: { 'application/json': { schema: linkedinAccountSchema } },
    },
    ...failureResponses('updateAccountLimits'),
  },
})

const updateSettingsRoute = createRoute({
  ...contractRoute('updateSettings'),
  middleware: requireRoles('updateSettings'),
  tags: ['linkedin'],
  summary: 'Switch the LinkedIn channel on or off',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: requiredIdempotencyKeyHeader(
      'Makes a repeat of the same request change nothing more.'
    ),
    body: {
      required: true,
      content: { 'application/json': { schema: updateLinkedinSettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The settings after the change.',
      content: { 'application/json': { schema: linkedinSettingsSchema } },
    },
    ...failureResponses('updateSettings'),
  },
})

/** The LinkedIn account routes under `/v1`. */
export function createLinkedinRouter(deps: LinkedinDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(startRoute, async (c) =>
    c.json(
      await Linkedin.startConnection(deps, callerOf(c), c.req.header('idempotency-key') ?? ''),
      200
    )
  )
  router.openapi(listRoute, async (c) =>
    c.json(await Linkedin.list(deps, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(getRoute, async (c) =>
    c.json(await Linkedin.get(deps, callerOf(c), c.req.valid('param').accountId), 200)
  )
  router.openapi(disconnectRoute, async (c) => {
    await Linkedin.disconnect(deps, callerOf(c), c.req.valid('param').accountId)
    return c.body(null, 204)
  })
  router.openapi(statementRoute, (c) => c.json(Linkedin.riskStatement(), 200))
  router.openapi(acceptRoute, async (c) =>
    c.json(await Linkedin.acceptRisk(deps, callerOf(c), c.req.valid('json')), 201)
  )
  router.openapi(revokeRoute, async (c) => {
    await Linkedin.revokeRisk(deps, callerOf(c))
    return c.body(null, 204)
  })
  router.openapi(acceptancesRoute, async (c) =>
    c.json(await Linkedin.listAcceptances(deps, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(settingsRoute, async (c) =>
    c.json(await Linkedin.getSettings(deps, callerOf(c)), 200)
  )
  router.openapi(updateSettingsRoute, async (c) =>
    c.json(await Linkedin.updateSettings(deps, callerOf(c), c.req.valid('json').enabled), 200)
  )
  router.openapi(
    updateLimitsRoute,
    async (c) =>
      c.json(
        await Linkedin.updateLimits(
          deps,
          callerOf(c),
          c.req.valid('param').accountId,
          c.req.valid('json')
        ),
        200
      ),
    (result, c) => {
      if (!result.success) {
        // The contract marks a limit above the ceiling with this message; it has its own code.
        if (result.error.issues.some((issue) => issue.message === LINKEDIN_LIMIT_ISSUE_MESSAGE)) {
          throw domainError(LINKEDIN_ERRORS['linkedin.limit_above_ceiling'])
        }
        return router.defaultHook?.(result, c)
      }
    }
  )
  return router
}
