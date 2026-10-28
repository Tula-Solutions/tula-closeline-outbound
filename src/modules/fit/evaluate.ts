import type { FitCriterion } from 'tula-closeline-contract'
import type { ProspectValues } from '~/ports/enrichment-provider'

/** How one criterion fared against a Prospect. */
export type Verdict = 'matched' | 'missed' | 'unknown'

const lower = (text: string) => text.trim().toLowerCase()

/** Judges one criterion against the Prospect's current values; a missing value is `unknown` and adds nothing. */
export function evaluate(criterion: FitCriterion, values: ProspectValues): Verdict {
  const raw = values[criterion.field]
  if (raw === undefined || raw.trim() === '') {
    return 'unknown'
  }
  const condition = criterion.condition
  if (condition.operator === 'between') {
    const number = Number(raw)
    if (Number.isNaN(number)) {
      return 'unknown'
    }
    const aboveMin = condition.min === null || number >= condition.min
    const belowMax = condition.max === null || number <= condition.max
    return aboveMin && belowMax ? 'matched' : 'missed'
  }
  const tokens = (criterion.field === 'technologies' ? raw.split(',') : [raw])
    .map(lower)
    .filter((token) => token !== '')
  const wanted = condition.values.map(lower)
  const hit =
    condition.operator === 'one_of'
      ? tokens.some((token) => wanted.includes(token))
      : tokens.some((token) => wanted.some((value) => token.includes(value)))
  return hit ? 'matched' : 'missed'
}
