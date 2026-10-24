import type { OrganizationId, ProviderKey } from 'tula-closeline-contract'

/** One provider as an Organization has set it up. */
export type ProviderSetting = {
  provider: ProviderKey
  enabled: boolean
  /** The decrypted key, or null when none is stored or it cannot be opened. Never logged. */
  apiKey: string | null
  /** Position in the Organization's waterfall per group; null sorts last. */
  positions: { person: number | null; company: number | null; emailVerification: number | null }
}

/** The Organization's provider settings, with credentials already opened. */
export type ProviderConfig = {
  /** Every provider the Organization has set up, at most 50. */
  list: (organizationId: OrganizationId) => Promise<readonly ProviderSetting[]>
}

/** Opens a stored provider credential. The key management design lives behind this port. */
export type CredentialVault = {
  /** The plain key for the ciphertext, or null when it cannot be opened. */
  open: (credential: { ciphertext: Uint8Array; keyId: string }) => Promise<string | null>
}
