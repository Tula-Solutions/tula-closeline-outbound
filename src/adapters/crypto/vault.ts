import type { OrganizationId } from 'tula-closeline-contract'
import type { CredentialVault } from '~/ports/provider-config'
import type { SecretBox } from '~/ports/secret-box'

/** A credential vault over the secret box: a key is bound to its Organization and provider. */
export function createSecretBoxVault(box: SecretBox): CredentialVault {
  const context = (c: { organizationId: OrganizationId; provider: string }) => ({
    organizationId: c.organizationId,
    mailboxId: c.provider,
    purpose: 'provider_key' as const,
  })
  return {
    configured: box.configured,
    async open(c) {
      try {
        return await box.open({ ciphertext: c.ciphertext, keyId: c.keyId }, context(c))
      } catch {
        return null
      }
    },
    async seal(c) {
      return box.seal(c.plaintext, context(c))
    },
  }
}
