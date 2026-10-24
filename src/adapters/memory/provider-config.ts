import type { OrganizationId } from 'tula-closeline-contract'
import type { ProviderConfig, ProviderSetting } from '~/ports/provider-config'

/** Provider settings in process memory, with a way for tests to set them. */
export function createMemoryProviderConfig(): ProviderConfig & {
  /** Replaces the Organization's settings. */
  set: (organizationId: OrganizationId, settings: readonly ProviderSetting[]) => void
} {
  const byOrganization = new Map<string, readonly ProviderSetting[]>()
  return {
    set(organizationId, settings) {
      byOrganization.set(organizationId, settings)
    },
    async list(organizationId) {
      return byOrganization.get(organizationId) ?? []
    },
  }
}
