import { afterAll, describe, expect, test } from 'bun:test'
import {
  type BrandVoice,
  formatId,
  type OrganizationId,
  type OutreachDraft,
  type ProspectId,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createMemoryBrandVoiceStore } from '~/adapters/memory/brand-voice-store'
import { createMemoryDraftStore } from '~/adapters/memory/draft-store'
import { integrationUrls } from '~/integration-support'
import type { BrandVoiceStore } from '~/ports/brand-voice-store'
import type { DraftOutcome, DraftStore } from '~/ports/draft-store'
import { newOrganizationId } from '~/testing'
import { createPostgresBrandVoiceStore } from './brand-voice-store'
import { createPostgresDraftStore } from './draft-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const hex = () => crypto.randomUUID().replaceAll('-', '')
const key = () => `key-${crypto.randomUUID()}`
const stores: [string, DraftStore, BrandVoiceStore][] = [
  ['memory', createMemoryDraftStore(), createMemoryBrandVoiceStore()],
  [
    'postgres',
    createPostgresDraftStore((organizationId, fn) =>
      withOrganization(database.db, organizationId, fn)
    ),
    createPostgresBrandVoiceStore((organizationId, fn) =>
      withOrganization(database.db, organizationId, fn)
    ),
  ],
]

const kept = (outcome: DraftOutcome | 'reused' | 'stale' | 'missing'): DraftOutcome => {
  if (typeof outcome === 'string') {
    throw new Error(`the store answered ${outcome}`)
  }
  return outcome
}

function draft(prospectId: ProspectId, voice: BrandVoice, revision = 1): OutreachDraft {
  const at = new Date().toISOString()
  return {
    id: formatId('drf', hex()),
    prospectId,
    campaignId: null,
    stepKey: null,
    channel: 'email',
    goal: 'Book a call',
    language: 'en',
    subject: 'Hello',
    body: 'Hi there',
    revision,
    source: revision > 1 ? 'edited' : 'generated',
    citations: [
      {
        kind: 'moment',
        callId: formatId('call', hex()),
        dealRecordId: formatId('deal', hex()),
        applies: true,
        score: 0.8,
      },
      { kind: 'prospect_field', prospectId, field: 'jobTitle', applies: true },
    ],
    ungrounded: false,
    wonDealCount: 1,
    checks: (
      ['citations_resolve', 'claims_supported', 'banned_phrase', 'length', 'name_match'] as const
    ).map((check) => ({ check, result: 'pass' as const, count: 0 })),
    autoSendable: true,
    brandVoiceId: voice.id,
    voiceVersion: voice.version,
    briefId: null,
    model: 'test-model',
    createdAt: at,
    updatedAt: at,
  } as OutreachDraft
}

async function setup(voices: BrandVoiceStore, organizationId: OrganizationId) {
  const voice = await voices.save(organizationId, () => ({
    kind: 'save',
    voice: {
      id: formatId('bvo', crypto.randomUUID()),
      version: 1,
      tone: 'plain',
      preferredWords: [],
      bannedPhrases: [],
      signOff: null,
      maxLengthCharacters: 1500,
      createdByMembershipId: formatId('mem', crypto.randomUUID()),
      createdAt: new Date().toISOString(),
    },
  }))
  return { voice, prospect: formatId('prs', hex()) }
}

describe.each(stores)('draft store (%s)', (_name, store, voices) => {
  test('a Draft reads back whole, by id and by key', async () => {
    const org = newOrganizationId()
    const { voice, prospect } = await setup(voices, org)
    const made = draft(prospect, voice)
    const k = key()
    expect(await store.insert(org, made, k, 'cost-angle')).toEqual({
      draft: made,
      variantKey: 'cost-angle',
      created: true,
    })
    expect(await store.get(org, made.id)).toEqual(made)
    expect(await store.byRequestKey(org, k)).toEqual({ draft: made, variantKey: 'cost-angle' })
    expect(await store.byRequestKey(org, key())).toBeNull()
  })

  test('one key keeps one Draft; another Prospect on the key is reused', async () => {
    const org = newOrganizationId()
    const { voice, prospect } = await setup(voices, org)
    const k = key()
    const first = draft(prospect, voice)
    const second = draft(prospect, voice)
    const [a, b] = (
      await Promise.all([store.insert(org, first, k, null), store.insert(org, second, k, null)])
    ).map(kept) as [DraftOutcome, DraftOutcome]
    expect(a.draft.id).toBe(b.draft.id)
    expect([a.created, b.created].sort()).toEqual([false, true])
    expect(await store.get(org, a.draft.id === first.id ? second.id : first.id)).toBeNull()
    expect(await store.insert(org, draft(formatId('prs', hex()), voice), k, null)).toBe('reused')
  })

  test('a revision replaces the text, Citations and checks once per key', async () => {
    const org = newOrganizationId()
    const { voice, prospect } = await setup(voices, org)
    const first = draft(prospect, voice)
    await store.insert(org, first, key(), null)
    const next: OutreachDraft = {
      ...draft(prospect, voice, 2),
      id: first.id,
      createdAt: first.createdAt,
      subject: 'Second',
      citations: [],
      ungrounded: true,
      wonDealCount: 0,
      autoSendable: false,
      source: 'generated',
    }
    const k = key()
    expect(kept(await store.revise(org, next, k))).toEqual({
      draft: next,
      variantKey: null,
      created: true,
    })
    expect(await store.get(org, first.id)).toEqual(next)
    expect(await store.regeneratedBy(org, first.id, k)).toEqual(next)
    expect(await store.regeneratedBy(org, first.id, key())).toBeNull()
    expect(kept(await store.revise(org, next, k)).created).toBe(false)
    expect(await store.revise(org, { ...next, revision: 5 }, key())).toBe('stale')
    expect(await store.revise(org, { ...next, id: formatId('drf', hex()) }, key())).toBe('missing')
  })

  test('a retry of an older regeneration key still finds its revision', async () => {
    const org = newOrganizationId()
    const { voice, prospect } = await setup(voices, org)
    const first = draft(prospect, voice)
    await store.insert(org, first, key(), null)
    const [k1, k2] = [key(), key()]
    const second = { ...draft(prospect, voice, 2), id: first.id, createdAt: first.createdAt }
    const third = { ...draft(prospect, voice, 3), id: first.id, createdAt: first.createdAt }
    kept(await store.revise(org, second, k1))
    kept(await store.revise(org, third, k2))
    expect(await store.regeneratedBy(org, first.id, k1)).toEqual(third)
    expect(kept(await store.revise(org, third, k1)).created).toBe(false)
    expect((await store.get(org, first.id))?.revision).toBe(3)
  })

  test('a Draft and its key belong to their Organization', async () => {
    const org = newOrganizationId()
    const other = newOrganizationId()
    const { voice, prospect } = await setup(voices, org)
    const otherSetup = await setup(voices, other)
    const made = draft(prospect, voice)
    const k = key()
    await store.insert(org, made, k, null)
    expect(await store.get(other, made.id)).toBeNull()
    expect(await store.byRequestKey(other, k)).toBeNull()
    expect(
      kept(await store.insert(other, draft(prospect, otherSetup.voice), k, null)).created
    ).toBe(true)
  })
})
