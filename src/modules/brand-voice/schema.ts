import { z } from 'zod'

/**
 * The body of `PUT /v1/brand-voice` as the router checks it: only the version the caller read.
 * The settings are checked by the service against the contract's schema so that an empty or
 * oversized value answers `voice.invalid`, not `request.invalid`.
 */
export const setVoiceBodySchema = z.looseObject({ expectedVersion: z.number().int().min(0) }).meta({
  description:
    'The Brand Voice settings (tone, preferredWords, bannedPhrases, signOff, maxLengthCharacters) and expectedVersion.',
})
