import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  campaignParamsSchema,
  MAX_PREVIEW_PROSPECTS,
  previewRequestSchema,
  previewResultSchema,
  prospectIdSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { AuthedEnv } from '~/http/auth'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses } from '~/modules/research/openapi'
import { requireRoles } from '~/modules/research/router'
import { signalCallerOf } from '~/modules/signal/router'
import * as Previews from './service'

// The contract schema refuses a sixth Prospect as request.invalid; the service owns that answer
// (preview.too_many_prospects), so the edge only bounds the list.
const bodySchema = previewRequestSchema.extend({
  prospectIds: z
    .array(prospectIdSchema)
    .min(1)
    .max(MAX_PREVIEW_PROSPECTS * 10)
    .refine((ids) => new Set(ids).size === ids.length, 'Each Prospect once'),
})

const route = createRoute({
  ...contractRoute('previewCampaign'),
  middleware: requireRoles('previewCampaign'),
  tags: ['previews'],
  summary: 'Preview a Campaign Step on sample Prospects',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    params: campaignParamsSchema,
    headers: requiredIdempotencyKeyHeader('Names this preview; nothing is stored under it.'),
    body: { required: true, content: { 'application/json': { schema: bodySchema } } },
  },
  responses: {
    200: {
      description: 'A Brief and Draft for each Prospect, or the failure code that stopped it.',
      content: { 'application/json': { schema: previewResultSchema } },
    },
    ...failureResponses('previewCampaign'),
  },
})

/** The preview route under `/v1`. */
export function createPreviewRouter(deps: Previews.PreviewDeps): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(route, async (c) =>
    c.json(
      await Previews.previewCampaign(
        deps,
        signalCallerOf(c),
        c.req.valid('param').campaignId,
        c.req.valid('json'),
        c.req.valid('header')['idempotency-key'] ?? ''
      ),
      200
    )
  )
  return router
}
