import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { formatId } from 'tula-closeline-contract'
import { describeSecretBox } from '~/ports/secret-box.behaviour'
import {
  createLocalKeySecretBox,
  createUnconfiguredSecretBox,
  SecretBoxUnconfiguredError,
} from './secret-box'

describeSecretBox('local key', () => createLocalKeySecretBox(randomBytes(32).toString('base64')))

describe('local-key secret box', () => {
  test('a value sealed under one key does not open under another', async () => {
    const context = {
      organizationId: formatId('org', crypto.randomUUID()),
      mailboxId: formatId('mbx', crypto.randomUUID()),
      purpose: 'access_token' as const,
    }
    const one = createLocalKeySecretBox(randomBytes(32).toString('base64'))
    const two = createLocalKeySecretBox(randomBytes(32).toString('base64'))
    const sealed = await one.seal('token', context)
    await expect(two.open(sealed, context)).rejects.toThrow()
  })

  test('refuses a key that is not 32 bytes', () => {
    expect(() => createLocalKeySecretBox(randomBytes(16).toString('base64'))).toThrow()
  })

  test('the unconfigured box says so and seals nothing', async () => {
    const box = createUnconfiguredSecretBox()
    expect(box.configured).toBe(false)
    const context = {
      organizationId: formatId('org', crypto.randomUUID()),
      mailboxId: formatId('mbx', crypto.randomUUID()),
      purpose: 'access_token' as const,
    }
    await expect(box.seal('x', context)).rejects.toBeInstanceOf(SecretBoxUnconfiguredError)
  })
})
