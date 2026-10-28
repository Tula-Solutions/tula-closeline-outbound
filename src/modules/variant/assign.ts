import type { CampaignId, ProspectId, Variant } from 'tula-closeline-contract'
import { VARIANT_WEIGHT_TOTAL } from 'tula-closeline-contract'

/** Which Prospect, Campaign and Step a variant is chosen for. */
export type AssignmentKey = { prospectId: ProspectId; campaignId: CampaignId; stepKey: string }

/**
 * The variant this Prospect gets at this Step: a hash of the key falls in a bucket of the weight
 * total and the cumulative weights decide, so a retry or a restart always lands on the same one
 * and the split follows the weights. A promoted winner is used for everyone. O(variants), no I/O.
 */
export function assignVariant(
  key: AssignmentKey,
  variants: readonly Variant[],
  promotedKey: string | null
): Variant {
  const promoted = variants.find((variant) => variant.key === promotedKey)
  if (promoted !== undefined) {
    return promoted
  }
  const digest = new Bun.CryptoHasher('sha256')
    .update(`${key.prospectId}:${key.campaignId}:${key.stepKey}`)
    .digest()
  const bucket =
    (new DataView(digest.buffer, digest.byteOffset).getUint32(0) / 2 ** 32) * VARIANT_WEIGHT_TOTAL
  let upTo = 0
  for (const variant of variants) {
    upTo += variant.weight
    if (bucket < upTo) {
      return variant
    }
  }
  return variants[variants.length - 1] as Variant
}
