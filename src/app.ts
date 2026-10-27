import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { type AuthedEnv, authenticate } from '~/http/auth'
import { createBaseApp } from '~/http/base'
import { createRouter } from '~/http/router'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createCampaignRouter } from '~/modules/campaign/router'
import { createEnrichmentRouter } from '~/modules/enrichment/router'
import { createHealthRouter } from '~/modules/health/router'
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

  const publicRoutes = createRouter<AuthedEnv>()
  publicRoutes.use('/v1/*', authenticate(container))
  publicRoutes.route('/', createEnrichmentRouter(container.enrichment))
  publicRoutes.route('/', createCampaignRouter(container.campaigns))
  app.route('/', publicRoutes)

  serveOpenApi(app)

  return app
}
