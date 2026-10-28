import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  audienceCheckSchema,
  CAMPAIGN_ERRORS,
  campaignEnrollmentsParamsSchema,
  campaignParamsSchema,
  campaignSchema,
  createCampaignRequestSchema,
  duplicateCampaignRequestSchema,
  ERRORS,
  enrollmentParamsSchema,
  enrollmentSchema,
  enrollProspectsRequestSchema,
  enrollProspectsResponseSchema,
  listCampaignsQuerySchema,
  listCampaignsResponseSchema,
  listEnrollmentActivityResponseSchema,
  listEnrollmentsQuerySchema,
  listEnrollmentsResponseSchema,
  pageQuerySchema,
  removeEnrollmentRequestSchema,
  sequenceSchema,
  updateCampaignRequestSchema,
} from 'tula-closeline-contract'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Audience from './audience'
import type { CampaignDeps } from './deps'
import * as Enrollments from './enrollment'
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

const checkResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: audienceCheckSchema } },
})

const startAudienceCheckRoute = createRoute({
  ...contractRoute('startAudienceCheck'),
  middleware: requireRoles('startAudienceCheck'),
  tags: ['campaigns'],
  summary: 'Start an audience check',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { headers: keyHeader, params: campaignParamsSchema },
  responses: {
    202: checkResponse('The check is pending, or the one already running for this audience.'),
    ...failureResponses('startAudienceCheck'),
  },
})

const getAudienceCheckRoute = createRoute({
  ...contractRoute('getAudienceCheck'),
  middleware: requireRoles('getAudienceCheck'),
  tags: ['campaigns'],
  summary: 'Read the latest audience check',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: campaignParamsSchema },
  responses: {
    200: checkResponse('The latest audience check.'),
    ...failureResponses('getAudienceCheck'),
  },
})

const enrollProspectsRoute = createRoute({
  ...contractRoute('enrollProspects'),
  middleware: requireRoles('enrollProspects'),
  tags: ['campaigns'],
  summary: 'Enroll Prospects into a Campaign',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: keyHeader,
    params: campaignEnrollmentsParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: enrollProspectsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'One result per Prospect, in the order asked.',
      content: { 'application/json': { schema: enrollProspectsResponseSchema } },
    },
    ...failureResponses('enrollProspects'),
  },
})

const listEnrollmentsRoute = createRoute({
  ...contractRoute('listEnrollments'),
  middleware: requireRoles('listEnrollments'),
  tags: ['campaigns'],
  summary: 'List the Enrollments of a Campaign',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: campaignEnrollmentsParamsSchema, query: listEnrollmentsQuerySchema },
  responses: {
    200: {
      description: 'A page of Enrollments, newest first.',
      content: { 'application/json': { schema: listEnrollmentsResponseSchema } },
    },
    ...failureResponses('listEnrollments'),
  },
})

const enrollmentResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: enrollmentSchema } },
})

const getEnrollmentRoute = createRoute({
  ...contractRoute('getEnrollment'),
  middleware: requireRoles('getEnrollment'),
  tags: ['campaigns'],
  summary: 'Read one Enrollment',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: enrollmentParamsSchema },
  responses: {
    200: enrollmentResponse('The Enrollment.'),
    ...failureResponses('getEnrollment'),
  },
})

const listEnrollmentActivityRoute = createRoute({
  ...contractRoute('listEnrollmentActivity'),
  middleware: requireRoles('listEnrollmentActivity'),
  tags: ['campaigns'],
  summary: 'List the log of one Enrollment',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: enrollmentParamsSchema, query: pageQuerySchema },
  responses: {
    200: {
      description: 'A page of log entries, newest first.',
      content: { 'application/json': { schema: listEnrollmentActivityResponseSchema } },
    },
    ...failureResponses('listEnrollmentActivity'),
  },
})

const removeEnrollmentRoute = createRoute({
  ...contractRoute('removeEnrollment'),
  middleware: requireRoles('removeEnrollment'),
  tags: ['campaigns'],
  summary: 'Take an Enrollment out of its Campaign',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: keyHeader,
    params: enrollmentParamsSchema,
    body: {
      required: false,
      content: { 'application/json': { schema: removeEnrollmentRequestSchema } },
    },
  },
  responses: {
    200: enrollmentResponse('The Enrollment, stopped as removed_by_rep.'),
    ...failureResponses('removeEnrollment'),
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
  router.openapi(startAudienceCheckRoute, async (c) => {
    c.req.valid('header')
    const check = await Audience.start(
      deps,
      callerOf(c),
      c.req.valid('param').campaignId,
      idempotencyKey(c),
      c.get('requestId')
    )
    return c.json(check, 202)
  })
  router.openapi(getAudienceCheckRoute, async (c) => {
    const check = await Audience.latest(deps, callerOf(c), c.req.valid('param').campaignId)
    if (check === null) {
      throw domainError(CAMPAIGN_ERRORS['campaign.not_found'])
    }
    return c.json(check, 200)
  })
  router.openapi(enrollProspectsRoute, async (c) => {
    c.req.valid('header')
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    return c.json(
      await Enrollments.enroll(
        deps,
        { ...callerOf(c), bearer },
        c.req.valid('param').campaignId,
        c.req.valid('json').prospectIds
      ),
      200
    )
  })
  router.openapi(listEnrollmentsRoute, async (c) =>
    c.json(
      await Enrollments.list(
        deps,
        callerOf(c),
        c.req.valid('param').campaignId,
        c.req.valid('query')
      ),
      200
    )
  )
  router.openapi(getEnrollmentRoute, async (c) =>
    c.json(await Enrollments.get(deps, callerOf(c), c.req.valid('param').enrollmentId), 200)
  )
  router.openapi(listEnrollmentActivityRoute, async (c) =>
    c.json(
      await Enrollments.activity(
        deps,
        callerOf(c),
        c.req.valid('param').enrollmentId,
        c.req.valid('query')
      ),
      200
    )
  )
  router.openapi(removeEnrollmentRoute, async (c) => {
    c.req.valid('header')
    return c.json(
      await Enrollments.remove(deps, callerOf(c), c.req.valid('param').enrollmentId),
      200
    )
  })
  return router
}
