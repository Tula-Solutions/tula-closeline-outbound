import type { EnrichedFieldName, FieldGroup, ProviderKey } from 'tula-closeline-contract'
import type {
  EmailVerifier,
  EnrichmentProvider,
  FoundField,
  LookupRequest,
  Verdict,
} from '~/ports/enrichment-provider'

/** Made-up values a memory provider returns for each field, so a local run has data to show. */
const CANNED: Record<EnrichedFieldName, string> = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  jobTitle: 'Head of Engineering',
  linkedinUrl: 'https://www.linkedin.com/in/example',
  email: 'ada@example.test',
  companyName: 'Example Analytics',
  companyDomain: 'example.test',
  industry: 'Software',
  employeeCount: '120',
  region: 'us',
  technologies: 'TypeScript, Postgres',
}

/** A memory provider and the calls it received. */
export type MemoryProvider = EnrichmentProvider & { calls: LookupRequest[] }

/** A memory verifier and the calls it received. */
export type MemoryVerifier = EmailVerifier & { calls: { email: string }[] }

/**
 * A provider that answers from a function, for tests and local runs; by default it finds made-up
 * data for every wanted field. It counts the calls it gets.
 */
export function createMemoryProvider(options: {
  key: ProviderKey
  groups?: readonly FieldGroup[]
  priceMicros?: number
  respond?: (request: LookupRequest, call: number) => Promise<readonly FoundField[]>
}): MemoryProvider {
  const calls: LookupRequest[] = []
  return {
    key: options.key,
    groups: options.groups ?? ['person', 'company'],
    priceMicros: options.priceMicros ?? 10_000,
    calls,
    async lookup(request) {
      calls.push(request)
      if (options.respond !== undefined) {
        return options.respond(request, calls.length)
      }
      return request.wanted.map((field) => ({ field, value: CANNED[field], confidence: 90 }))
    },
  }
}

/** A verifier that answers from a function, by default `valid`. It counts the calls it gets. */
export function createMemoryVerifier(options: {
  key: ProviderKey
  priceMicros?: number
  respond?: (email: string, call: number) => Promise<Verdict>
}): MemoryVerifier {
  const calls: { email: string }[] = []
  return {
    key: options.key,
    priceMicros: options.priceMicros ?? 5_000,
    calls,
    async verify({ email }) {
      calls.push({ email })
      return options.respond === undefined
        ? { status: 'valid', reason: 'accepted' }
        : options.respond(email, calls.length)
    },
  }
}
