import type { CoreSuppression, DeliveryFailureReason } from '~/ports/core-suppression'

/** What this fake core holds for an Organization. */
export type MemoryCoreSuppression = CoreSuppression & {
  /** The addresses suppressed in the Organization, each with why. */
  suppressed: (
    organizationId: string
  ) => { email: string; why: DeliveryFailureReason | 'unsubscribe' }[]
}

/** Core's suppression in process memory; a repeated `sourceRef` changes nothing. */
export function createMemoryCoreSuppression(): MemoryCoreSuppression {
  const entries = new Map<string, { organizationId: string; email: string; why: string }>()
  const add = (organizationId: string, email: string, why: string, sourceRef: string) => {
    const key = `${organizationId}|${sourceRef}`
    if (!entries.has(key)) {
      entries.set(key, { organizationId, email: email.toLowerCase(), why })
    }
  }
  return {
    async recordDeliveryFailure(organizationId, failure) {
      add(organizationId, failure.email, failure.reason, failure.sourceRef)
    },
    async withdrawEmailConsent(organizationId, withdrawal) {
      add(organizationId, withdrawal.email, 'unsubscribe', withdrawal.sourceRef)
    },
    suppressed: (organizationId) =>
      [...entries.values()]
        .filter((e) => e.organizationId === organizationId)
        .map((e) => ({ email: e.email, why: e.why as DeliveryFailureReason | 'unsubscribe' })),
  }
}
