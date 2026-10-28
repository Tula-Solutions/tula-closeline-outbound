import type { AudienceCheck, CampaignId, OrganizationId } from 'tula-closeline-contract'
import type { AudienceCheckStore } from '~/ports/audience'

type Latest = { check: AudienceCheck; key: string }

/**
 * Audience checks in process memory. shortcut: the db has no audience-check table, so a check is
 * lost on restart and invisible to another instance, and a check whose pages keep failing stays
 * pending; upgrade when the db adds one (with an expiry).
 */
export function createMemoryAudienceCheckStore(): AudienceCheckStore {
  const latest = new Map<string, Latest>()
  const slot = (organizationId: OrganizationId, campaignId: CampaignId) =>
    `${organizationId}|${campaignId}`
  return {
    async start(organizationId, campaignId, audienceVersion, requestedAt, key) {
      const found = latest.get(slot(organizationId, campaignId))
      if (
        found !== undefined &&
        (found.key === key ||
          (found.check.state === 'pending' && found.check.audienceVersion === audienceVersion))
      ) {
        return { check: structuredClone(found.check), started: false }
      }
      const check: AudienceCheck = {
        campaignId,
        state: 'pending',
        audienceVersion,
        counts: null,
        requestedAt,
        completedAt: null,
      }
      latest.set(slot(organizationId, campaignId), { check, key })
      return { check: structuredClone(check), started: true }
    },
    async get(organizationId, campaignId) {
      const found = latest.get(slot(organizationId, campaignId))
      return found === undefined ? null : structuredClone(found.check)
    },
    async finish(organizationId, campaignId, requestedAt, outcome, at) {
      const found = latest.get(slot(organizationId, campaignId))
      if (
        found === undefined ||
        found.check.requestedAt !== requestedAt ||
        found.check.state !== 'pending'
      ) {
        return
      }
      found.check = {
        ...found.check,
        state: outcome.state,
        counts: outcome.state === 'ready' ? outcome.counts : null,
        completedAt: at,
      }
    },
  }
}
