import { ProviderError } from '~/ports/enrichment-provider'

/** The injected `fetch`, so a test points an adapter at a scripted server or a stub. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const MAX_RESPONSE_BYTES = 1_000_000

/**
 * One HTTP call to a data vendor, bounded by `signal`, answering the JSON body of a 2xx (or of a 404
 * when `notFoundIsEmpty`, as null). Failures become {@link ProviderError} with fixed words: the URL
 * may carry a key, so neither it nor any vendor text is ever put in an error. The caller retries.
 */
export async function vendorJson(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  notFoundIsEmpty = false
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchFn(url, { ...init, signal, redirect: 'error' })
  } catch (error) {
    throw new ProviderError(
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? 'timeout'
        : 'provider_error'
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError('key_rejected')
  }
  if (response.status === 429) {
    throw new ProviderError('rate_limited')
  }
  if (response.status === 404 && notFoundIsEmpty) {
    return null
  }
  if (response.status < 200 || response.status > 299) {
    throw new ProviderError('provider_error')
  }
  try {
    const text = await response.text()
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new ProviderError('invalid_response')
    }
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error
    }
    throw new ProviderError(
      error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'invalid_response'
    )
  }
}

/** A string property of an untrusted object, trimmed, or undefined when it is not a non-empty string. */
export function text(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** A property that is an object, or undefined. */
export function objectOf(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}
