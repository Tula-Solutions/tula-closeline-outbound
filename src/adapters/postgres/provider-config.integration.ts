import { afterAll, describe, expect, test } from 'bun:test'
import type { ProviderKey } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createSecretBoxVault } from '~/adapters/crypto/vault'
import { createMemoryProviderConfig } from '~/adapters/memory/provider-config'
import { createMemorySecretBox } from '~/adapters/memory/secret-box'
import { integrationUrls } from '~/integration-support'
import type { ProviderConfig } from '~/ports/provider-config'
import { newOrganizationId } from '~/testing'
import { createPostgresProviderConfig } from './provider-config'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

const vault = createSecretBoxVault(createMemorySecretBox())
const key = (name: string) => name as ProviderKey
const at = new Date('2026-01-01T00:00:00Z')
const order = (person: string[]) => ({
  person: person.map(key),
  company: [],
  email_verification: [key('zerobounce')],
})

const configs: [string, ProviderConfig][] = [
  ['memory', createMemoryProviderConfig(vault)],
  [
    'postgres',
    createPostgresProviderConfig(
      (organizationId, fn) => withOrganization(database.db, organizationId, fn),
      vault
    ),
  ],
]

describe.each(configs)('provider config (%s)', (_name, config) => {
  test('saves a sealed key that opens only for its own Organization and provider', async () => {
    const org = newOrganizationId()
    const sealed = await vault.seal({
      organizationId: org,
      provider: key('apollo'),
      plaintext: 'secret-key-0123456789',
    })
    const row = await config.save(org, key('apollo'), { enabled: true, credential: sealed }, at)
    expect(row).toMatchObject({ provider: 'apollo', enabled: true, credentialSet: true })
    expect(JSON.stringify(row)).not.toContain('secret-key')
    expect((await config.list(org)).map((s) => [s.provider, s.apiKey])).toEqual([
      ['apollo', 'secret-key-0123456789'],
    ])
    expect(await config.list(newOrganizationId())).toEqual([])
    // Left out keeps the key; null removes it.
    await config.save(org, key('apollo'), { enabled: false }, at)
    expect((await config.list(org))[0]).toMatchObject({
      enabled: false,
      apiKey: 'secret-key-0123456789',
    })
    await config.save(org, key('apollo'), { enabled: false, credential: null }, at)
    expect((await config.list(org))[0]?.apiKey).toBeNull()
  })

  test('sets the order against a version, answers null when stale, accepts a replay', async () => {
    const org = newOrganizationId()
    await config.save(org, key('apollo'), { enabled: true }, at)
    expect(await config.setOrder(org, order(['apollo']), 0, at)).not.toBeNull()
    expect(await config.setOrder(org, order(['apollo']), 0, at)).not.toBeNull()
    expect(await config.setOrder(org, order([]), 0, at)).toBeNull()
    const rows = await config.listStored(org)
    expect(rows.find((r) => r.provider === 'apollo')?.positions.person).toBe(0)
  })

  test('an Organization never sees another one order', async () => {
    const a = newOrganizationId()
    await config.setOrder(a, order(['apollo']), 0, at)
    expect(await config.listStored(newOrganizationId())).toEqual([])
  })
})
