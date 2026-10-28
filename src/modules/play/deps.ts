import type { Clock, Logger } from 'tula-closeline-kit'
import type { ResearchDeps } from '~/modules/research/deps'
import type { PlayStore } from '~/ports/play-store'

/** What the play module needs from outside the process; the model, Playbook search and limits are the research module's. */
export type PlayDeps = {
  store: PlayStore
  research: ResearchDeps
  clock: Clock
  logger: Logger
}
