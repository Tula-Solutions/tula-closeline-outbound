import {
  type BrandVoice,
  type BrandVoiceSettings,
  brandVoiceSettingsSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  MESSAGING_ERRORS,
  type OrganizationId,
  type Role,
  type UserId,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { domainError } from '~/http/domain-error'
import type { BrandVoiceDeps } from './deps'

/** The largest page a version list may ask for. */
export const MAX_PAGE = 100

/** Who is calling, as the verified token says. */
export type VoiceCaller = { userId: UserId; organizationId: OrganizationId; role: Role }

const cursorSchema = z.strictObject({ before: z.number().int().min(1).max(1_000_001) })

/** An id that is the same for the same Organization and version, so a racing save collides on it. */
function versionId(organizationId: string, version: number) {
  const hex = new Bun.CryptoHasher('sha256')
    .update(`${organizationId}:brand-voice:${version}`)
    .digest('hex')
    .slice(0, 32)
  return formatId('bvo', hex)
}

const invalid = () => domainError(MESSAGING_ERRORS['voice.invalid'])

/** The settings if they pass the contract's rules and no banned phrase is also preferred; else `voice.invalid`. */
function settingsOf(body: Record<string, unknown>): BrandVoiceSettings {
  const { expectedVersion: _ignored, ...rest } = body
  const parsed = brandVoiceSettingsSchema.safeParse(rest)
  if (!parsed.success) {
    throw invalid()
  }
  const preferred = new Set(parsed.data.preferredWords.map((word) => word.toLowerCase()))
  if (parsed.data.bannedPhrases.some((phrase) => preferred.has(phrase.toLowerCase()))) {
    throw invalid()
  }
  return parsed.data
}

/** Reads the current Brand Voice; `voice.not_found` when the Organization has none yet. */
export async function get(deps: BrandVoiceDeps, caller: VoiceCaller): Promise<BrandVoice> {
  const voice = await deps.store.current(caller.organizationId)
  if (voice === null) {
    throw domainError(MESSAGING_ERRORS['voice.not_found'])
  }
  return voice
}

/** Saves the settings as the next version, keeping every earlier one; a repeat of the last save answers it. */
export async function set(
  deps: BrandVoiceDeps,
  caller: VoiceCaller,
  body: { expectedVersion: number } & Record<string, unknown>
): Promise<BrandVoice> {
  const settings = settingsOf(body)
  const me = await deps.access.membershipIdOf(caller.organizationId, caller.userId)
  const now = deps.clock.now().toISOString()
  return deps.store.save(caller.organizationId, (current) => {
    const version = current?.version ?? 0
    // The same body again, as a client retries it, is the version already saved.
    if (
      current !== null &&
      (body.expectedVersion === version || body.expectedVersion === version - 1) &&
      Bun.deepEquals(settings, {
        tone: current.tone,
        preferredWords: current.preferredWords,
        bannedPhrases: current.bannedPhrases,
        signOff: current.signOff,
        maxLengthCharacters: current.maxLengthCharacters,
      })
    ) {
      return { kind: 'unchanged' }
    }
    if (body.expectedVersion !== version) {
      throw domainError(MESSAGING_ERRORS['voice.version_conflict'])
    }
    return {
      kind: 'save',
      voice: {
        ...settings,
        id: versionId(caller.organizationId, version + 1),
        version: version + 1,
        createdByMembershipId: me,
        createdAt: now,
      },
    }
  })
}

/** A newest-first page of the saved versions. */
export async function listVersions(
  deps: BrandVoiceDeps,
  caller: VoiceCaller,
  query: { cursor?: string | undefined; limit: number }
): Promise<{ items: BrandVoice[]; nextCursor: string | null }> {
  let before: number | null = null
  if (query.cursor !== undefined) {
    const position = decodeCursor(query.cursor, cursorSchema)
    if (position === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    before = position.before
  }
  const page = await deps.store.list(caller.organizationId, before, Math.min(query.limit, MAX_PAGE))
  return {
    items: page.items,
    nextCursor: page.next === null ? null : encodeCursor({ before: page.next }),
  }
}
