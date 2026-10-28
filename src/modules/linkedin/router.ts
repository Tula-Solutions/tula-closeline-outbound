import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  ERRORS,
  linkedinAccountIdSchema,
  linkedinAccountPageSchema,
  linkedinAccountSchema,
  listLinkedinAccountsQuerySchema,
  startLinkedinConnectionRequestSchema,
  startLinkedinConnectionResponseSchema,
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
  return router
}
