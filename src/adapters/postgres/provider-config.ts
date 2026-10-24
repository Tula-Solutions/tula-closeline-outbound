import { asc, eq } from 'drizzle-orm'
import { providerKeySchema } from 'tula-closeline-contract'
import { providerSettings } from 'tula-closeline-db/schema'
import type { InOrganization } from '~/adapters/postgres/store'
import type { CredentialVault, ProviderConfig } from '~/ports/provider-config'

/** The most providers one Organization has set up (the db library's bound). */
const MAX_PROVIDERS = 50

/**
 * The Organization's provider settings from Postgres, with each credential opened through the
 * vault. A credential the vault cannot open reads as no key, so that provider is skipped.
 */
export function createPostgresProviderConfig(
  inOrganization: InOrganization,
  vault: CredentialVault
): ProviderConfig {
  return {
    async list(organizationId) {
      const rows = await inOrganization(organizationId, (tx) =>
        tx
          .select()
          .from(providerSettings)
          .where(eq(providerSettings.organizationId, organizationId))
          .orderBy(asc(providerSettings.provider))
          .limit(MAX_PROVIDERS)
      )
      return Promise.all(
        rows.map(async (row) => ({
          provider: providerKeySchema.parse(row.provider),
          enabled: row.enabled,
          apiKey:
            row.credentialCiphertext === null || row.credentialKeyId === null
              ? null
              : await vault.open({
                  ciphertext: row.credentialCiphertext,
                  keyId: row.credentialKeyId,
                }),
          positions: {
            person: row.personPosition,
            company: row.companyPosition,
            emailVerification: row.emailVerificationPosition,
          },
        }))
      )
    },
  }
}
