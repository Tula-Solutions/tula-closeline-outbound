import type { OrganizationId } from 'tula-closeline-contract'

/** Why core suppresses an address after a delivery failure. */
export type DeliveryFailureReason = 'bounce' | 'complaint'

/** The calls that make core suppress an address (ADR 0013 internal auth); each is idempotent on its `sourceRef`. */
export type CoreSuppression = {
  /** Suppresses the address after a hard bounce or a complaint. */
  recordDeliveryFailure: (
    organizationId: OrganizationId,
    failure: { email: string; reason: DeliveryFailureReason; sourceRef: string }
  ) => Promise<void>
  /** Withdraws email consent for the address and suppresses it, as an unsubscribe does. */
  withdrawEmailConsent: (
    organizationId: OrganizationId,
    withdrawal: { email: string; sourceRef: string }
  ) => Promise<void>
}
