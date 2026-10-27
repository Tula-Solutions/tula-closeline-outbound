import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  campaignParamsSchema,
  campaignSchema,
  createCampaignRequestSchema,
  duplicateCampaignRequestSchema,
  ERRORS,
  listCampaignsQuerySchema,
  listCampaignsResponseSchema,
  sequenceSchema,
  updateCampaignRequestSchema,
} from 'tula-closeline-contract'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { CampaignDeps } from './deps'
import { type CampaignRouteName, contractRoute, failureResponses, rolesOf } from './openapi'
import { setSequenceBodySchema } from './schema'
import * as Campaigns from './service'

/** Refuses a role the contract does not list for the route with `auth.forbidden`, before the body is read. */
function requireRoles(name: CampaignRouteName): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    if (!rolesOf(name).includes(callerOf(c).role)) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    await next()
  }
}

const campaignResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: campaignSchema } },
})

const keyHeader = requiredIdempotencyKeyHeader(
  'Makes a repeat of the same request change nothing more.'
)

const listRoute = createRoute({
  ...contractRoute('listCampaigns'),
  middleware: requireRoles('listCampaigns'),
  tags: ['campaigns'],
  summary: 'List the Campaigns the caller may see',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listCampaignsQuerySchema },
  responses: {
    200: {
      description: 'A page of Campaigns, newest first.',
      content: { 'application/json': { schema: listCampaignsResponseSchema } },
    },
    ...failureResponses('listCampaigns'),
  },
})

const createCampaignRoute = createRoute({
  ...contractRoute('createCampaign'),
  middleware: requireRoles('createCampaign'),
  tags: ['campaigns'],
  summary: 'Create a draft Campaign',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: keyHeader,
    body: {
      required: true,
      content: { 'application/json': { schema: createCampaignRequestSchema } },
    },
  },
  responses: {
    201: campaignResponse('The Campaign was created.'),
    200: campaignResponse('The same request was already accepted; this is its Campaign.'),
    ...failureResponses('createCampaign'),
  },
})

const getRoute = createRoute({
  ...contractRoute('getCampaign'),
  middleware: requireRoles('getCampaign'),
  tags: ['campaigns'],
  summary: 'Read one Campaign',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: campaignParamsSchema },
  responses: { 200: campaignResponse('The Campaign.'), ...failureResponses('getCampaign') },
})

const updateRoute = createRoute({
  ...contractRoute('updateCampaign'),
  middleware: requireRoles('updateCampaign'),
  tags: ['campaigns'],
  summary: "Change a Campaign's settings",
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    params: campaignParamsSchema,
    headers: keyHeader,
    body: {
      required: true,
      content: { 'application/json': { schema: updateCampaignRequestSchema } },
    },
  },
  responses: {
    200: campaignResponse('The Campaign after the change.'),
    ...failureResponses('updateCampaign'),
  },
})

const duplicateRoute = createRoute({
  ...contractRoute('duplicateCampaign'),
  middleware: requireRoles('duplicateCampaign'),
  tags: ['campaigns'],
  summary: 'Duplicate a Campaign into a new draft',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    params: campaignParamsSchema,
    headers: keyHeader,
    body: {
      required: true,
      content: { 'application/json': { schema: duplicateCampaignRequestSchema } },
    },
  },
  responses: {
    201: campaignResponse('The copy was created.'),
    200: campaignResponse('The same request was already accepted; this is its copy.'),
    ...failureResponses('duplicateCampaign'),
  },
})

const archiveRoute = createRoute({
  ...contractRoute('archiveCampaign'),
  middleware: requireRoles('archiveCampaign'),
  tags: ['campaigns'],
  summary: 'Archive a Campaign',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: campaignParamsSchema, headers: keyHeader },
  responses: {
    200: campaignResponse('The archived Campaign.'),
    ...failureResponses('archiveCampaign'),
  },
})

const pauseRoute = createRoute({
  ...contractRoute('pauseCampaign'),
  middleware: requireRoles('pauseCampaign'),
  tags: ['campaigns'],
  summary: 'Pause a running Campaign',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: campaignParamsSchema, headers: keyHeader },
  responses: {
    200: campaignResponse('The paused Campaign.'),
    ...failureResponses('pauseCampaign'),
  },
})

const getSequenceRoute = createRoute({
  ...contractRoute('getSequence'),
  middleware: requireRoles('getSequence'),
  tags: ['campaigns'],
  summary: "Read a Campaign's current Sequence",
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: campaignParamsSchema },
  responses: {
    200: {
      description: 'The current Sequence; version 0 is empty.',
      content: { 'application/json': { schema: sequenceSchema } },
    },
    ...failureResponses('getSequence'),
  },
})

const setSequenceRoute = createRoute({
  ...contractRoute('setSequence'),
  middleware: requireRoles('setSequence'),
  tags: ['campaigns'],
  summary: 'Save the Steps as a new Sequence version',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    params: campaignParamsSchema,
    headers: keyHeader,
    body: {
      required: true,
      content: { 'application/json': { schema: setSequenceBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'The saved Sequence version (the current one again for a repeat).',
      content: { 'application/json': { schema: sequenceSchema } },
    },
    ...failureResponses('setSequence'),
  },
})

/** The Campaign routes under `/v1`. */
export function createCampaignRouter(deps: CampaignDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  const idempotencyKey = (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('idempotency-key') ?? ''
  router.openapi(listRoute, async (c) =>
    c.json(await Campaigns.list(deps, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(createCampaignRoute, async (c) => {
    c.req.valid('header')
    const { campaign, created } = await Campaigns.create(
      deps,
      callerOf(c),
      c.req.valid('json'),
      idempotencyKey(c)
    )
    return c.json(campaign, created ? 201 : 200)
  })
  router.openapi(getRoute, async (c) =>
    c.json(await Campaigns.get(deps, callerOf(c), c.req.valid('param').campaignId), 200)
  )
  router.openapi(updateRoute, async (c) => {
    c.req.valid('header')
    return c.json(
      await Campaigns.update(
        deps,
        callerOf(c),
        c.req.valid('param').campaignId,
        c.req.valid('json')
      ),
      200
    )
  })
  router.openapi(duplicateRoute, async (c) => {
    c.req.valid('header')
    const { campaign, created } = await Campaigns.duplicate(
      deps,
      callerOf(c),
      c.req.valid('param').campaignId,
      c.req.valid('json').name,
      idempotencyKey(c)
    )
    return c.json(campaign, created ? 201 : 200)
  })
  router.openapi(archiveRoute, async (c) => {
    c.req.valid('header')
    return c.json(await Campaigns.archive(deps, callerOf(c), c.req.valid('param').campaignId), 200)
  })
  router.openapi(pauseRoute, async (c) => {
    c.req.valid('header')
    return c.json(await Campaigns.pause(deps, callerOf(c), c.req.valid('param').campaignId), 200)
  })
  router.openapi(getSequenceRoute, async (c) =>
    c.json(await Campaigns.getSequence(deps, callerOf(c), c.req.valid('param').campaignId), 200)
  )
  router.openapi(setSequenceRoute, async (c) => {
    c.req.valid('header')
    return c.json(
      await Campaigns.setSequence(
        deps,
        callerOf(c),
        c.req.valid('param').campaignId,
        c.req.valid('json')
      ),
      200
    )
  })
  return router
}
