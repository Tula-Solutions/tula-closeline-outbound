import { afterAll, describe, expect, test } from 'bun:test'
import { type BrandVoice, formatId, type MembershipId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createMemoryBrandVoiceStore } from '~/adapters/memory/brand-voice-store'
import { integrationUrls } from '~/integration-support'
import type { BrandVoiceStore } from '~/ports/brand-voice-store'
import { newOrganizationId } from '~/testing'
import { createPostgresBrandVoiceStore } from './brand-voice-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const member = (): MembershipId => formatId('mem', crypto.randomUUID())

function voice(version: number, tone = `tone ${version}`): BrandVoice {
  return {
    id: formatId('bvo', crypto.randomUUID()),
    version,
    tone,
    preferredWords: ['simple'],
    bannedPhrases: ['synergy'],
    signOff: null,
    maxLengthCharacters: 1500,
    createdByMembershipId: member(),
    createdAt: new Date().toISOString(),
  }
}

const stores: [string, BrandVoiceStore][] = [
  ['memory', createMemoryBrandVoiceStore()],
  [
    'postgres',
    createPostgresBrandVoiceStore((organizationId, fn) =>
      withOrganization(database.db, organizationId, fn)
    ),
  ],
]

describe.each(stores)('brand voice store (%s)', (_name, store) => {
  test('saves versions, keeps the old ones and pages newest first', async () => {
    const org = newOrganizationId()
    expect(await store.current(org)).toBeNull()
    for (const v of [1, 2, 3]) {
      await store.save(org, (current) => {
        expect(current?.version ?? 0).toBe(v - 1)
        return { kind: 'save', voice: voice(v) }
      })
    }
    expect((await store.current(org))?.version).toBe(3)
    const first = await store.list(org, null, 2)
    expect(first.items.map((x) => x.version)).toEqual([3, 2])
    expect(first.next).toBe(2)
    const rest = await store.list(org, first.next, 2)
    expect(rest.items.map((x) => x.version)).toEqual([1])
    expect(rest.next).toBeNull()
    expect(rest.items[0]?.signOff).toBeNull()
  })

  test('a refused decision writes nothing and an unchanged one returns the current', async () => {
    const org = newOrganizationId()
    await store.save(org, () => ({ kind: 'save', voice: voice(1) }))
    await expect(
      store.save(org, () => {
        throw new Error('refuse')
      })
    ).rejects.toThrow('refuse')
    expect((await store.save(org, () => ({ kind: 'unchanged' }))).version).toBe(1)
    expect((await store.list(org, null, 10)).items.length).toBe(1)
  })

  test('concurrent saves from the same version: one wins, the others see it', async () => {
    const org = newOrganizationId()
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() =>
        store.save(org, (current) => {
          if (current !== null) {
            throw new Error('conflict')
          }
          return { kind: 'save', voice: voice(1, 'racer') }
        })
      )
    )
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    expect((await store.list(org, null, 10)).items.length).toBe(1)
  })

  test("another Organization's versions are invisible", async () => {
    const a = newOrganizationId()
    const b = newOrganizationId()
    await store.save(a, () => ({ kind: 'save', voice: voice(1, 'A only') }))
    expect(await store.current(b)).toBeNull()
    expect((await store.list(b, null, 10)).items).toEqual([])
    await store.save(b, () => ({ kind: 'save', voice: voice(1, 'B only') }))
    expect((await store.current(a))?.tone).toBe('A only')
  })
})
