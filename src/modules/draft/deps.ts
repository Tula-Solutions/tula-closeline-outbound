import type { Clock, Logger } from 'tula-closeline-kit'
import type { ResearchDeps } from '~/modules/research/deps'
import type { BrandVoiceStore } from '~/ports/brand-voice-store'
import type { DraftStore } from '~/ports/draft-store'

/**
 * What the draft module needs from outside the process; a service function takes this first. The
 * model, Playbook, core and limits are the research module's: a Draft rests on the same Brief.
 */
export type DraftDeps = {
  store: DraftStore
  voices: BrandVoiceStore
  research: ResearchDeps
  clock: Clock
  logger: Logger
}
