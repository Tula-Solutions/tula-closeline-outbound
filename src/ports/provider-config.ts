import type { FieldGroup, OrganizationId, ProviderKey } from 'tula-closeline-contract'

/** One provider as an Organization has set it up. */
export type ProviderSetting = {
  provider: ProviderKey
  enabled: boolean
  /** The decrypted key, or null when none is stored or it cannot be opened. Never logged. */
  apiKey: string | null
  /** Position in the Organization's waterfall per group; null sorts last. */
  positions: { person: number | null; company: number | null; emailVerification: number | null }
}

/** One provider as stored, for a settings read: whether a key is stored, never the key. */
export type StoredProvider = {
  provider: ProviderKey
  enabled: boolean
  credentialSet: boolean
  credentialUpdatedAt: string | null
  positions: ProviderSetting['positions']
  updatedAt: string | null
}

/** A sealed credential as the database holds it. */
export type SealedCredential = { ciphertext: Uint8Array; keyId: string }

/** The provider order per group, first to last. */
export type WaterfallOrder = Record<FieldGroup, readonly ProviderKey[]>

const POSITION_OF: Record<FieldGroup, keyof ProviderSetting['positions']> = {
  person: 'person',
  company: 'company',
  email_verification: 'emailVerification',
}

/** The stored order per group: providers with a position, by position then key. */
export function orderOf(rows: readonly StoredProvider[]): WaterfallOrder {
  const order = (group: FieldGroup) =>
    rows
      .filter((row) => row.positions[POSITION_OF[group]] !== null)
      .sort(
        (a, b) =>
          (a.positions[POSITION_OF[group]] as number) -
            (b.positions[POSITION_OF[group]] as number) || a.provider.localeCompare(b.provider)
      )
      .map((row) => row.provider)
  return {
    person: order('person'),
    company: order('company'),
    email_verification: order('email_verification'),
  }
}

/**
 * The order's version: 0 while no order is stored (the default), else a digest of the order, so a
 * stale `expectedVersion` fails. The database has no version column; a collision needs a different
 * order to hash alike (1 in a million), and then the write is still a valid order.
 */
export function versionOf(rows: readonly StoredProvider[]): number {
  const order = orderOf(rows)
  const text = JSON.stringify(order)
  if (order.person.length + order.company.length + order.email_verification.length === 0) {
    return 0
  }
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  }
  return 1 + (hash % 1_000_000)
}

/** The Organization's provider settings, with credentials already opened. */
export type ProviderConfig = {
  /** Every provider the Organization has set up, at most 50. */
  list: (organizationId: OrganizationId) => Promise<readonly ProviderSetting[]>
  /** The same providers without any key, for a settings read. */
  listStored: (organizationId: OrganizationId) => Promise<readonly StoredProvider[]>
  /**
   * Switches a provider on or off and, when `credential` is given, stores it (null removes it);
   * left out keeps the stored one. Creates the setting when there is none.
   */
  save: (
    organizationId: OrganizationId,
    provider: ProviderKey,
    change: { enabled: boolean; credential?: SealedCredential | null },
    at: Date
  ) => Promise<StoredProvider>
  /**
   * Stores the order for every group at once (a provider in none gets no position) if `expectedVersion`
   * is still the current version or the order is already the requested one; null means it was stale.
   */
  setOrder: (
    organizationId: OrganizationId,
    order: WaterfallOrder,
    expectedVersion: number,
    at: Date
  ) => Promise<readonly StoredProvider[] | null>
}

/** Opens and seals a stored provider credential. The key management design lives behind this port. */
export type CredentialVault = {
  /** False when no key service is configured, so a key cannot be stored. */
  readonly configured: boolean
  /** The plain key for the ciphertext, or null when it cannot be opened. */
  open: (credential: {
    organizationId: OrganizationId
    provider: ProviderKey
    ciphertext: Uint8Array
    keyId: string
  }) => Promise<string | null>
  /** Seals a key, bound to the Organization and provider. */
  seal: (credential: {
    organizationId: OrganizationId
    provider: ProviderKey
    plaintext: string
  }) => Promise<SealedCredential>
}
