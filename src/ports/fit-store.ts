import type {
  FitCriterion,
  FitCriterionId,
  FitScore,
  OrganizationId,
} from 'tula-closeline-contract'

/** Where a criteria page resumes (oldest first). */
export type CriterionPosition = { createdAt: string; id: string }

/** Where a scores page resumes (highest first). */
export type ScorePosition = { score: number; prospectId: string }

/** Another criterion already has the name, ignoring case, or the Organization is at its limit. */
export class CriterionRefusedError extends Error {
  constructor() {
    super('the criterion cannot be added')
    this.name = 'CriterionRefusedError'
  }
}

/** The store of an Organization's fit criteria and latest scores; every call is scoped to one Organization. */
export type FitStore = {
  /** A page of criteria oldest first, with the version of the whole set (0 when none were ever saved). */
  list: (
    organizationId: OrganizationId,
    after: CriterionPosition | null,
    limit: number
  ) => Promise<{ items: FitCriterion[]; next: CriterionPosition | null; criteriaVersion: number }>
  /** Every enabled criterion (at most 50) and the version of the set. */
  enabled: (
    organizationId: OrganizationId
  ) => Promise<{ criteria: FitCriterion[]; criteriaVersion: number }>
  /** Adds a criterion and moves the version on; throws {@link CriterionRefusedError} on a taken name or a full set. */
  create: (organizationId: OrganizationId, criterion: FitCriterion) => Promise<void>
  /** The criterion with the name, ignoring case, or null. */
  byName: (organizationId: OrganizationId, name: string) => Promise<FitCriterion | null>
  /** Replaces a criterion and moves the version on; null when it is not there; throws {@link CriterionRefusedError} on a taken name. */
  update: (
    organizationId: OrganizationId,
    criterionId: FitCriterionId,
    change: (current: FitCriterion) => FitCriterion
  ) => Promise<FitCriterion | null>
  /** Removes a criterion and moves the version on; false when it was not there. */
  remove: (organizationId: OrganizationId, criterionId: FitCriterionId) => Promise<boolean>
  /** The latest stored score of a Prospect, or null. */
  score: (organizationId: OrganizationId, prospectId: string) => Promise<FitScore | null>
  /** Stores the score, replacing the Prospect's last one, and returns the score it replaced (null the first time). */
  saveScore: (organizationId: OrganizationId, score: FitScore) => Promise<number | null>
  /** A page of stored scores highest first (by score, then Prospect id), from `minScore`. */
  listScores: (
    organizationId: OrganizationId,
    filter: { minScore: number; after: ScorePosition | null; limit: number }
  ) => Promise<{ items: FitScore[]; next: ScorePosition | null }>
}
