import type { MailboxId, OrganizationId } from 'tula-closeline-contract'

/** The longest key id the database accepts, in characters. */
export const MAX_SECRET_KEY_ID_LENGTH = 128

/** The largest sealed token the database accepts, in bytes. */
export const MAX_SEALED_SECRET_BYTES = 8192

/**
 * What a sealed value is bound to. It is authenticated with the ciphertext but never stored with
 * it, so a sealed token copied to another Mailbox, Organization or purpose does not open.
 */
export type SecretContext =
  | {
      organizationId: OrganizationId
      /** The Mailbox id, or the provider key for a provider credential. */
      mailboxId: MailboxId | string
      purpose: 'access_token' | 'refresh_token' | 'provider_key'
    }
  | { organizationId: OrganizationId; purpose: 'signal_webhook_secret' }

/** A value after sealing: which key sealed it, and the opaque bytes to store. */
export type SealedSecret = {
  keyId: string
  ciphertext: Uint8Array
}

/**
 * Seals and opens Mailbox tokens so the database never holds one in the clear (ADR 0022). The
 * production adapter is AWS KMS and comes with infra; the local-key and memory adapters are for
 * `local` and `dev` and tests.
 */
export interface SecretBox {
  /** False when no key service is configured, so a caller can refuse before it spends a single-use code. */
  readonly configured: boolean
  /** Seals `plaintext`, bound to `context`. */
  seal(plaintext: string, context: SecretContext): Promise<SealedSecret>
  /** Opens a sealed value; rejects when the bytes, the key id or `context` do not match what sealed it. */
  open(sealed: SealedSecret, context: SecretContext): Promise<string>
}
