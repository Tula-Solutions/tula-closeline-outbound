import { CAMPAIGN_ERRORS, CAMPAIGN_ROUTES, ERRORS } from 'tula-closeline-contract'
import { errorResponse, errorResponseWithRetryAfter } from '~/http/responses'

/** The route names the play module implements. */
export type PlayRouteName =
  | 'listPlays'
  | 'getPlay'
  | 'createPlay'
  | 'editPlay'
  | 'proposePlays'
  | 'acceptPlay'
  | 'discardPlay'

const ALL_ERRORS: Record<string, { code: string; status: number }> = {
  ...ERRORS,
  ...CAMPAIGN_ERRORS,
}

/** The codes every public route may answer with besides its own. */
const ALWAYS = ['auth.unauthenticated', 'server.internal'] as const

/** The method, path and description a route has in the contract, in the form `createRoute` takes. */
export function contractRoute(name: PlayRouteName) {
  const route = CAMPAIGN_ROUTES[name]
  return {
    method: route.method.toLowerCase() as 'get' | 'post' | 'patch',
    path: route.path,
    description: route.description,
  }
}

/** The roles the contract lets call a route. */
export function rolesOf(name: PlayRouteName) {
  return CAMPAIGN_ROUTES[name].roles
}

/** The failure responses of a route as the contract lists them; codes with one status share a response. */
export function failureResponses(name: PlayRouteName) {
  const route = CAMPAIGN_ROUTES[name]
  const codes = new Set<string>([
    ...route.errors,
    ...route.commonErrors,
    ...ALWAYS,
    ...(route.roles.length > 0 ? ['auth.forbidden'] : []),
  ])
  const byStatus = new Map<number, string[]>()
  for (const code of codes) {
    const definition = ALL_ERRORS[code]
    if (definition === undefined) {
      throw new Error(`the contract names an error code the registry lacks: ${code}`)
    }
    byStatus.set(definition.status, [...(byStatus.get(definition.status) ?? []), code])
  }
  const responses: Record<number, ReturnType<typeof errorResponse>> = {}
  for (const [status, list] of [...byStatus].sort(([a], [b]) => a - b)) {
    const description = `${list.sort().join(', ')}.`
    responses[status] =
      status === 503 || list.includes('request.idempotency_in_progress')
        ? errorResponseWithRetryAfter(description)
        : errorResponse(description)
  }
  return responses
}
