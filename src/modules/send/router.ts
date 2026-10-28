import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import { ERRORS, listMailboxesQuerySchema, mailCapacitySchema } from 'tula-closeline-contract'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses, rolesOf } from '~/modules/mailbox/openapi'
import { capacity } from './capacity'
import type { SendDeps } from './deps'

const requireRoles: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  if (!rolesOf('getMailCapacity').includes(callerOf(c).role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  await next()
}

const capacityRoute = createRoute({
  ...contractRoute('getMailCapacity'),
  middleware: requireRoles,
  tags: ['mailboxes'],
  summary: 'What the Mailboxes can still send',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listMailboxesQuerySchema.pick({ limit: true, cursor: true }) },
  responses: {
    200: {
      description: 'A page of Mailbox capacity with the Organization cap.',
      content: { 'application/json': { schema: mailCapacitySchema } },
    },
    ...failureResponses('getMailCapacity'),
  },
})

/** The send routes: `GET /v1/mail/capacity`. */
export function createSendRouter(deps: SendDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(capacityRoute, async (c) =>
    c.json(await capacity(deps, callerOf(c), c.req.valid('query')), 200)
  )
  return router
}
