import { MAX_ENRICHED_VALUE_LENGTH } from 'tula-closeline-contract'

/** Provider text as it is kept: control characters gone, trimmed, cut to the contract's length. */
export function cleanVendorText(raw: unknown): { value: string; truncated: boolean } | null {
  if (typeof raw !== 'string') {
    return null
  }
  const text = raw.replace(/\p{Cc}/gu, '').trim()
  if (text.length === 0) {
    return null
  }
  if (text.length <= MAX_ENRICHED_VALUE_LENGTH) {
    return { value: text, truncated: false }
  }
  let end = MAX_ENRICHED_VALUE_LENGTH
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1
  }
  return { value: text.slice(0, end).trimEnd(), truncated: true }
}
