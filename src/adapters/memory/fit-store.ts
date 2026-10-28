import { type FitCriterion, type FitScore, MAX_FIT_CRITERIA } from 'tula-closeline-contract'
import { CriterionRefusedError, type FitStore } from '~/ports/fit-store'

type OrganizationState = {
  criteria: FitCriterion[]
  version: number
  scores: Map<string, FitScore>
}

const byCreation = (a: FitCriterion, b: FitCriterion) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1

/** The fit store in process memory, for tests and local runs of one instance. */
export function createMemoryFitStore(): FitStore {
  const organizations = new Map<string, OrganizationState>()
  const stateOf = (organizationId: string) => {
    let found = organizations.get(organizationId)
    if (found === undefined) {
      found = { criteria: [], version: 0, scores: new Map() }
      organizations.set(organizationId, found)
    }
    return found
  }
  const nameTaken = (state: OrganizationState, name: string, exceptId: string | null) =>
    state.criteria.some((c) => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase())
  return {
    async list(organizationId, after, limit) {
      const state = stateOf(organizationId)
      const rest = [...state.criteria]
        .sort(byCreation)
        .filter(
          (c) =>
            after === null ||
            c.createdAt > after.createdAt ||
            (c.createdAt === after.createdAt && c.id > after.id)
        )
      const items = rest.slice(0, limit).map((c) => structuredClone(c))
      const last = items.at(-1)
      return {
        items,
        next:
          rest.length > limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : null,
        criteriaVersion: state.version,
      }
    },
    async enabled(organizationId) {
      const state = stateOf(organizationId)
      return {
        criteria: state.criteria.filter((c) => c.enabled).map((c) => structuredClone(c)),
        criteriaVersion: state.version,
      }
    },
    async create(organizationId, criterion) {
      const state = stateOf(organizationId)
      if (state.criteria.length >= MAX_FIT_CRITERIA || nameTaken(state, criterion.name, null)) {
        throw new CriterionRefusedError()
      }
      state.criteria.push(structuredClone(criterion))
      state.version += 1
    },
    async byName(organizationId, name) {
      const found = stateOf(organizationId).criteria.find(
        (c) => c.name.toLowerCase() === name.toLowerCase()
      )
      return found === undefined ? null : structuredClone(found)
    },
    async update(organizationId, criterionId, change) {
      const state = stateOf(organizationId)
      const index = state.criteria.findIndex((c) => c.id === criterionId)
      const current = state.criteria[index]
      if (current === undefined) {
        return null
      }
      const next = change(structuredClone(current))
      if (nameTaken(state, next.name, criterionId)) {
        throw new CriterionRefusedError()
      }
      state.criteria[index] = structuredClone(next)
      state.version += 1
      return next
    },
    async remove(organizationId, criterionId) {
      const state = stateOf(organizationId)
      const before = state.criteria.length
      state.criteria = state.criteria.filter((c) => c.id !== criterionId)
      if (state.criteria.length === before) {
        return false
      }
      state.version += 1
      return true
    },
    async score(organizationId, prospectId) {
      const found = stateOf(organizationId).scores.get(prospectId)
      return found === undefined ? null : structuredClone(found)
    },
    async saveScore(organizationId, score) {
      const state = stateOf(organizationId)
      const previous = state.scores.get(score.prospectId)?.score ?? null
      state.scores.set(score.prospectId, structuredClone(score))
      return previous
    },
    async listScores(organizationId, filter) {
      const rest = [...stateOf(organizationId).scores.values()]
        .filter((s) => s.score >= filter.minScore)
        .sort((a, b) => b.score - a.score || (a.prospectId < b.prospectId ? 1 : -1))
        .filter(
          (s) =>
            filter.after === null ||
            s.score < filter.after.score ||
            (s.score === filter.after.score && s.prospectId < filter.after.prospectId)
        )
      const items = rest.slice(0, filter.limit).map((s) => structuredClone(s))
      const last = items.at(-1)
      return {
        items,
        next:
          rest.length > filter.limit && last !== undefined
            ? { score: last.score, prospectId: last.prospectId }
            : null,
      }
    },
  }
}
