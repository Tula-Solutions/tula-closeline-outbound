import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { SealedSecret, SecretBox, SecretContext } from '~/ports/secret-box'

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/** Thrown when a sealed value does not open: wrong key, wrong context or altered bytes. */
export class SecretBoxOpenError extends Error {
  constructor() {
    super('the sealed value could not be opened')
    this.name = 'SecretBoxOpenError'
  }
}

/** Thrown by the box that has no key service, so a caller answers "unavailable" instead of storing nothing. */
export class SecretBoxUnconfiguredError extends Error {
  constructor() {
    super('no key service is configured to seal secrets')
    this.name = 'SecretBoxUnconfiguredError'
  }
}

/** What the box binds a value to, as bytes, in a fixed order. */
function contextBytes(context: SecretContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      context.organizationId,
      'mailboxId' in context ? context.mailboxId : null,
      context.purpose,
    ]),
    'utf8'
  )
}

/**
 * AES-256-GCM under `key` with the context as additional authenticated data. The ciphertext is
 * the 12-byte IV, the body, then the 16-byte tag. `keyId` names the key without revealing it.
 */
export function createAesSecretBox(key: Uint8Array, keyId: string): SecretBox {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error('a secret box needs a 32-byte key')
  }
  return {
    configured: true,
    async seal(plaintext, context): Promise<SealedSecret> {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(contextBytes(context))
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return { keyId, ciphertext: new Uint8Array(Buffer.concat([iv, body, cipher.getAuthTag()])) }
    },
    async open(sealed, context): Promise<string> {
      if (sealed.keyId !== keyId || sealed.ciphertext.byteLength < IV_BYTES + TAG_BYTES) {
        throw new SecretBoxOpenError()
      }
      const bytes = Buffer.from(sealed.ciphertext)
      const iv = bytes.subarray(0, IV_BYTES)
      const tag = bytes.subarray(bytes.length - TAG_BYTES)
      const body = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(contextBytes(context))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        throw new SecretBoxOpenError()
      }
    },
  }
}

/** The key id of a local key: a short digest, so two keys never share an id and the key stays secret. */
function localKeyId(key: Uint8Array): string {
  return `local-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
}

/**
 * The local-key adapter (ADR 0022): AES-256-GCM under a key given as base64 of 32 bytes. It is for
 * `local` and `dev`; the env schema refuses it in staging and prod, where AWS KMS replaces it.
 */
export function createLocalKeySecretBox(base64Key: string): SecretBox {
  const key = new Uint8Array(Buffer.from(base64Key, 'base64'))
  return createAesSecretBox(key, localKeyId(key))
}

/** A box with no key service: `configured` is false and sealing or opening throws. */
export function createUnconfiguredSecretBox(): SecretBox {
  return {
    configured: false,
    async seal(): Promise<SealedSecret> {
      throw new SecretBoxUnconfiguredError()
    },
    async open(): Promise<string> {
      throw new SecretBoxUnconfiguredError()
    },
  }
}
