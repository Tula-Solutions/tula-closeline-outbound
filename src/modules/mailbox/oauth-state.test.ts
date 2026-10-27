import { expect, test } from 'bun:test'
import { formatId, type OrganizationId, type TeamId, type UserId } from 'tula-closeline-contract'
import {
  MAX_ATTEMPT_TEAMS,
  mailboxIdOf,
  newAttempt,
  signAttempt,
  verifyAttempt,
} from './oauth-state'

const SECRET = 'a'.repeat(40)
const owner = {
  organizationId: formatId('org', crypto.randomUUID()) as OrganizationId,
  userId: formatId('usr', crypto.randomUUID()) as UserId,
}
const teams = Array.from({ length: MAX_ATTEMPT_TEAMS }, () =>
  formatId('team', crypto.randomUUID())
) as TeamId[]
const input = { provider: 'gmail', kind: 'shared', teamIds: teams } as const

test('a signed attempt comes back whole and fits the state length', () => {
  const attempt = newAttempt(owner, 'key-1', input, 1_000_000)
  const state = signAttempt(SECRET, owner, attempt)
  expect(state.length).toBeLessThanOrEqual(256)
  expect(verifyAttempt(SECRET, owner, state, 1_000_001)).toEqual(attempt)
})

test('the same key in the same minute gives the same state, another key another', () => {
  const a = signAttempt(SECRET, owner, newAttempt(owner, 'k', input, 1_000_000))
  const b = signAttempt(SECRET, owner, newAttempt(owner, 'k', input, 1_000_010))
  const c = signAttempt(SECRET, owner, newAttempt(owner, 'other', input, 1_000_000))
  expect(a).toBe(b)
  expect(a).not.toBe(c)
})

test('forged, foreign, expired and malformed states are refused', () => {
  const attempt = newAttempt(owner, 'k', input, 1_000_000)
  const state = signAttempt(SECRET, owner, attempt)
  const flipped = `${state.slice(0, 10)}${state[10] === 'A' ? 'B' : 'A'}${state.slice(11)}`
  expect(verifyAttempt(SECRET, owner, flipped, 1_000_001)).toBeNull()
  expect(verifyAttempt('b'.repeat(40), owner, state, 1_000_001)).toBeNull()
  const other = { ...owner, userId: formatId('usr', crypto.randomUUID()) as UserId }
  expect(verifyAttempt(SECRET, other, state, 1_000_001)).toBeNull()
  const otherOrg = {
    ...owner,
    organizationId: formatId('org', crypto.randomUUID()) as OrganizationId,
  }
  expect(verifyAttempt(SECRET, otherOrg, state, 1_000_001)).toBeNull()
  expect(verifyAttempt(SECRET, owner, state, attempt.expiresAt + 1)).toBeNull()
  expect(verifyAttempt(SECRET, owner, 'short', 1_000_001)).toBeNull()
  expect(verifyAttempt(SECRET, owner, '!'.repeat(40), 1_000_001)).toBeNull()
})

test('the Mailbox id follows the attempt and the Organization', () => {
  const attempt = newAttempt(owner, 'k', input, 1_000_000)
  expect(mailboxIdOf(owner.organizationId, attempt.nonce)).toBe(
    mailboxIdOf(owner.organizationId, attempt.nonce)
  )
  expect(mailboxIdOf(owner.organizationId, attempt.nonce)).not.toBe(
    mailboxIdOf(formatId('org', crypto.randomUUID()) as OrganizationId, attempt.nonce)
  )
})
