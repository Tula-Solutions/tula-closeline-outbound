/** Counts hits per key in fixed windows, shared by every instance; keys are hashes, never raw values. */
export type RateLimiter = {
  /** Counts one hit; false when the key already used its `limit` in the current window. */
  hit(keyHash: Uint8Array, options: { windowSeconds: number; limit: number }): Promise<boolean>
}
