import { describe, expect, test } from 'bun:test'
import type { EnrichedFieldName } from 'tula-closeline-contract'
import { ProviderError } from '~/ports/enrichment-provider'
import { createApolloProvider } from './apollo'
import { createCircuit } from './circuit'
import type { FetchLike } from './vendor-call'
import { createZeroBounceVerifier } from './zerobounce'

const KEY = 'sk_live_SECRET_0123456789'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** A scripted vendor: answers in order and records each request. */
function script(...answers: (Response | Error)[]) {
  const seen: { url: string; init: RequestInit }[] = []
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, init })
    const next = answers.shift() ?? json({}, 500)
    if (next instanceof Error) {
      throw next
    }
    return next
  }
  return { fetch, seen }
}

const signal = () => new AbortController().signal
const apollo = (fetch: FetchLike) =>
  createApolloProvider({ baseUrl: 'https://apollo.test/', fetch })
const failureOf = async (run: Promise<unknown>) => {
  try {
    await run
  } catch (error) {
    return error instanceof ProviderError ? error.failure : 'other'
  }
  return 'none'
}

describe('Apollo person lookup', () => {
  const wanted: EnrichedFieldName[] = ['firstName', 'lastName', 'jobTitle', 'linkedinUrl']

  test('maps People Match to fields, sends the key in a header, never in the URL', async () => {
    const vendor = script(
      json({
        person: {
          first_name: 'Ada',
          last_name: 'Lovelace',
          title: 'CTO',
          linkedin_url: 'https://l/a',
        },
      })
    )
    const found = await apollo(vendor.fetch).lookup({
      wanted,
      known: { email: 'ada@x.test' },
      apiKey: KEY,
      signal: signal(),
    })
    expect(found.map((f) => [f.field, f.value])).toEqual([
      ['firstName', 'Ada'],
      ['lastName', 'Lovelace'],
      ['jobTitle', 'CTO'],
      ['linkedinUrl', 'https://l/a'],
    ])
    expect(vendor.seen[0]?.url).toBe('https://apollo.test/api/v1/people/match')
    expect(vendor.seen[0]?.url).not.toContain(KEY)
    expect(new Headers(vendor.seen[0]?.init.headers).get('x-api-key')).toBe(KEY)
  })

  test('with nothing to search by it finds nothing and does not call', async () => {
    const vendor = script()
    expect(
      await apollo(vendor.fetch).lookup({
        wanted,
        known: { firstName: 'Ada' },
        apiKey: KEY,
        signal: signal(),
      })
    ).toEqual([])
    expect(vendor.seen).toHaveLength(0)
  })

  test('a 404 or an unmatched person is an empty result', async () => {
    const vendor = script(json({}, 404), json({ person: null }))
    const p = apollo(vendor.fetch)
    const request = { wanted, known: { email: 'a@x.test' }, apiKey: KEY, signal: signal() }
    expect(await p.lookup(request)).toEqual([])
    expect(await p.lookup(request)).toEqual([])
  })
})

describe('Apollo company lookup', () => {
  test('maps Organization Enrichment by domain', async () => {
    const vendor = script(
      json({
        organization: {
          name: 'Acme',
          primary_domain: 'acme.test',
          industry: 'software',
          estimated_num_employees: 120,
          country: 'Germany',
          technology_names: ['Postgres', 'Bun'],
        },
      })
    )
    const found = await apollo(vendor.fetch).lookup({
      wanted: ['companyName', 'industry', 'employeeCount', 'region', 'technologies'],
      known: { companyDomain: 'acme.test' },
      apiKey: KEY,
      signal: signal(),
    })
    expect(Object.fromEntries(found.map((f) => [f.field, f.value]))).toEqual({
      companyName: 'Acme',
      industry: 'software',
      employeeCount: '120',
      region: 'Germany',
      technologies: 'Postgres, Bun',
    })
    expect(vendor.seen[0]?.url).toBe(
      'https://apollo.test/api/v1/organizations/enrich?domain=acme.test'
    )
  })

  test('without a domain it does not call', async () => {
    const vendor = script()
    await apollo(vendor.fetch).lookup({
      wanted: ['industry'],
      known: {},
      apiKey: KEY,
      signal: signal(),
    })
    expect(vendor.seen).toHaveLength(0)
  })
})

describe('vendor failures become fixed ProviderError words', () => {
  const lookup = (answer: Response | Error) =>
    apollo(script(answer).fetch).lookup({
      wanted: ['firstName'],
      known: { email: 'a@x.test' },
      apiKey: KEY,
      signal: signal(),
    })
  test.each([
    ['401', json({}, 401), 'key_rejected'],
    ['403', json({}, 403), 'key_rejected'],
    ['429', json({}, 429), 'rate_limited'],
    ['500', json({}, 500), 'provider_error'],
    ['bad JSON', new Response('<html>', { status: 200 }), 'invalid_response'],
    ['network', new Error(`connect failed for ${KEY}`), 'provider_error'],
    ['abort', Object.assign(new Error('x'), { name: 'AbortError' }), 'timeout'],
  ] as const)('%s', async (_name, answer, failure) => {
    expect(await failureOf(lookup(answer))).toBe(failure)
  })

  test('no error text carries the key or the URL', async () => {
    const error = await lookup(new Error(`GET https://apollo.test/?k=${KEY}`)).catch((e) => e)
    expect(String(error.message) + String(error.stack)).not.toContain(KEY)
  })
})

describe('ZeroBounce', () => {
  const verifier = (...answers: (Response | Error)[]) => {
    const vendor = script(...answers)
    return {
      vendor,
      verify: () =>
        createZeroBounceVerifier({ baseUrl: 'https://zb.test', fetch: vendor.fetch }).verify({
          email: 'a@x.test',
          apiKey: KEY,
          signal: signal(),
        }),
    }
  }

  test.each([
    [{ status: 'valid' }, 'valid', 'accepted'],
    [{ status: 'catch-all' }, 'risky', 'catch_all'],
    [{ status: 'unknown' }, 'risky', 'unknown'],
    [{ status: 'invalid', sub_status: 'mailbox_not_found' }, 'invalid', 'mailbox_not_found'],
    [{ status: 'invalid', sub_status: 'no_dns_entries' }, 'invalid', 'domain_invalid'],
    [{ status: 'do_not_mail', sub_status: 'role_based' }, 'invalid', 'role_based'],
    [{ status: 'do_not_mail', sub_status: 'disposable' }, 'invalid', 'disposable'],
    [{ status: 'spamtrap' }, 'invalid', 'unknown'],
    [{ status: 'valid', sub_status: '' }, 'valid', 'accepted'],
  ] as const)('maps %o', async (body, status, reason) => {
    expect(await verifier(json(body)).verify()).toEqual({ status, reason })
  })

  test('the key goes in the query and the address is asked once', async () => {
    const v = verifier(json({ status: 'valid' }))
    await v.verify()
    const url = new URL(v.vendor.seen[0]?.url ?? '')
    expect(url.pathname).toBe('/v2/validate')
    expect(url.searchParams.get('api_key')).toBe(KEY)
    expect(url.searchParams.get('email')).toBe('a@x.test')
  })

  test('a 200 with an API-key error is key_rejected, no credit rate_limited, other errors provider_error', async () => {
    expect(await failureOf(verifier(json({ error: 'Invalid API key' })).verify())).toBe(
      'key_rejected'
    )
    expect(await failureOf(verifier(json({ error: 'Out of credits' })).verify())).toBe(
      'rate_limited'
    )
    expect(await failureOf(verifier(json({ error: 'Boom' })).verify())).toBe('provider_error')
  })

  test('an unknown status is invalid_response; 429 and 5xx map', async () => {
    expect(await failureOf(verifier(json({ status: 'weird' })).verify())).toBe('invalid_response')
    expect(await failureOf(verifier(json({}, 429)).verify())).toBe('rate_limited')
    expect(await failureOf(verifier(json({}, 503)).verify())).toBe('provider_error')
  })

  test('a failure never carries the key (it travels in the URL)', async () => {
    const error = await verifier(new Error(`failed ${KEY}`))
      .verify()
      .catch((e) => e)
    expect(String(error.message) + String(error.stack)).not.toContain(KEY)
  })
})

describe('the circuit', () => {
  const setup = () => {
    let now = 0
    const guard = createCircuit({ failures: 2, openMs: 1_000, now: () => now })
    let calls = 0
    const call = (fail: ProviderError | null) => async () => {
      calls += 1
      if (fail) {
        throw fail
      }
      return 'ok'
    }
    return {
      guard,
      call,
      calls: () => calls,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  test('opens after consecutive failures and stops calling', async () => {
    const c = setup()
    const down = new ProviderError('provider_error')
    await failureOf(c.guard(c.call(down)))
    await failureOf(c.guard(c.call(down)))
    expect(await failureOf(c.guard(c.call(null)))).toBe('provider_error')
    expect(c.calls()).toBe(2)
  })

  test('lets one trial through after the open time, and closes on success', async () => {
    const c = setup()
    const down = new ProviderError('timeout')
    await failureOf(c.guard(c.call(down)))
    await failureOf(c.guard(c.call(down)))
    c.advance(1_000)
    expect(await c.guard(c.call(null))).toBe('ok')
    expect(await c.guard(c.call(null))).toBe('ok')
    expect(c.calls()).toBe(4)
  })

  test('a failed trial reopens it', async () => {
    const c = setup()
    const down = new ProviderError('timeout')
    await failureOf(c.guard(c.call(down)))
    await failureOf(c.guard(c.call(down)))
    c.advance(1_000)
    await failureOf(c.guard(c.call(down)))
    expect(await failureOf(c.guard(c.call(null)))).toBe('provider_error')
  })

  test('a trial refused for its key closes it and resets the count', async () => {
    const c = setup()
    const down = new ProviderError('timeout')
    await failureOf(c.guard(c.call(down)))
    await failureOf(c.guard(c.call(down)))
    c.advance(1_000)
    await failureOf(c.guard(c.call(new ProviderError('key_rejected'))))
    await failureOf(c.guard(c.call(down)))
    expect(await c.guard(c.call(null))).toBe('ok')
  })

  test('a rejected key or a rate limit never opens it, and a success resets the count', async () => {
    const c = setup()
    for (let i = 0; i < 5; i++) {
      await failureOf(c.guard(c.call(new ProviderError('key_rejected'))))
      await failureOf(c.guard(c.call(new ProviderError('rate_limited'))))
    }
    expect(await c.guard(c.call(null))).toBe('ok')
    await failureOf(c.guard(c.call(new ProviderError('timeout'))))
    await c.guard(c.call(null))
    await failureOf(c.guard(c.call(new ProviderError('timeout'))))
    expect(await c.guard(c.call(null))).toBe('ok')
  })
})

const liveApollo = process.env.APOLLO_LIVE_KEY
const liveZeroBounce = process.env.ZEROBOUNCE_LIVE_KEY

describe('live vendors (opt-in: set APOLLO_LIVE_KEY / ZEROBOUNCE_LIVE_KEY)', () => {
  test.skipIf(!liveApollo)('Apollo answers a company lookup', async () => {
    const found = await createApolloProvider({ baseUrl: 'https://api.apollo.io' }).lookup({
      wanted: ['companyName'],
      known: { companyDomain: 'apollo.io' },
      apiKey: liveApollo ?? '',
      signal: AbortSignal.timeout(15_000),
    })
    expect(Array.isArray(found)).toBe(true)
  })
  test.skipIf(!liveZeroBounce)('ZeroBounce answers a verdict', async () => {
    const verdict = await createZeroBounceVerifier({
      baseUrl: 'https://api.zerobounce.net',
    }).verify({
      email: 'valid@example.com',
      apiKey: liveZeroBounce ?? '',
      signal: AbortSignal.timeout(15_000),
    })
    expect(['valid', 'risky', 'invalid']).toContain(verdict.status)
  })
})
