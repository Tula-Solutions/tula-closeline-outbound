import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  createDraftRequestSchema,
  draftIdSchema,
  outreachDraftSchema,
  regenerateDraftRequestSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { AuthedEnv } from '~/http/auth'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses } from '~/modules/research/openapi'
import { requireRoles } from '~/modules/research/router'
import { signalCallerOf } from '~/modules/signal/router'
import type { DraftDeps } from './deps'
import * as Drafts from './service'

const draftParams = z.object({ draftId: draftIdSchema })
const keyHeader = requiredIdempotencyKeyHeader(
  'Makes a repeat of the same request change nothing more.'
)
const draftResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: outreachDraftSchema } },
})

const createRouteDef = createRoute({
  ...contractRoute('createDraft'),
  middleware: requireRoles('createDraft'),
  tags: ['drafts'],
  summary: 'Write a grounded Draft for a Prospect',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    headers: keyHeader,
    body: { required: true, content: { 'application/json': { schema: createDraftRequestSchema } } },
  },
  responses: {
    200: draftResponse('The Draft this Idempotency-Key already wrote.'),
    201: draftResponse('A new Draft.'),
    ...failureResponses('createDraft'),
  },
})

const getRouteDef = createRoute({
  ...contractRoute('getOutreachDraft'),
  middleware: requireRoles('getOutreachDraft'),
  tags: ['drafts'],
  summary: 'Read a Draft',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: draftParams },
  responses: { 200: draftResponse('The Draft.'), ...failureResponses('getOutreachDraft') },
})

const regenerateRouteDef = createRoute({
  ...contractRoute('regenerateDraft'),
  middleware: requireRoles('regenerateDraft'),
  tags: ['drafts'],
  summary: 'Write a Draft again with a new angle or tone',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    params: draftParams,
    headers: keyHeader,
    body: {
      required: false,
      content: { 'application/json': { schema: regenerateDraftRequestSchema } },
    },
  },
  responses: {
    200: draftResponse('The Draft, one revision on.'),
    ...failureResponses('regenerateDraft'),
  },
})

/** The Draft routes under `/v1`. */
export function createDraftRouter(deps: DraftDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(createRouteDef, async (c) => {
    const result = await Drafts.createDraft(
      deps,
      signalCallerOf(c),
      c.req.valid('json'),
      c.req.valid('header')['idempotency-key'] ?? ''
    )
    return c.json(result.draft, result.created ? 201 : 200)
  })
  router.openapi(getRouteDef, async (c) =>
    c.json(await Drafts.getDraft(deps, signalCallerOf(c), c.req.valid('param').draftId), 200)
  )
  router.openapi(regenerateRouteDef, async (c) =>
    c.json(
      await Drafts.regenerateDraft(
        deps,
        signalCallerOf(c),
        c.req.valid('param').draftId,
        c.req.valid('json') ?? {},
        c.req.valid('header')['idempotency-key'] ?? ''
      ),
      200
    )
  )
  return router
}
