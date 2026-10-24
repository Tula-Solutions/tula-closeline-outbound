import { afterEach, expect, test } from 'bun:test'
import {
  type EnrichmentRunId,
  formatId,
  type OrganizationId,
  type ProspectId,
  type ProviderKey,
} from 'tula-closeline-contract'
import { createLogger } from 'tula-closeline-kit'
import { CoreCallError, createHttpCoreProspects } from '~/adapters/http/core'
import { CoreProspectNotFoundError } from '~/ports/core'

const SECRET = 'internal-secret-0123456789-abcdefghij'
const VALUE = 'Sensitive Value Inc'
const organizationId = formatId('org', crypto.randomUUID()) as OrganizationId
const prospectId = formatId('prs', crypto.randomUUID()) as ProspectId
const runId = formatId('erun', crypto.randomUUID()) as EnrichmentRunId

type Seen = { method: string; path: string; headers: Headers; body: unknown }
type Reply = { status: number; json?: unknown; delayMs?: number }

const servers: { stop: (force: boolean) => unknown }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true)
  }
})

/** A fake core on an ephemeral port that answers from `replies` in order (the last repeats). */
function fakeCore(replies: Reply[]) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const text = await request.text()
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: text === '' ? undefined : JSON.parse(text),
      })
      const reply = replies[Math.min(seen.length, replies.length) - 1] as Reply
      if (reply.delayMs) {
        await Bun.sleep(reply.delayMs)
      }
      return Response.json(reply.json ?? {}, { status: reply.status })
    },
  })
  servers.push(server)
  return { seen, url: `http://127.0.0.1:${server.port}` }
}

function adapter(url: string, extra: { timeoutMs?: number; lines?: string[] } = {}) {
  const sleeps: number[] = []
  const lines = extra.lines ?? []
  const core = createHttpCoreProspects({
    baseUrl: url,
    secret: SECRET,
    environment: 'local',
    timeoutMs: extra.timeoutMs ?? 2_000,
    maxAttempts: 3,
    logger: createLogger({
      service: 'outbound',
      level: 'debug',
      destination: { write: (line: string) => lines.push(line) },
    }),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
  })
  return { core, sleeps, lines }
}

const inputBody = {
  prospectId,
  email: 'a@b.co',
  firstName: 'Ada',
  lastName: null,
  jobTitle: VALUE,
  companyName: null,
  companyDomain: 'b.co',
  presentFields: ['email', 'firstName', 'jobTitle', 'companyDomain', 'industry'],
}

const write = {
  runId,
  fields: [
    {
      field: 'jobTitle' as const,
      value: VALUE,
      provider: 'apollo' as ProviderKey,
      confidence: 0.9,
      obtainedAt: '2026-10-23T10:00:00.000Z',
    },
  ],
}

test('reading a Prospect sends the secret and the Organization and returns the values it holds', async () => {
  const core = fakeCore([{ status: 200, json: inputBody }])
  const { core: http } = adapter(core.url)

  const input = await http.getEnrichmentInput(organizationId, prospectId)

  expect(input).toEqual({
    prospectId,
    values: { email: 'a@b.co', firstName: 'Ada', jobTitle: VALUE, companyDomain: 'b.co' },
  })
  expect(core.seen).toHaveLength(1)
  expect(core.seen[0]?.method).toBe('GET')
  expect(core.seen[0]?.path).toBe(`/internal/v1/prospects/${prospectId}/enrichment-input`)
  expect(core.seen[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET}`)
  expect(core.seen[0]?.headers.get('x-organization-id')).toBe(organizationId)
})

test('a Prospect core does not know reads as null and is asked once', async () => {
  const core = fakeCore([
    { status: 404, json: { error: { code: 'enrichment.prospect_not_found', message: 'no' } } },
  ])
  const { core: http, sleeps } = adapter(core.url)

  expect(await http.getEnrichmentInput(organizationId, prospectId)).toBeNull()
  expect(core.seen).toHaveLength(1)
  expect(sleeps).toEqual([])
})

test('writing fields posts the run id and the fields with the secret and Organization', async () => {
  const core = fakeCore([
    { status: 200, json: { results: [{ field: 'jobTitle', application: 'written' }] } },
  ])
  const { core: http } = adapter(core.url)

  const answer = await http.writeEnrichedFields(organizationId, prospectId, write)

  expect(answer).toEqual({ results: [{ field: 'jobTitle', application: 'written' }] })
  expect(core.seen[0]?.method).toBe('POST')
  expect(core.seen[0]?.path).toBe(`/internal/v1/prospects/${prospectId}/enriched-fields`)
  expect(core.seen[0]?.body).toEqual(write)
  expect(core.seen[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET}`)
  expect(core.seen[0]?.headers.get('x-organization-id')).toBe(organizationId)
})

test('a write that meets 503 twice is retried with the same run id and then succeeds', async () => {
  const core = fakeCore([
    { status: 503, json: { error: { code: 'server.unavailable', message: 'busy' } } },
    { status: 503, json: { error: { code: 'server.unavailable', message: 'busy' } } },
    { status: 200, json: { results: [{ field: 'jobTitle', application: 'suggested' }] } },
  ])
  const { core: http, sleeps } = adapter(core.url)

  const answer = await http.writeEnrichedFields(organizationId, prospectId, write)

  expect(answer.results[0]?.application).toBe('suggested')
  expect(core.seen).toHaveLength(3)
  expect(sleeps).toHaveLength(2)
  for (const call of core.seen) {
    expect(call.body).toEqual(write)
  }
})

test('a read that keeps meeting 503 gives up after the bounded tries with a CoreCallError', async () => {
  const core = fakeCore([
    { status: 503, json: { error: { code: 'server.unavailable', message: 'busy' } } },
  ])
  const { core: http } = adapter(core.url)

  const failure = await http.getEnrichmentInput(organizationId, prospectId).catch((e) => e)

  expect(failure).toBeInstanceOf(CoreCallError)
  expect(core.seen).toHaveLength(3)
})

test('a call that outlasts the timeout fails as a CoreCallError instead of hanging', async () => {
  const core = fakeCore([{ status: 200, json: inputBody, delayMs: 500 }])
  const { core: http } = adapter(core.url, { timeoutMs: 50 })

  const failure = await http.getEnrichmentInput(organizationId, prospectId).catch((e) => e)

  expect(failure).toBeInstanceOf(CoreCallError)
  expect((failure as CoreCallError).failure).toBe('timeout')
})

test('a write for a Prospect core cannot find is a terminal error and is not retried', async () => {
  const core = fakeCore([
    { status: 404, json: { error: { code: 'enrichment.prospect_not_found', message: 'no' } } },
  ])
  const { core: http, sleeps } = adapter(core.url)

  const failure = await http.writeEnrichedFields(organizationId, prospectId, write).catch((e) => e)

  expect(failure).toBeInstanceOf(CoreProspectNotFoundError)
  expect(core.seen).toHaveLength(1)
  expect(sleeps).toEqual([])
})

test('a 404 that does not carry the not-found code is a failure, not a missing Prospect', async () => {
  const core = fakeCore([
    { status: 404, json: { error: { code: 'server.not_found', message: 'x' } } },
  ])
  const { core: http } = adapter(core.url)

  const failure = await http.getEnrichmentInput(organizationId, prospectId).catch((e) => e)

  expect(failure).toBeInstanceOf(CoreCallError)
  expect((failure as CoreCallError).code).toBe('server.not_found')
})

test('a rejected secret fails with the auth code and is not retried', async () => {
  const core = fakeCore([
    { status: 401, json: { error: { code: 'auth.unauthenticated', message: 'no' } } },
  ])
  const { core: http } = adapter(core.url)

  const failure = await http.getEnrichmentInput(organizationId, prospectId).catch((e) => e)

  expect(failure).toBeInstanceOf(CoreCallError)
  expect((failure as CoreCallError).code).toBe('auth.unauthenticated')
  expect(core.seen).toHaveLength(1)
})

test('an answer that is not the contract shape is a failure', async () => {
  const core = fakeCore([{ status: 200, json: { unexpected: true } }])
  const { core: http } = adapter(core.url)

  const failure = await http.getEnrichmentInput(organizationId, prospectId).catch((e) => e)

  expect(failure).toBeInstanceOf(CoreCallError)
})

test('neither the secret nor a field value reaches a log line or an error message', async () => {
  const lines: string[] = []
  const core = fakeCore([
    { status: 503, json: { error: { code: 'server.unavailable', message: VALUE } } },
    { status: 500, json: { error: { code: 'server.internal', message: VALUE } } },
  ])
  const { core: http } = adapter(core.url, { lines })

  const failure = await http.writeEnrichedFields(organizationId, prospectId, write).catch((e) => e)

  const everything = `${lines.join('\n')}\n${String(failure)}\n${(failure as Error).stack}`
  expect(failure).toBeInstanceOf(CoreCallError)
  expect(everything).not.toContain(SECRET)
  expect(everything).not.toContain(VALUE)
})
