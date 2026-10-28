import { type EnrichedFieldName, FIELD_GROUP_OF, type ProviderKey } from 'tula-closeline-contract'
import type { EnrichmentProvider, FoundField, LookupRequest } from '~/ports/enrichment-provider'
import { type FetchLike, objectOf, text, vendorJson } from './vendor-call'

/** How sure Apollo's own match makes us; above the waterfall's floor, below a verified source. */
const CONFIDENCE = 85

/** Options for {@link createApolloProvider}. */
export type ApolloOptions = {
  /** Apollo's origin, e.g. `https://api.apollo.io`. */
  baseUrl: string
  /** One call costs this much, in micro-dollars. */
  priceMicros?: number
  fetch?: FetchLike
  /** Wraps each vendor call, for the circuit. */
  guard?: <T>(call: () => Promise<T>) => Promise<T>
}

/** Keeps only the fields the waterfall asked for. */
function pick(
  wanted: readonly EnrichedFieldName[],
  found: Partial<Record<EnrichedFieldName, string | undefined>>
): FoundField[] {
  return wanted.flatMap((field) => {
    const value = found[field]
    return value === undefined ? [] : [{ field, value, confidence: CONFIDENCE }]
  })
}

/**
 * Apollo as a person and company source. Person: People Match by email, LinkedIn URL, or name with
 * company. Company: Organization Enrichment by domain. The key travels in `x-api-key`. A lookup
 * with nothing to search by finds nothing without calling. Retries come from the waterfall.
 */
export function createApolloProvider(options: ApolloOptions): EnrichmentProvider {
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const guard = options.guard ?? (<T>(call: () => Promise<T>) => call())
  const base = options.baseUrl.replace(/\/+$/, '')
  const headers = (apiKey: string) => ({
    'x-api-key': apiKey,
    'content-type': 'application/json',
    accept: 'application/json',
  })

  async function person(request: LookupRequest): Promise<FoundField[]> {
    const { known } = request
    const hasCompany = known.companyDomain !== undefined || known.companyName !== undefined
    const named = known.firstName !== undefined && known.lastName !== undefined && hasCompany
    if (known.email === undefined && known.linkedinUrl === undefined && !named) {
      return []
    }
    const body = {
      email: known.email,
      linkedin_url: known.linkedinUrl,
      first_name: known.firstName,
      last_name: known.lastName,
      domain: known.companyDomain,
      organization_name: known.companyName,
      reveal_personal_emails: false,
    }
    const answer = await guard(() =>
      vendorJson(
        fetchFn,
        `${base}/api/v1/people/match`,
        { method: 'POST', headers: headers(request.apiKey), body: JSON.stringify(body) },
        request.signal,
        true
      )
    )
    const found = objectOf(answer, 'person')
    return found === undefined
      ? []
      : pick(request.wanted, {
          firstName: text(found, 'first_name'),
          lastName: text(found, 'last_name'),
          jobTitle: text(found, 'title'),
          linkedinUrl: text(found, 'linkedin_url'),
        })
  }

  async function company(request: LookupRequest): Promise<FoundField[]> {
    const domain = request.known.companyDomain
    if (domain === undefined) {
      return []
    }
    const answer = await guard(() =>
      vendorJson(
        fetchFn,
        `${base}/api/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
        { method: 'GET', headers: headers(request.apiKey) },
        request.signal,
        true
      )
    )
    const found = objectOf(answer, 'organization')
    if (found === undefined) {
      return []
    }
    const count = found.estimated_num_employees
    const technologies = Array.isArray(found.technology_names)
      ? found.technology_names.filter((t): t is string => typeof t === 'string').join(', ')
      : ''
    return pick(request.wanted, {
      companyName: text(found, 'name'),
      companyDomain: text(found, 'primary_domain'),
      industry: text(found, 'industry'),
      employeeCount:
        typeof count === 'number' && count >= 0 ? String(Math.round(count)) : undefined,
      region: text(found, 'country'),
      technologies: technologies === '' ? undefined : technologies,
    })
  }

  return {
    key: 'apollo' as ProviderKey,
    groups: ['person', 'company'],
    priceMicros: options.priceMicros ?? 20_000,
    lookup: (request) =>
      request.wanted.some((field) => FIELD_GROUP_OF[field] === 'company')
        ? company(request)
        : person(request),
  }
}
