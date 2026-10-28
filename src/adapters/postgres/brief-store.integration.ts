import { afterAll, describe, expect, test } from 'bun:test'
import { formatId, type ProspectId, type ResearchBrief } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createMemoryBriefStore } from '~/adapters/memory/brief-store'
import { integrationUrls } from '~/integration-support'
import type { BriefStore } from '~/ports/brief-store'
import { newOrganizationId } from '~/testing'
import { createPostgresBriefStore } from './brief-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const hex = () => crypto.randomUUID().replaceAll('-', '')
const key = () => `key-${crypto.randomUUID()}`

function brief(prospectId: ProspectId, at: Date, overrides: Partial<ResearchBrief> = {}) {
  const moment = {
    kind: 'moment' as const,
    callId: formatId('call', hex()),
    dealRecordId: formatId('deal', hex()),
  }
  return {
    id: formatId('brf', hex()),
    prospectId,
    statements: [
      {
        text: 'Is a VP',
        source: { kind: 'prospect_field' as const, prospectId, field: 'jobTitle' as const },
      },
      {
        text: 'Raised a round',
        source: {
          kind: 'web_page' as const,
          url: 'https://news.example.com/1',
          retrievedAt: at.toISOString(),
        },
      },
      {
        text: 'Opened an email',
        source: {
          kind: 'signal' as const,
          signalId: formatId('sig', hex()),
          observedAt: at.toISOString(),
        },
      },
      {
        text: 'From a guide',
        source: { kind: 'document' as const, documentId: formatId('doc', hex()), page: null },
      },
    ],
    angle: { text: 'Lead with ROI', origin: 'won_deals' as const, sources: [moment] },
    droppedCount: 2,
    prospectUpdatedAt: at.toISOString(),
    language: 'en' as const,
    model: 'test-model',
    createdAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 86_400_000).toISOString(),
    ...overrides,
  } satisfies ResearchBrief
}

const stores: [string, BriefStore][] = [
  ['memory', createMemoryBriefStore()],
  [
    'postgres',
    createPostgresBriefStore((organizationId, fn) =>
      withOrganization(database.db, organizationId, fn)
    ),
  ],
]

describe.each(stores)('brief store (%s)', (_name, store) => {
  test('a Brief reads back whole, by id, newest and key', async () => {
    const org = newOrganizationId()
    const prospect = formatId('prs', hex())
    const made = brief(prospect, new Date())
    const k = key()
    expect(await store.insert(org, made, k)).toEqual({ brief: made, created: true })
    expect(await store.get(org, made.id)).toEqual(made)
    expect(await store.newest(org, prospect)).toEqual(made)
    expect(await store.byRequestKey(org, k)).toEqual(made)
    expect(await store.byRequestKey(org, key())).toBeNull()
  })

  test('one key keeps one Brief: the loser gets the winner and nothing of its own is stored', async () => {
    const org = newOrganizationId()
    const prospect = formatId('prs', hex())
    const k = key()
    const first = brief(prospect, new Date())
    const second = brief(prospect, new Date())
    const [a, b] = await Promise.all([store.insert(org, first, k), store.insert(org, second, k)])
    expect(a.brief.id).toBe(b.brief.id)
    expect([a.created, b.created].sort()).toEqual([false, true])
    expect(await store.get(org, a.brief.id === first.id ? second.id : first.id)).toBeNull()
  })

  test('a key and a Brief belong to their Organization', async () => {
    const org = newOrganizationId()
    const other = newOrganizationId()
    const prospect = formatId('prs', hex())
    const made = brief(prospect, new Date())
    const k = key()
    await store.insert(org, made, k)
    expect(await store.get(other, made.id)).toBeNull()
    expect(await store.byRequestKey(other, k)).toBeNull()
    expect(await store.newest(other, prospect)).toBeNull()
    expect((await store.insert(other, brief(prospect, new Date()), k)).created).toBe(true)
  })

  test('pages a Prospect newest first', async () => {
    const org = newOrganizationId()
    const prospect = formatId('prs', hex())
    const base = Date.now()
    const [oldest, middle, newest] = [0, 1, 2].map((i) =>
      brief(prospect, new Date(base + i * 1000))
    ) as [ResearchBrief, ResearchBrief, ResearchBrief]
    const made = [oldest, middle, newest]
    for (const b of made) {
      await store.insert(org, b, key())
    }
    const first = await store.list(org, prospect, null, 2)
    expect(first.map((b) => b.id)).toEqual([newest.id, middle.id])
    const last = first.at(-1)
    const rest = await store.list(
      org,
      prospect,
      { createdAt: last?.createdAt ?? '', id: last?.id ?? '' },
      2
    )
    expect(rest.map((b) => b.id)).toEqual([oldest.id])
    expect((await store.newest(org, prospect))?.id).toBe(newest.id)
  })
})
