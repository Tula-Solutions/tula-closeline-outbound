import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  completeMailboxConnectRequestSchema,
  ERRORS,
  listMailboxesQuerySchema,
  mailboxConnectStartSchema,
  mailboxPageSchema,
  mailboxParamsSchema,
  mailboxSchema,
  startMailboxConnectRequestSchema,
} from 'tula-closeline-contract'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { MailboxDeps } from './deps'
import { contractRoute, failureResponses, type MailboxRouteName, rolesOf } from './openapi'
import * as Mailboxes from './service'

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: MailboxRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const mailboxResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: mailboxSchema } },
})

const keyHeader = requiredIdempotencyKeyHeader(
  'Makes a repeat of the same request change nothing more.'
)

const listRoute = createRoute({
  ...contractRoute('listMailboxes'),
  middleware: requireRoles('listMailboxes'),
  tags: ['mailboxes'],
  summary: 'List the Mailboxes the caller may see',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listMailboxesQuerySchema },
  responses: {
    200: {
      description: 'A page of Mailboxes, oldest connection first.',
      content: { 'application/json': { schema: mailboxPageSchema } },
    },
    ...failureResponses('listMailboxes'),
  },
})

const getRoute = createRoute({
  ...contractRoute('getMailbox'),
  middleware: requireRoles('getMailbox'),
  tags: ['mailboxes'],
  summary: 'Read one Mailbox',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: mailboxParamsSchema },
  responses: { 200: mailboxResponse('The Mailbox.'), ...failureResponses('getMailbox') },
})

const startRoute = createRoute({
  ...contractRoute('startMailboxConnect'),
  middleware: requireRoles('startMailboxConnect'),
  tags: ['mailboxes'],
  summary: 'Start connecting a Mailbox',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: keyHeader,
    body: {
      required: true,
      content: { 'application/json': { schema: startMailboxConnectRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "The provider's consent URL and when this attempt expires.",
      content: { 'application/json': { schema: mailboxConnectStartSchema } },
    },
    ...failureResponses('startMailboxConnect'),
  },
})

const completeRoute = createRoute({
  ...contractRoute('completeMailboxConnect'),
  middleware: requireRoles('completeMailboxConnect'),
  tags: ['mailboxes'],
  summary: 'Complete connecting a Mailbox',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: keyHeader,
    body: {
      required: true,
      content: { 'application/json': { schema: completeMailboxConnectRequestSchema } },
    },
  },
  responses: {
    201: mailboxResponse('The Mailbox was connected.'),
    200: mailboxResponse('The same attempt was already completed; this is its Mailbox.'),
    ...failureResponses('completeMailboxConnect'),
  },
})

const disconnectRoute = createRoute({
  ...contractRoute('disconnectMailbox'),
  middleware: requireRoles('disconnectMailbox'),
  tags: ['mailboxes'],
  summary: 'Disconnect a Mailbox',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: mailboxParamsSchema, headers: keyHeader },
  responses: {
    200: mailboxResponse('The Mailbox after it was disconnected.'),
    ...failureResponses('disconnectMailbox'),
  },
})

/** The Mailbox routes under `/v1`. */
export function createMailboxRouter(deps: MailboxDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(listRoute, async (c) =>
    c.json(await Mailboxes.list(deps, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(getRoute, async (c) =>
    c.json(await Mailboxes.get(deps, callerOf(c), c.req.valid('param').mailboxId), 200)
  )
  router.openapi(startRoute, async (c) =>
    c.json(
      await Mailboxes.startConnect(
        deps,
        callerOf(c),
        c.req.valid('json'),
        c.req.header('idempotency-key') ?? ''
      ),
      201
    )
  )
  router.openapi(completeRoute, async (c) => {
    const { mailbox, created } = await Mailboxes.completeConnect(
      deps,
      callerOf(c),
      c.req.valid('json')
    )
    return created ? c.json(mailbox, 201) : c.json(mailbox, 200)
  })
  router.openapi(disconnectRoute, async (c) =>
    c.json(await Mailboxes.disconnect(deps, callerOf(c), c.req.valid('param').mailboxId), 200)
  )
  return router
}
