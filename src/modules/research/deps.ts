import type { Clock, Logger } from 'tula-closeline-kit'
import type { SignalDeps } from '~/modules/signal/deps'
import type { BriefStore } from '~/ports/brief-store'
import type { CoreAccess, CoreProspects } from '~/ports/core'
import type { Model } from '~/ports/model'
import type { PlaybookSearch } from '~/ports/playbook-search'
import type { WebSearch } from '~/ports/web-search'

/** The time and retry bounds of building a Research Brief, from the environment. */
export type ResearchLimits = {
  webDeadlineMs: number
  modelTimeoutMs: number
  briefTtlMs: number
}

/** Longest the model adapter may take: every try's timeout plus every backoff at maximum jitter. */
function adapterWorstCaseMs(env: {
  AI_CALL_TIMEOUT_MS: number
  AI_CALL_MAX_TRIES: number
  AI_RETRY_BASE_MS: number
}): number {
  let total = env.AI_CALL_TIMEOUT_MS * env.AI_CALL_MAX_TRIES
  for (let attempt = 2; attempt <= env.AI_CALL_MAX_TRIES; attempt++) {
    total += env.AI_RETRY_BASE_MS * 2 ** (attempt - 2) * 1.5
  }
  return total
}

/** The research limits from the validated environment. */
export function researchLimits(env: {
  RESEARCH_WEB_DEADLINE_MS: number
  RESEARCH_MODEL_TIMEOUT_MS: number
  AI_CALL_TIMEOUT_MS: number
  AI_CALL_MAX_TRIES: number
  AI_RETRY_BASE_MS: number
  RESEARCH_BRIEF_TTL_SECONDS: number
}): ResearchLimits {
  return {
    webDeadlineMs: env.RESEARCH_WEB_DEADLINE_MS,
    modelTimeoutMs: Math.max(env.RESEARCH_MODEL_TIMEOUT_MS, adapterWorstCaseMs(env)),
    briefTtlMs: env.RESEARCH_BRIEF_TTL_SECONDS * 1000,
  }
}

/** What the research module needs from outside the process; a service function takes this first. */
export type ResearchDeps = {
  store: BriefStore
  core: CoreProspects
  access: CoreAccess
  /** Where the Prospect's fresh Signals are read from. */
  signals: SignalDeps
  /** Null outside `local` until a vendor is chosen: briefs then answer `draft.model_unavailable`. */
  model: Model | null
  /** Null means the web is skipped. */
  web: WebSearch | null
  /** Null means the Playbook is skipped. */
  playbook: PlaybookSearch | null
  clock: Clock
  logger: Logger
  limits: ResearchLimits
}
