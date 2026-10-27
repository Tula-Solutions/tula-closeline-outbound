import { randomBytes } from 'node:crypto'
import { createAesSecretBox } from '~/adapters/crypto/secret-box'
import type { SecretBox } from '~/ports/secret-box'

/** The id of the key a memory box seals under, so a test can show which key opened a value. */
export const MEMORY_SECRET_KEY_ID = 'memory-1'

/** A secret box for tests and `local`: AES-256-GCM under a key that exists only in this process. */
export function createMemorySecretBox(key: Uint8Array = randomBytes(32)): SecretBox {
  return createAesSecretBox(key, MEMORY_SECRET_KEY_ID)
}
