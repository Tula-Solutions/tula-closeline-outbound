import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  acceptPlayRequestSchema,
  createPlayRequestSchema,
  ERRORS,
  editPlayRequestSchema,
  listPlaysQuerySchema,
  listPlaysResponseSchema,
  playParamsSchema,
  playSchema,
  proposePlaysRequestSchema,
  proposePlaysResponseSchema,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { PlayDeps } from './deps'
import { contractRoute, failureResponses, type PlayRouteName, rolesOf } from './openapi'
import * as Plays from './service'

/** The header a proposal carries when no Play in it has evidence (the contract's body has no field for it). */
export const EVIDENCE_NOTE_HEADER = 'x-evidence-note'

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: PlayRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const keyHeader = requiredIdempotencyKeyHeader(
  'Makes a repeat of the same request change nothing more.'
)
const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
})
const play = (description: string) => json(description, playSchema)
const base = { tags: ['plays'], security: [{ [PUBLIC_SECURITY]: [] }] }

const listRoute = createRoute({
  ...contractRoute('listPlays'),
  middleware: requireRoles('listPlays'),
  ...base,
  summary: 'List Plays',
  request: { query: listPlaysQuerySchema },
  responses: {
    200: json('A page of Plays.', listPlaysResponseSchema),
    ...failureResponses('listPlays'),
  },
})
const getRoute = createRoute({
  ...contractRoute('getPlay'),
  middleware: requireRoles('getPlay'),
  ...base,
  summary: 'Read a Play',
  request: { params: playParamsSchema },
  responses: { 200: play('The Play.'), ...failureResponses('getPlay') },
})
const createPlayRoute = createRoute({
  ...contractRoute('createPlay'),
  middleware: requireRoles('createPlay'),
  ...base,
  summary: 'Write a custom Play',
  request: {
    headers: keyHeader,
    body: { required: true, content: { 'application/json': { schema: createPlayRequestSchema } } },
  },
  responses: {
    200: play('The Play this Idempotency-Key already wrote.'),
    201: play('A new Play.'),
    ...failureResponses('createPlay'),
  },
})
const editRoute = createRoute({
  ...contractRoute('editPlay'),
  middleware: requireRoles('editPlay'),
  ...base,
  summary: 'Edit a Play',
  request: {
    params: playParamsSchema,
    headers: keyHeader,
    body: { required: true, content: { 'application/json': { schema: editPlayRequestSchema } } },
  },
  responses: { 200: play('The Play.'), ...failureResponses('editPlay') },
})
const proposeRoute = createRoute({
  ...contractRoute('proposePlays'),
  middleware: requireRoles('proposePlays'),
  ...base,
  summary: "Propose Plays from the Organization's won Deals",
  request: {
    headers: keyHeader,
    body: {
      required: true,
      content: { 'application/json': { schema: proposePlaysRequestSchema } },
    },
  },
  responses: {
    200: json(
      `Proposed Plays. When none has evidence the ${EVIDENCE_NOTE_HEADER} header says so.`,
      proposePlaysResponseSchema
    ),
    ...failureResponses('proposePlays'),
  },
})
const acceptRoute = createRoute({
  ...contractRoute('acceptPlay'),
  middleware: requireRoles('acceptPlay'),
  ...base,
  summary: 'Accept a proposed Play',
  request: {
    params: playParamsSchema,
    headers: keyHeader,
    body: { required: false, content: { 'application/json': { schema: acceptPlayRequestSchema } } },
  },
  responses: { 200: play('The accepted Play.'), ...failureResponses('acceptPlay') },
})
const discardRoute = createRoute({
  ...contractRoute('discardPlay'),
  middleware: requireRoles('discardPlay'),
  ...base,
  summary: 'Discard a Play',
  request: { params: playParamsSchema, headers: keyHeader },
  responses: { 200: play('The discarded Play.'), ...failureResponses('discardPlay') },
})

/** The Play routes under `/v1`. */
export function createPlayRouter(deps: PlayDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(listRoute, async (c) =>
    c.json(await Plays.list(deps, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(getRoute, async (c) =>
    c.json(await Plays.get(deps, callerOf(c), c.req.valid('param').playId), 200)
  )
  router.openapi(createPlayRoute, async (c) => {
    const result = await Plays.create(
      deps,
      callerOf(c),
      c.req.valid('json'),
      c.req.valid('header')['idempotency-key'] ?? ''
    )
    return c.json(result.play, result.created ? 201 : 200)
  })
  router.openapi(editRoute, async (c) =>
    c.json(
      await Plays.edit(deps, callerOf(c), c.req.valid('param').playId, c.req.valid('json')),
      200
    )
  )
  router.openapi(proposeRoute, async (c) => {
    const proposal = await Plays.propose(
      deps,
      callerOf(c),
      c.req.valid('json'),
      c.req.valid('header')['idempotency-key'] ?? ''
    )
    if (proposal.note !== null) {
      c.header(EVIDENCE_NOTE_HEADER, proposal.note)
    }
    return c.json({ plays: proposal.plays }, 200)
  })
  router.openapi(acceptRoute, async (c) =>
    c.json(
      await Plays.accept(
        deps,
        callerOf(c),
        c.req.valid('param').playId,
        c.req.valid('json')?.acknowledgeNoEvidence ?? false
      ),
      200
    )
  )
  router.openapi(discardRoute, async (c) =>
    c.json(await Plays.discard(deps, callerOf(c), c.req.valid('param').playId), 200)
  )
  return router
}
