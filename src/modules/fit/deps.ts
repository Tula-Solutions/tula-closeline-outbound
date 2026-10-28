import type { Clock } from 'tula-closeline-kit'
import type { SignalEvent } from '~/modules/signal/deps'
import type { CoreAccess, CoreProspects } from '~/ports/core'
import type { FitStore } from '~/ports/fit-store'

/** What the fit module needs from outside the process; a service function takes this first. */
export type FitDeps = {
  store: FitStore
  core: CoreProspects
  access: CoreAccess
  clock: Clock
  /** Publishes an event for the Organization. */
  events: (organizationId: string, event: SignalEvent) => Promise<void>
}
