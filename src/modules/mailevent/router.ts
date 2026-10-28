import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import {
  ERRORS,
  unsubscribePageSchema,
  unsubscribeParamsSchema,
  unsubscribeResultSchema,
} from 'tula-closeline-contract'
import { resolveClientAddress } from '~/http/client-address'
import { domainError } from '~/http/domain-error'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { contractRoute, failureResponses } from '~/modules/mailbox/openapi'
import type { MailEventDeps } from './deps'
import * as MailEvents from './service'
import { verifyWebhookState } from './state'

type BunServer = { requestIP?: (request: Request) => { address: string } | null }

const base = { tags: ['mail'], security: [{ [PUBLIC_SECURITY]: [] }] }
const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
})

const gmailRoute = createRoute({
  ...contractRoute('receiveGmailNotification'),
  ...base,
  summary: "Receive Gmail's push notification",
  responses: {
    204: { description: 'The Mailbox was read.' },
    ...failureResponses('receiveGmailNotification'),
  },
})

const graphRoute = createRoute({
  ...contractRoute('receiveGraphNotification'),
  ...base,
  summary: "Receive Microsoft Graph's change notification",
  responses: {
    202: { description: 'The Mailboxes were read.' },
    200: {
      description: 'A subscription validation: the validationToken, as plain text.',
      content: { 'text/plain': { schema: z.string() } },
    },
    ...failureResponses('receiveGraphNotification'),
  },
})

const notificationsSchema = z.object({
  value: z.array(z.object({ clientState: z.string().max(1024).optional() })).max(100),
})

const pageRoute = createRoute({
  ...contractRoute('getUnsubscribePage'),
  ...base,
  summary: 'What the unsubscribe page shows',
  request: { params: unsubscribeParamsSchema },
  responses: {
    200: json('The sender, and nothing else.', unsubscribePageSchema),
    ...failureResponses('getUnsubscribePage'),
  },
})

const confirmRoute = createRoute({
  ...contractRoute('confirmUnsubscribe'),
  ...base,
  summary: 'Unsubscribe from the page button or by the one-click POST',
  description: `${contractRoute('confirmUnsubscribe').description} The one-click POST sends the form field List-Unsubscribe=One-Click.`,
  request: { params: unsubscribeParamsSchema },
  responses: {
    200: json('The address is suppressed.', unsubscribeResultSchema),
    ...failureResponses('confirmUnsubscribe'),
  },
})

/** The public mail routes: provider notifications and the unsubscribe page. None takes a user token, so mount before the token middleware. */
export function createMailEventRouter(deps: MailEventDeps): OpenAPIHono<AppEnv> {
  const router = createRouter<AppEnv>()

  /** Queues a read of the Mailbox a genuine state names; any other state is `auth.unauthenticated`. */
  async function pollState(state: string | undefined): Promise<boolean> {
    const named = state === undefined ? null : verifyWebhookState(deps.secret, state)
    if (named === null) {
      return false
    }
    await MailEvents.enqueuePoll(deps, named.organizationId, named.mailboxId)
    return true
  }

  router.openapi(gmailRoute, async (c) => {
    // The push body only says that something changed; it is never read. Pub/Sub proves itself with
    // a Google-signed token for our URL, and the state names the Mailbox.
    if (
      !(await deps.verifyPush(c.req.header('authorization'))) ||
      !(await pollState(c.req.query('state')))
    ) {
      throw domainError(ERRORS['auth.unauthenticated'])
    }
    return c.body(null, 204)
  })

  router.openapi(graphRoute, async (c) => {
    const validation = c.req.query('validationToken')
    if (validation !== undefined) {
      return c.text(validation, 200)
    }
    const parsed = notificationsSchema.safeParse(await c.req.json().catch(() => null))
    const states = new Set(parsed.success ? parsed.data.value.map((n) => n.clientState) : [])
    let read = false
    for (const state of states) {
      read = (await pollState(state)) || read
    }
    if (!read) {
      throw domainError(ERRORS['auth.unauthenticated'])
    }
    return c.body(null, 202)
  })

  /** The canonical client address the rate limit counts. */
  const addressOf = (c: Context<AppEnv>) =>
    resolveClientAddress({
      // Bun.serve passes its server as the Hono env; app.request in tests passes nothing.
      socketAddress: (c.env as BunServer | undefined)?.requestIP?.(c.req.raw)?.address,
      forwardedFor: c.req.header('x-forwarded-for'),
      trustedProxyHops: deps.trustedProxyHops,
    })

  router.openapi(pageRoute, async (c) => {
    c.header('cache-control', 'no-store')
    c.header('referrer-policy', 'no-referrer')
    return c.json(
      await MailEvents.unsubscribePage(deps, c.req.valid('param').token, addressOf(c)),
      200
    )
  })

  router.openapi(confirmRoute, async (c) => {
    const type = c.req.header('content-type') ?? ''
    const form: Record<string, unknown> = type.includes('application/x-www-form-urlencoded')
      ? await c.req.parseBody().catch(() => ({}))
      : {}
    const source = form['List-Unsubscribe'] === 'One-Click' ? 'one_click' : 'link'
    c.header('cache-control', 'no-store')
    c.header('referrer-policy', 'no-referrer')
    return c.json(
      await MailEvents.unsubscribe(deps, c.req.valid('param').token, source, addressOf(c)),
      200
    )
  })

  return router
}
