import type { RateInterval, StepVariantResults, VariantGroup } from 'tula-closeline-contract'
import { MIN_VARIANT_SAMPLE } from 'tula-closeline-contract'
import type { VariantCount } from '~/ports/enrollment-store'

/** The z value of a 95% interval. */
const Z = 1.96

/** The Wilson score interval of `hits` in `n` (n > 0); it stays inside 0..1 for small counts. */
export function wilson(hits: number, n: number): RateInterval {
  const p = hits / n
  const z2 = Z * Z
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return {
    estimate: p,
    lower: Math.max(0, Math.min(p, centre - half)),
    upper: Math.min(1, Math.max(p, centre + half)),
  }
}

/** The fewest sends each variant needs before the results are compared. */
export function minimumSample(group: VariantGroup): number {
  return group.promotion.mode === 'auto' ? group.promotion.minSamplePerVariant : MIN_VARIANT_SAMPLE
}

/** The per-variant results in the test's order; `not_enough_data` (no rates) until all have the sample. */
export function measure(
  group: VariantGroup,
  counts: readonly VariantCount[]
): Pick<StepVariantResults, 'status' | 'minimumSample' | 'variants'> {
  const minimum = minimumSample(group)
  const rows = group.variants.map((variant) => {
    const c = counts.find((count) => count.variantKey === variant.key)
    return {
      key: variant.key,
      sent: c?.sent ?? 0,
      replied: c?.replied ?? 0,
      bounced: c?.bounced ?? 0,
      unsubscribed: c?.unsubscribed ?? 0,
    }
  })
  const measured = rows.every((row) => row.sent >= minimum)
  return {
    status: measured ? 'measured' : 'not_enough_data',
    minimumSample: minimum,
    variants: rows.map((row) => ({
      key: row.key,
      sent: row.sent,
      delivered: Math.max(0, row.sent - row.bounced),
      replied: row.replied,
      positiveReplied: null,
      bounced: row.bounced,
      unsubscribed: row.unsubscribed,
      replyRate: measured ? wilson(row.replied, row.sent) : null,
    })),
  }
}

/** The variant that leads every other by at least `marginPoints` percentage points of reply rate, or null. */
export function clearWinner(
  variants: StepVariantResults['variants'],
  marginPoints: number
): string | null {
  const ranked = variants
    .flatMap((v) => (v.replyRate === null ? [] : [{ key: v.key, rate: v.replyRate.estimate }]))
    .sort((a, b) => b.rate - a.rate)
  const [first, second] = ranked
  if (first === undefined || second === undefined || ranked.length !== variants.length) {
    return null
  }
  return (first.rate - second.rate) * 100 >= marginPoints - 1e-9 ? first.key : null
}
