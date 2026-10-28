import type { DraftId, OrganizationId, OutreachDraft, ProspectId } from 'tula-closeline-contract'
import { formatId } from 'tula-closeline-contract'
import type { Approvals, DraftSource, ProspectContact, ProspectContacts } from '~/ports/engine'

/**
 * Drafts in process memory. Until draft generation exists a Draft is a placeholder that is
 * ungrounded, so every one goes to approvals and nothing is sent unseen. A test sets `make`.
 * shortcut: not backed by the drafting module; swap when M06-T7 lands.
 */
export function createMemoryDraftSource(now: () => string): DraftSource & {
  drafts: OutreachDraft[]
  make: ((request: Parameters<DraftSource['obtain']>[1]) => Partial<OutreachDraft>) | undefined
} {
  const drafts: OutreachDraft[] = []
  const source: DraftSource & {
    drafts: OutreachDraft[]
    make: ((request: Parameters<DraftSource['obtain']>[1]) => Partial<OutreachDraft>) | undefined
  } = {
    drafts,
    make: undefined as
      | ((request: Parameters<DraftSource['obtain']>[1]) => Partial<OutreachDraft>)
      | undefined,
    async obtain(_organizationId, request) {
      const existing = drafts.find(
        (d) =>
          d.prospectId === request.prospectId &&
          d.campaignId === request.campaignId &&
          d.stepKey === request.stepKey
      )
      if (existing !== undefined && source.make === undefined) {
        return existing
      }
      const draft = {
        id: formatId('drf', Bun.randomUUIDv7()) as DraftId,
        prospectId: request.prospectId,
        campaignId: request.campaignId,
        stepKey: request.stepKey,
        channel: 'email',
        goal: request.goal,
        language: 'en',
        subject: 'Hello',
        body: 'Hello',
        revision: 1,
        source: 'generated',
        citations: [],
        ungrounded: true,
        checks: [],
        autoSendable: false,
        createdAt: now(),
        ...source.make?.(request),
      } as unknown as OutreachDraft
      drafts.push(draft)
      return draft
    },
  }
  return source
}

/** One approval a test can read back. */
export type ApprovalRequested = { organizationId: OrganizationId } & Parameters<
  Approvals['request']
>[1]

/** Approvals in process memory, one per Draft; a test reads `requested`. shortcut: swap with M09. */
export function createMemoryApprovals(): Approvals & { requested: ApprovalRequested[] } {
  const requested: ApprovalRequested[] = []
  return {
    requested,
    async request(organizationId, approval) {
      if (!requested.some((r) => r.draftId === approval.draftId)) {
        requested.push({ organizationId, ...approval })
      }
    },
  }
}

/**
 * Contact details held in memory; a Prospect nobody set has none, so it is never sent to.
 * shortcut: core does not yet serve a Prospect's address to this service; swap when it does.
 */
export function createMemoryProspectContacts(): ProspectContacts & {
  set: (organizationId: OrganizationId, prospectId: ProspectId, contact: ProspectContact) => void
  /** Forgets a Prospect's contact, so it resolves to none. */
  clear: (organizationId: OrganizationId, prospectId: ProspectId) => void
} {
  const contacts = new Map<string, ProspectContact>()
  return {
    set: (organizationId, prospectId, contact) => {
      contacts.set(`${organizationId}:${prospectId}`, contact)
    },
    clear: (organizationId, prospectId) => {
      contacts.delete(`${organizationId}:${prospectId}`)
    },
    async resolve(organizationId, prospectId) {
      return contacts.get(`${organizationId}:${prospectId}`) ?? null
    },
  }
}
