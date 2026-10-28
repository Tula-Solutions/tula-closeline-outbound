import type { OrganizationId, ProviderKey } from 'tula-closeline-contract'
import {
  type CredentialVault,
  orderOf,
  type ProviderConfig,
  type ProviderSetting,
  type SealedCredential,
  type StoredProvider,
  versionOf,
} from '~/ports/provider-config'

/** A stored provider plus its key: given plain by `set`, or sealed by `save` and opened on read. */
type Row = StoredProvider & { apiKey: string | null; sealed: SealedCredential | null }

/** Provider settings in process memory, with a way for tests to set them. */
export function createMemoryProviderConfig(vault?: CredentialVault): ProviderConfig & {
  /** Replaces the Organization's settings. */
  set: (organizationId: OrganizationId, settings: readonly ProviderSetting[]) => void
} {
  const byOrganization = new Map<string, Map<string, Row>>()
  const rowsOf = (organizationId: OrganizationId) => {
    let rows = byOrganization.get(organizationId)
    if (rows === undefined) {
      rows = new Map()
      byOrganization.set(organizationId, rows)
    }
    return rows
  }
  const stored = (organizationId: OrganizationId): StoredProvider[] =>
    [...rowsOf(organizationId).values()]
      .sort((a, b) => a.provider.localeCompare(b.provider))
      .map(({ apiKey: _key, sealed: _sealed, ...row }) => row)
  return {
    set(organizationId, settings) {
      const rows = new Map<string, Row>()
      for (const s of settings) {
        rows.set(s.provider, {
          provider: s.provider,
          enabled: s.enabled,
          apiKey: s.apiKey,
          sealed: null,
          credentialSet: s.apiKey !== null,
          credentialUpdatedAt: null,
          positions: s.positions,
          updatedAt: null,
        })
      }
      byOrganization.set(organizationId, rows)
    },
    async list(organizationId) {
      return Promise.all(
        [...rowsOf(organizationId).values()].map(async (row) => ({
          provider: row.provider,
          enabled: row.enabled,
          apiKey:
            row.sealed !== null && vault !== undefined
              ? await vault.open({ organizationId, provider: row.provider, ...row.sealed })
              : row.apiKey,
          positions: row.positions,
        }))
      )
    },
    async listStored(organizationId) {
      return stored(organizationId)
    },
    async save(organizationId, provider, change, at) {
      const rows = rowsOf(organizationId)
      const row: Row = rows.get(provider) ?? blank(provider)
      row.enabled = change.enabled
      if (change.credential !== undefined) {
        row.sealed = change.credential
        row.apiKey = null
        row.credentialSet = change.credential !== null
        row.credentialUpdatedAt = at.toISOString()
      }
      row.updatedAt = at.toISOString()
      rows.set(provider, row)
      const { apiKey: _key, sealed: _sealed, ...out } = row
      return out
    },
    async setOrder(organizationId, order, expectedVersion, at) {
      const current = stored(organizationId)
      const same = JSON.stringify(orderOf(current)) === JSON.stringify(order)
      if (!same && versionOf(current) !== expectedVersion) {
        return null
      }
      const rows = rowsOf(organizationId)
      for (const provider of new Set([
        ...order.person,
        ...order.company,
        ...order.email_verification,
      ])) {
        if (!rows.has(provider)) {
          rows.set(provider, blank(provider))
        }
      }
      const at3 = (list: readonly ProviderKey[], p: ProviderKey) =>
        list.includes(p) ? list.indexOf(p) : null
      for (const row of rows.values()) {
        row.positions = {
          person: at3(order.person, row.provider),
          company: at3(order.company, row.provider),
          emailVerification: at3(order.email_verification, row.provider),
        }
        row.updatedAt = at.toISOString()
      }
      return stored(organizationId)
    },
  }
}

function blank(provider: ProviderKey): Row {
  return {
    provider,
    enabled: true,
    apiKey: null,
    sealed: null,
    credentialSet: false,
    credentialUpdatedAt: null,
    positions: { person: null, company: null, emailVerification: null },
    updatedAt: null,
  }
}
