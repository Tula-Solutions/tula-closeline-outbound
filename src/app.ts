import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { type AuthedEnv, authenticate } from '~/http/auth'
import { createBaseApp } from '~/http/base'
import { createRouter } from '~/http/router'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createBrandVoiceRouter } from '~/modules/brand-voice/router'
import { createCampaignRouter } from '~/modules/campaign/router'
import { createDraftRouter } from '~/modules/draft/router'
import { createEnrichmentRouter } from '~/modules/enrichment/router'
import { createSettingsRouter } from '~/modules/enrichment/settings-router'
import { createFitRouter } from '~/modules/fit/router'
import { createHealthRouter } from '~/modules/health/router'
import { createLinkedinRouter } from '~/modules/linkedin/router'
import { createMailboxRouter } from '~/modules/mailbox/router'
import { createMailEventRouter } from '~/modules/mailevent/router'
import { createResearchRouter } from '~/modules/research/router'
import { createSendRouter } from '~/modules/send/router'
import { createSignalRouter, createSignalWebhookRouter } from '~/modules/signal/router'
import { serveOpenApi } from '~/openapi'

/**
 * Build the HTTP app from a container. Modules are mounted here as they are added. The public
 * routes (`/v1/...` in the contract) sit behind the access-token middleware, which scopes every
 * request to the Organization in the verified token; the health routes sit outside it.
 */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)
  registerSecuritySchemes(app)

  app.route('/', createHealthRouter(container))

  // The webhook is signed, not token-authenticated, so it is mounted before the token middleware.
  app.route('/', createSignalWebhookRouter(container.signals))
  // Provider notifications and the unsubscribe page carry a signed state or token, not a user token.
  app.route('/', createMailEventRouter(container.inboundMail))

  const publicRoutes = createRouter<AuthedEnv>()
  publicRoutes.use('/v1/*', authenticate(container))
  publicRoutes.route('/', createEnrichmentRouter(container.enrichment))
  publicRoutes.route('/', createSettingsRouter(container.enrichment))
  publicRoutes.route('/', createCampaignRouter(container.campaigns))
  publicRoutes.route('/', createBrandVoiceRouter(container.brandVoice))
  publicRoutes.route('/', createMailboxRouter(container.mailboxes))
  publicRoutes.route('/', createSignalRouter(container.signals))
  publicRoutes.route('/', createFitRouter(container.fit))
  publicRoutes.route('/', createSendRouter(container.send))
  publicRoutes.route('/', createLinkedinRouter(container.linkedin))
  publicRoutes.route('/', createResearchRouter(container.research))
  publicRoutes.route('/', createDraftRouter(container.drafts))
  app.route('/', publicRoutes)

  serveOpenApi(app)

  return app
}
