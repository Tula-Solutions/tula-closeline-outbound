import { afterAll, describe, expect, test } from 'bun:test'
import {
  type CallId,
  type DealRecordId,
  formatId,
  type MembershipId,
  type Play,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { newOrganizationId } from '~/testing'
import { createPostgresPlayStore } from './play-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const store = createPostgresPlayStore((organizationId, fn) =>
  withOrganization(database.db, organizationId, fn)
)

function newPlay(at: string, extra: Partial<Play> = {}): Play {
  const citations = [
    {
      kind: 'moment',
      callId: formatId('call', crypto.randomUUID()) as CallId,
      dealRecordId: formatId('deal', crypto.randomUUID()) as DealRecordId,
    },
  ]
  return {
    id: formatId('ply', crypto.randomUUID()),
    name: 'Open with the cost',
    goal: 'Start a conversation',
    steps: [
      { kind: 'email', key: 'intro', goal: 'Say hello', variants: null, next: 'bye' },
      { kind: 'end', key: 'bye' },
    ],
    intent: 'cold_intro',
    source: 'seeded',
    status: 'proposed',
    citations,
    evidenceCount: citations.length,
    noEvidence: false,
    createdByMembershipId: formatId('mem', crypto.randomUUID()) as MembershipId,
    createdAt: at,
    updatedAt: at,
    ...extra,
  } as Play
}

describe('postgres play store', () => {
  test('round-trips a Play with its citations and ignores a second insert', async () => {
    const org = newOrganizationId()
    const play = newPlay('2026-01-01T00:00:00.000Z')
    expect((await store.insertIfAbsent(org, play)).created).toBe(true)
    const again = await store.insertIfAbsent(org, { ...play, name: 'Changed' })
    expect(again.created).toBe(false)
    expect(again.play).toEqual(play)
    expect(await store.find(org, play.id)).toEqual(play)
  })

  test("never shows another Organization's Plays", async () => {
    const mine = newOrganizationId()
    const theirs = newOrganizationId()
    const play = newPlay('2026-01-01T00:00:00.000Z')
    await store.insertIfAbsent(theirs, play)
    expect(await store.find(mine, play.id)).toBeNull()
    expect((await store.list(mine, {}, null, 10)).items).toEqual([])
    expect(await store.modify(mine, play.id, (p) => p)).toBeNull()
  })

  test('lists newest first, filters, and resumes from the cursor', async () => {
    const org = newOrganizationId()
    const plays = [1, 2, 3].map((n) => newPlay(`2026-01-0${n}T00:00:00.000Z`))
    const ids = plays.map((p) => p.id)
    const nurture = newPlay('2026-01-04T00:00:00.000Z', { intent: 'nurture' })
    for (const p of [...plays, nurture]) {
      await store.insertIfAbsent(org, p)
    }
    const first = await store.list(org, { intent: 'cold_intro' }, null, 2)
    expect(first.items.map((p) => p.id)).toEqual(ids.slice(1).reverse())
    expect(first.next).not.toBeNull()
    const second = await store.list(org, { intent: 'cold_intro' }, first.next, 2)
    expect(second.items.map((p) => p.id)).toEqual(ids.slice(0, 1))
    expect(second.next).toBeNull()
    expect((await store.list(org, { status: 'accepted' }, null, 10)).items).toEqual([])
  })

  test('modify applies the change, and a throw writes nothing', async () => {
    const org = newOrganizationId()
    const play = newPlay('2026-01-01T00:00:00.000Z')
    await store.insertIfAbsent(org, play)
    const accepted = await store.modify(org, play.id, (p) => ({ ...p, status: 'accepted' }))
    expect(accepted?.status).toBe('accepted')
    await expect(
      store.modify(org, play.id, () => {
        throw new Error('stop')
      })
    ).rejects.toThrow('stop')
    expect((await store.find(org, play.id))?.status).toBe('accepted')
  })
})
