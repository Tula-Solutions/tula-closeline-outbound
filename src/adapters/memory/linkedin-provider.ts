import type { Clock } from 'tula-closeline-kit'
import {
  type LinkedInProvider,
  LinkedInProviderError,
  type ProviderAccountStatus,
} from '~/ports/linkedin-provider'

const LOGIN_TTL_MS = 600_000

/** The memory provider, with what a test needs to play the Rep and the provider. */
export type MemoryLinkedInProvider = LinkedInProvider & {
  /** Plays the Rep finishing the hosted login: the account now exists and is connected. Returns its reference. */
  completeLogin: (hostedLoginUrl: string) => string
  /** Sets what the provider reports for an account. */
  setStatus: (accountRef: string, status: ProviderAccountStatus) => void
  /** Makes every call fail as `unavailable` while set. */
  setDown: (down: boolean) => void
  /** The references removed at the provider, in order. */
  removed: () => readonly string[]
}

/** An in-process {@link LinkedInProvider} for tests; scripts what the real one would answer. */
export function createMemoryLinkedInProvider(clock: Clock): MemoryLinkedInProvider {
  const logins = new Map<string, { url: string; expiresAt: string; ref: string }>()
  const byUrl = new Map<string, string>()
  const statuses = new Map<string, ProviderAccountStatus>()
  const removed: string[] = []
  let down = false
  const guard = () => {
    if (down) {
      throw new LinkedInProviderError('unavailable')
    }
  }

  return {
    async startConnection({ organizationId, membershipId, idempotencyKey }) {
      guard()
      const k = `${organizationId}/${membershipId}/${idempotencyKey}`
      let login = logins.get(k)
      if (login === undefined) {
        const id = crypto.randomUUID()
        login = {
          url: `https://linkedin.memory.test/login/${id}`,
          expiresAt: new Date(clock.now().getTime() + LOGIN_TTL_MS).toISOString(),
          ref: `memory-account-${id}`,
        }
        logins.set(k, login)
        byUrl.set(login.url, login.ref)
      }
      return { hostedLoginUrl: login.url, expiresAt: login.expiresAt }
    },

    async readAccount(accountRef) {
      guard()
      return { status: statuses.get(accountRef) ?? 'disconnected' }
    },

    async disconnect(accountRef) {
      guard()
      statuses.set(accountRef, 'disconnected')
      removed.push(accountRef)
    },

    completeLogin(hostedLoginUrl) {
      const ref = byUrl.get(hostedLoginUrl)
      if (ref === undefined) {
        throw new Error('no such hosted login')
      }
      statuses.set(ref, 'connected')
      return ref
    },

    setStatus: (accountRef, status) => void statuses.set(accountRef, status),
    setDown: (value) => {
      down = value
    },
    removed: () => removed,
  }
}
