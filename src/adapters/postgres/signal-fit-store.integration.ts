import { afterAll, describe, expect, test } from 'bun:test'
import {
  type FitCriterion,
  type FitScore,
  formatId,
  type ProspectId,
  type SignalKindSetting,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createMemoryFitStore } from '~/adapters/memory/fit-store'
import { createMemorySignalStore } from '~/adapters/memory/signal-store'
import { integrationUrls } from '~/integration-support'
import { CriterionRefusedError, type FitStore } from '~/ports/fit-store'
import {
  SettingsVersionConflictError,
  type SignalStore,
  type StoredSignal,
} from '~/ports/signal-store'
import { newOrganizationId } from '~/testing'
import { createPostgresFitStore } from './fit-store'
import { createPostgresSignalStore } from './signal-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())
const inOrg = (organizationId: string, fn: Parameters<typeof withOrganization>[2]) =>
  withOrganization(database.db, organizationId as never, fn)

const signalStores: [string, SignalStore][] = [
  ['memory', createMemorySignalStore()],
  ['postgres', createPostgresSignalStore(inOrg as never)],
]
const fitStores: [string, FitStore][] = [
  ['memory', createMemoryFitStore()],
  ['postgres', createPostgresFitStore(inOrg as never)],
]

const sid = () => formatId('sig', crypto.randomUUID().replaceAll('-', ''))
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString()
const signal = (prospectId: ProspectId, minutes: number, expires: number): StoredSignal => ({
  id: sid(),
  prospectId,
  kind: 'note',
  source: { type: 'provider', provider: 'apollo' },
  observedAt: at(minutes),
  recordedAt: at(minutes),
  expiresAt: at(expires),
  detail: { text: `note ${minutes}` },
})

describe.each(signalStores)('signal store (%s)', (_name, store) => {
  test('records once per id and per event id, and a second Organization sees nothing', async () => {
    const org = newOrganizationId()
    const prospect = formatId('prs', crypto.randomUUID())
    const hook = (m: number) => ({
      ...signal(prospect, m, 100),
      source: { type: 'webhook' } as const,
    })
    const first = hook(1)
    expect((await store.record(org, first, 'evt_12345678')).duplicate).toBe(false)
    const again = await store.record(org, hook(2), 'evt_12345678')
    expect([again.duplicate, again.signal.id]).toEqual([true, first.id])
    expect((await store.record(org, first, 'evt_12345678')).duplicate).toBe(true)
    expect(await store.get(newOrganizationId(), first.id)).toBeNull()
    expect((await store.get(org, first.id))?.detail).toEqual({ text: 'note 1' })
  })

  test('lists newest first with a cursor and leaves out expired ones when asked', async () => {
    const org = newOrganizationId()
    const prospect = formatId('prs', crypto.randomUUID())
    for (const [m, e] of [
      [1, 5],
      [2, 100],
      [3, 100],
    ] as const) {
      await store.record(org, signal(prospect, m, e), null)
    }
    const filter = { expiresAfter: at(50), after: null, limit: 1 }
    const one = await store.list(org, prospect, filter)
    expect(one.items.map((s) => s.detail.text)).toEqual(['note 3'])
    const two = await store.list(org, prospect, { ...filter, after: one.next })
    expect(two.items.map((s) => s.detail.text)).toEqual(['note 2'])
    const all = await store.list(org, prospect, { expiresAfter: null, after: null, limit: 10 })
    expect(all.items.length).toBe(3)
    expect(all.next).toBeNull()
  })

  test('settings are versioned and the webhook secret is replaced', async () => {
    const org = newOrganizationId()
    expect((await store.settings(org)).version).toBe(0)
    const kinds: SignalKindSetting[] = [{ kind: 'note', enabled: false, freshnessDays: 7 }]
    const saved = await store.saveSettings(org, kinds, 0, at(1))
    expect([saved.version, saved.kinds]).toEqual([1, kinds])
    await expect(store.saveSettings(org, kinds, 0, at(2))).rejects.toBeInstanceOf(
      SettingsVersionConflictError
    )
    const sealed = { keyId: 'k1', ciphertext: new Uint8Array([1, 2, 3]) } as never
    await store.setWebhookSecret(org, sealed, at(3))
    const after = await store.settings(org)
    expect(after.webhook.sealed).not.toBeNull()
    expect(after.webhook.rotatedAt).toBe(at(3))
    expect(after.kinds).toEqual(kinds)
  })
})

let seq = 0
const criterion = (name: string, weight = 10): FitCriterion => ({
  id: formatId('fcr', crypto.randomUUID().replaceAll('-', '')),
  name,
  field: 'industry',
  condition: { operator: 'one_of', values: ['SaaS'] },
  weight,
  enabled: true,
  createdAt: new Date(Date.now() + seq++).toISOString(),
  updatedAt: new Date().toISOString(),
})
const score = (prospectId: string, value: number): FitScore => ({
  prospectId: prospectId as ProspectId,
  score: value,
  maxScore: 100,
  matches: [],
  criteriaVersion: 1,
  scoredAt: at(1),
})

describe.each(fitStores)('fit store (%s)', (_name, store) => {
  test('criteria keep unique names, a version that rises, and page oldest first', async () => {
    const org = newOrganizationId()
    expect((await store.enabled(org)).criteriaVersion).toBe(0)
    const a = criterion('Alpha')
    await store.create(org, a)
    await expect(store.create(org, criterion('ALPHA'))).rejects.toBeInstanceOf(
      CriterionRefusedError
    )
    await store.create(org, criterion('Beta'))
    expect((await store.byName(org, 'alpha'))?.id).toBe(a.id)
    const page = await store.list(org, null, 1)
    expect(page.items.map((c) => c.name)).toEqual(['Alpha'])
    expect(page.criteriaVersion).toBe(2)
    const updated = await store.update(org, a.id, (c) => ({ ...c, enabled: false }))
    expect(updated?.enabled).toBe(false)
    expect((await store.enabled(org)).criteria.map((c) => c.name)).toEqual(['Beta'])
    expect(await store.remove(org, a.id)).toBe(true)
    expect(await store.remove(org, a.id)).toBe(false)
    expect((await store.list(newOrganizationId(), null, 10)).items).toEqual([])
  })

  test('a saved score returns the one it replaced and lists highest first', async () => {
    const org = newOrganizationId()
    const [p1, p2] = [formatId('prs', crypto.randomUUID()), formatId('prs', crypto.randomUUID())]
    expect(await store.saveScore(org, score(p1, 10))).toBeNull()
    expect(await store.saveScore(org, score(p1, 30))).toBe(10)
    await store.saveScore(org, score(p2, 20))
    const all = await store.listScores(org, { minScore: 0, after: null, limit: 1 })
    expect(all.items.map((s) => s.score)).toEqual([30])
    const rest = await store.listScores(org, { minScore: 0, after: all.next, limit: 5 })
    expect(rest.items.map((s) => s.score)).toEqual([20])
    expect(
      (await store.listScores(org, { minScore: 25, after: null, limit: 5 })).items.length
    ).toBe(1)
    expect((await store.score(org, p1))?.score).toBe(30)
  })
})
