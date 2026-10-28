import { asc, eq, sql } from 'drizzle-orm'
import { type OrganizationId, providerKeySchema } from 'tula-closeline-contract'
import { providerSettings } from 'tula-closeline-db/schema'
import type { InOrganization } from '~/adapters/postgres/store'
import {
  type CredentialVault,
  orderOf,
  type ProviderConfig,
  type StoredProvider,
  versionOf,
} from '~/ports/provider-config'

/** The most providers one Organization has set up (the db library's bound). */
const MAX_PROVIDERS = 50

type Row = typeof providerSettings.$inferSelect

function storedOf(row: Row): StoredProvider {
  return {
    provider: providerKeySchema.parse(row.provider),
    enabled: row.enabled,
    credentialSet: row.credentialCiphertext !== null,
    credentialUpdatedAt: row.credentialUpdatedAt?.toISOString() ?? null,
    positions: {
      person: row.personPosition,
      company: row.companyPosition,
      emailVerification: row.emailVerificationPosition,
    },
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * The Organization's provider settings from Postgres, with each credential opened through the
 * vault. A credential the vault cannot open reads as no key, so that provider is skipped.
 */
export function createPostgresProviderConfig(
  inOrganization: InOrganization,
  vault: CredentialVault
): ProviderConfig {
  const select = (tx: Parameters<Parameters<InOrganization>[1]>[0], organizationId: string) =>
    tx
      .select()
      .from(providerSettings)
      .where(eq(providerSettings.organizationId, organizationId))
      .orderBy(asc(providerSettings.provider))
      .limit(MAX_PROVIDERS)
  return {
    async list(organizationId) {
      const rows = await inOrganization(organizationId, (tx) => select(tx, organizationId))
      return Promise.all(
        rows.map(async (row) => ({
          provider: providerKeySchema.parse(row.provider),
          enabled: row.enabled,
          apiKey:
            row.credentialCiphertext === null || row.credentialKeyId === null
              ? null
              : await vault.open({
                  organizationId: organizationId as OrganizationId,
                  provider: providerKeySchema.parse(row.provider),
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
    async listStored(organizationId) {
      const rows = await inOrganization(organizationId, (tx) => select(tx, organizationId))
      return rows.map(storedOf)
    },
    async save(organizationId, provider, change, at) {
      return inOrganization(organizationId, async (tx) => {
        const credential =
          change.credential === undefined
            ? {}
            : change.credential === null
              ? { credentialCiphertext: null, credentialKeyId: null, credentialUpdatedAt: null }
              : {
                  credentialCiphertext: change.credential.ciphertext,
                  credentialKeyId: change.credential.keyId,
                  credentialUpdatedAt: at,
                }
        const [row] = await tx
          .insert(providerSettings)
          .values({
            organizationId,
            provider,
            enabled: change.enabled,
            updatedAt: at,
            ...credential,
          })
          .onConflictDoUpdate({
            target: [providerSettings.organizationId, providerSettings.provider],
            set: { enabled: change.enabled, updatedAt: at, ...credential },
          })
          .returning()
        if (row === undefined) {
          throw new Error('provider setting was not saved')
        }
        return storedOf(row)
      })
    },
    async setOrder(organizationId, order, expectedVersion, at) {
      return inOrganization(organizationId, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))`)
        const current = (await select(tx, organizationId)).map(storedOf)
        const same = JSON.stringify(orderOf(current)) === JSON.stringify(order)
        if (same) {
          return current
        }
        if (versionOf(current) !== expectedVersion) {
          return null
        }
        const named = new Set([...order.person, ...order.company, ...order.email_verification])
        const known = new Set(current.map((row) => row.provider))
        const all = [...new Set([...known, ...named])]
        const at3 = (list: readonly string[], p: string) =>
          list.includes(p) ? list.indexOf(p) : null
        for (const provider of all) {
          const positions = {
            personPosition: at3(order.person, provider),
            companyPosition: at3(order.company, provider),
            emailVerificationPosition: at3(order.email_verification, provider),
          }
          await tx
            .insert(providerSettings)
            .values({ organizationId, provider, updatedAt: at, ...positions })
            .onConflictDoUpdate({
              target: [providerSettings.organizationId, providerSettings.provider],
              set: { updatedAt: at, ...positions },
            })
        }
        return (await select(tx, organizationId)).map(storedOf)
      })
    },
  }
}
