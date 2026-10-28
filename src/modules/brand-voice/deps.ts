import type { Clock } from 'tula-closeline-kit'
import type { BrandVoiceStore } from '~/ports/brand-voice-store'
import type { CoreAccess } from '~/ports/core'

/** What the brand-voice module needs from outside the process; a service function takes this first. */
export type BrandVoiceDeps = {
  store: BrandVoiceStore
  /** Maps the caller to the Membership recorded as the author of a version. */
  access: CoreAccess
  clock: Clock
}
