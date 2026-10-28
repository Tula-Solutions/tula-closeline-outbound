import type { Clock, Logger, Queue } from 'tula-closeline-kit'
import type { OutboundEnvelope } from '~/messages'
import type { SendDeps } from '~/modules/send/deps'
import type { CampaignStore } from '~/ports/campaign-store'
import type { Approvals, DraftSource, ProspectContacts } from '~/ports/engine'
import type { EnrollmentStore } from '~/ports/enrollment-store'

/** What the Sequence engine needs from outside the process; a service function takes this first. */
export type EngineDeps = {
  enrollments: EnrollmentStore
  campaigns: CampaignStore
  /** The send pipeline; the engine adds nothing to its checks, it only asks for a decision. */
  send: SendDeps
  drafts: DraftSource
  approvals: Approvals
  contacts: ProspectContacts
  /** Carries one `enrollment.step` message per due Enrollment. */
  queue: Queue<OutboundEnvelope>
  clock: Clock
  /** Where a sweep starts walking the Organizations, so a backlog cannot starve later ones. */
  random: () => number
  logger: Logger
  limits: {
    /** Organizations one page of the sweep looks at. */
    orgBatch: number
    /** Enrollments one Organization yields per sweep. */
    stepPage: number
    /** How long a claimed Enrollment stays out of other sweeps. */
    leaseSeconds: number
  }
}
