import type { CallId, DealRecordId, DocumentId, OrganizationId } from 'tula-closeline-contract'

/** A passage of the Organization's Playbook: a Moment of a Deal, or a page of a document. The text is untrusted data. */
export type PlaybookPassage =
  | { kind: 'moment'; callId: CallId; dealRecordId: DealRecordId; text: string; score: number }
  | { kind: 'document'; documentId: DocumentId; page: number | null; text: string; score: number }

/** The Organization's own Playbook search; ids only, never a customer's Deal names or amounts. */
export type PlaybookSearch = {
  search: (
    organizationId: OrganizationId,
    request: { query: string; limit: number; signal: AbortSignal }
  ) => Promise<readonly PlaybookPassage[]>
}
