import type { Clock } from 'tula-closeline-kit'
import type { CoreAccess, CoreProspects } from '~/ports/core'
import type { SecretBox } from '~/ports/secret-box'
import type { SignalStore } from '~/ports/signal-store'

/** An event this repo publishes about Signals and fit; only ids and numbers, never text. */
export type SignalEvent =
  | {
      name: 'signal.recorded'
      payload: {
        signalId: string
        prospectId: string
        kind: string
        observedAt: string
        recordedAt: string
      }
    }
  | {
      name: 'prospect.fit_changed'
      payload: {
        prospectId: string
        previousScore: number | null
        score: number
        maxScore: number
        criteriaVersion: number
        changedAt: string
      }
    }

/** What the signal module needs from outside the process; a service function takes this first. */
export type SignalDeps = {
  store: SignalStore
  core: CoreProspects
  access: CoreAccess
  /** Seals the webhook signing secret. */
  secretBox: SecretBox
  clock: Clock
  /** Publishes an event for the Organization. */
  events: (organizationId: string, event: SignalEvent) => Promise<void>
}
