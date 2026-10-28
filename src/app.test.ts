import { expect, test } from 'bun:test'
import { createApp } from './app'
import { SERVICE } from './info'
import { buildOpenApiDocument } from './openapi'
import { createTestDeps } from './testing'

type ServedDocument = {
  openapi: string
  info: { title: string }
  paths: Record<string, { get?: { responses: Record<string, unknown> } }>
}

test('the app serves its OpenAPI document describing every route and the error body', async () => {
  const app = createApp(createTestDeps())

  const response = await app.request('/openapi.json')

  expect(response.status).toBe(200)
  const document = (await response.json()) as ServedDocument
  expect(document.openapi).toBe('3.1.0')
  expect(document.info.title).toBe(SERVICE)
  expect(Object.keys(document.paths).sort()).toEqual([
    '/healthz',
    '/readyz',
    '/v1/brand-voice',
    '/v1/brand-voice/versions',
    '/v1/campaigns',
    '/v1/campaigns/{campaignId}',
    '/v1/campaigns/{campaignId}/archive',
    '/v1/campaigns/{campaignId}/audience-check',
    '/v1/campaigns/{campaignId}/duplicate',
    '/v1/campaigns/{campaignId}/enrollments',
    '/v1/campaigns/{campaignId}/pause',
    '/v1/campaigns/{campaignId}/sequence',
    '/v1/enrichment-run-sets/{runSetId}',
    '/v1/enrichment-runs',
    '/v1/enrichment-runs/{runId}',
    '/v1/enrichment/providers',
    '/v1/enrichment/providers/{provider}',
    '/v1/enrichment/waterfall',
    '/v1/enrollments/{enrollmentId}',
    '/v1/enrollments/{enrollmentId}/activity',
    '/v1/fit-criteria',
    '/v1/fit-criteria/{criterionId}',
    '/v1/fit-scores',
    '/v1/linkedin/accounts',
    '/v1/linkedin/accounts/connection',
    '/v1/linkedin/accounts/{accountId}',
    '/v1/linkedin/accounts/{accountId}/limits',
    '/v1/linkedin/risk-acceptance',
    '/v1/linkedin/risk-acceptances',
    '/v1/linkedin/risk-statement',
    '/v1/linkedin/settings',
    '/v1/mail/capacity',
    '/v1/mailboxes',
    '/v1/mailboxes/connect',
    '/v1/mailboxes/connect/complete',
    '/v1/mailboxes/{mailboxId}',
    '/v1/mailboxes/{mailboxId}/test-send',
    '/v1/prospects/{prospectId}/fit',
    '/v1/prospects/{prospectId}/signals',
    '/v1/public/mail/unsubscribe/{token}',
    '/v1/public/mail/webhooks/gmail',
    '/v1/public/mail/webhooks/graph',
    '/v1/public/signals/webhook/{organizationId}',
    '/v1/signal-settings',
    '/v1/signal-webhook/rotate',
    '/v1/signals/{signalId}',
  ])
  expect(document.paths['/healthz']?.get?.responses['500']).toBeDefined()
  expect(document.paths['/readyz']?.get?.responses['503']).toBeDefined()
  expect(JSON.stringify(document.paths['/healthz']?.get?.responses['500'])).toContain('code')
})

test('the document written by the script is the document the app serves', async () => {
  const app = createApp(createTestDeps())

  const served = await (await app.request('/openapi.json')).json()

  expect(JSON.parse(JSON.stringify(buildOpenApiDocument(app)))).toEqual(served)
})
