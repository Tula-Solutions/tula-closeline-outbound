import type { Campaign, CampaignId, OrganizationId, Sequence, Step } from 'tula-closeline-contract'
import type {
  CampaignFilter,
  CampaignPage,
  CampaignPosition,
  CampaignStore,
  Promotion,
} from '~/ports/campaign-store'

type Versions = Map<number, Sequence>

type Entry = { campaign: Campaign; versions: Versions }

/** Newest first: later created time, then larger id. */
function newestFirst(a: Campaign, b: Campaign): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

function matches(campaign: Campaign, filter: CampaignFilter): boolean {
  return (
    (filter.visibleOwners === undefined ||
      filter.visibleOwners.includes(campaign.ownerMembershipId)) &&
    (filter.state === undefined || campaign.state === filter.state) &&
    (filter.ownerMembershipId === undefined ||
      campaign.ownerMembershipId === filter.ownerMembershipId) &&
    (filter.teamId === undefined || campaign.teamId === filter.teamId)
  )
}

/**
 * The Campaign store in process memory, for tests and local runs of one instance. It keeps the
 * behaviour of the Postgres adapter: one write at a time per store (so two changes never
 * interleave), a refused change writes nothing, and every Sequence version stays readable.
 */
export function createMemoryCampaignStore(): CampaignStore {
  const organizations = new Map<string, Map<string, Entry>>()
  const promotions = new Map<string, Promotion>()
  const promotionKey = (org: string, id: string, version: number, stepKey: string) =>
    `${org}|${id}|${version}|${stepKey}`
  const entries = (organizationId: OrganizationId) => {
    let found = organizations.get(organizationId)
    if (found === undefined) {
      found = new Map()
      organizations.set(organizationId, found)
    }
    return found
  }
  const sequenceOf = (id: CampaignId, version: number, steps: readonly Step[], at: string) =>
    structuredClone<Sequence>({ campaignId: id, version, steps: [...steps], updatedAt: at })

  return {
    async insertIfAbsent(organizationId, campaign, steps, _createdBy) {
      const all = entries(organizationId)
      const existing = all.get(campaign.id)
      if (existing !== undefined) {
        return { campaign: structuredClone(existing.campaign), created: false }
      }
      const versions: Versions = new Map()
      if (steps !== null) {
        versions.set(
          campaign.sequenceVersion,
          sequenceOf(campaign.id, campaign.sequenceVersion, steps, campaign.createdAt)
        )
      }
      all.set(campaign.id, { campaign: structuredClone(campaign), versions })
      return { campaign: structuredClone(campaign), created: true }
    },
    async find(organizationId, id) {
      const found = entries(organizationId).get(id)
      return found === undefined ? null : structuredClone(found.campaign)
    },
    async list(
      organizationId,
      filter,
      after: CampaignPosition | null,
      limit
    ): Promise<CampaignPage> {
      const sorted = [...entries(organizationId).values()]
        .map((entry) => entry.campaign)
        .filter((campaign) => matches(campaign, filter))
        .sort(newestFirst)
      const start =
        after === null
          ? 0
          : sorted.findIndex((campaign) => newestFirst({ ...campaign, ...after }, campaign) < 0)
      const rest = start === -1 ? [] : sorted.slice(start)
      const items = rest.slice(0, limit).map((campaign) => structuredClone(campaign))
      const last = items[items.length - 1]
      return {
        items,
        next:
          rest.length > limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      }
    },
    async modify(organizationId, id, change) {
      const found = entries(organizationId).get(id)
      if (found === undefined) {
        return null
      }
      found.campaign = structuredClone(change(structuredClone(found.campaign)))
      return structuredClone(found.campaign)
    },
    async readSequence(organizationId, id, version) {
      const found = entries(organizationId).get(id)?.versions.get(version)
      return found === undefined ? null : structuredClone(found)
    },
    async saveSequence(organizationId, id, decide) {
      const found = entries(organizationId).get(id)
      if (found === undefined) {
        return null
      }
      const current =
        found.versions.get(found.campaign.sequenceVersion) ??
        sequenceOf(id, 0, [], found.campaign.createdAt)
      const decision = decide(structuredClone(found.campaign), structuredClone(current))
      if (decision.kind === 'unchanged') {
        return { campaign: structuredClone(found.campaign), sequence: structuredClone(current) }
      }
      const sequence = sequenceOf(
        id,
        decision.campaign.sequenceVersion,
        decision.steps,
        decision.campaign.updatedAt
      )
      found.versions.set(sequence.version, sequence)
      found.campaign = structuredClone(decision.campaign)
      return { campaign: structuredClone(found.campaign), sequence: structuredClone(sequence) }
    },
    async promotionOf(organizationId, id, version, stepKey) {
      const found = promotions.get(promotionKey(organizationId, id, version, stepKey))
      return found === undefined ? null : structuredClone(found)
    },
    async promote(organizationId, id, version, stepKey, promotion) {
      const key = promotionKey(organizationId, id, version, stepKey)
      const existing = promotions.get(key)
      if (existing !== undefined) {
        return { promotion: structuredClone(existing), created: false }
      }
      promotions.set(key, structuredClone(promotion))
      return { promotion: structuredClone(promotion), created: true }
    },
  }
}
