import type { DraftSource } from '~/ports/engine'
import type { DraftDeps } from './deps'
import * as Drafts from './service'

/** The engine's Draft source over the drafting module. */
export function createDraftSource(deps: DraftDeps): DraftSource {
  return {
    obtain: (organizationId, request) => Drafts.obtainForStep(deps, organizationId, request),
  }
}
