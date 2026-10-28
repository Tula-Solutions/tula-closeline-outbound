import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm'
import {
  type BriefStatement,
  type CitationSource,
  type ResearchBrief,
  researchBriefSchema,
} from 'tula-closeline-contract'
import { outboundBriefStatements, outboundBriefs } from 'tula-closeline-db/schema'
import type { BriefStore } from '~/ports/brief-store'
import type { InOrganization } from './store'

type Tx = Parameters<Parameters<InOrganization>[1]>[0]
type BriefRow = typeof outboundBriefs.$inferSelect
type EntryRow = typeof outboundBriefStatements.$inferSelect
type SourceColumns = Pick<EntryRow, `source${string}` & keyof EntryRow>

const iso = (date: Date | null) => (date === null ? null : date.toISOString())

/** The citation a stored row rests on; the contract parses the whole Brief afterwards. */
function citationOf(row: EntryRow): unknown {
  switch (row.sourceKind) {
    case 'prospect_field':
      return { kind: row.sourceKind, prospectId: row.sourceProspectId, field: row.sourceField }
    case 'signal':
      return {
        kind: row.sourceKind,
        signalId: row.sourceSignalId,
        observedAt: iso(row.sourceObservedAt),
      }
    case 'web_page':
      return { kind: row.sourceKind, url: row.sourceUrl, retrievedAt: iso(row.sourceRetrievedAt) }
    case 'moment':
      return {
        kind: row.sourceKind,
        callId: row.sourceCallId,
        dealRecordId: row.sourceDealRecordId,
      }
    case 'document':
      return { kind: row.sourceKind, documentId: row.sourceDocumentId, page: row.sourcePage }
  }
}

/** The source columns of a citation; the columns of the other kinds stay null, as the checks require. */
function columnsOf(source: CitationSource): SourceColumns {
  const none: SourceColumns = {
    sourceKind: source.kind,
    sourceProspectId: null,
    sourceField: null,
    sourceSignalId: null,
    sourceObservedAt: null,
    sourceUrl: null,
    sourceRetrievedAt: null,
    sourceCallId: null,
    sourceDealRecordId: null,
    sourceDocumentId: null,
    sourcePage: null,
  }
  switch (source.kind) {
    case 'prospect_field':
      return { ...none, sourceProspectId: source.prospectId, sourceField: source.field }
    case 'signal':
      return {
        ...none,
        sourceSignalId: source.signalId,
        sourceObservedAt: new Date(source.observedAt),
      }
    case 'web_page':
      return { ...none, sourceUrl: source.url, sourceRetrievedAt: new Date(source.retrievedAt) }
    case 'moment':
      return { ...none, sourceCallId: source.callId, sourceDealRecordId: source.dealRecordId }
    case 'document':
      return { ...none, sourceDocumentId: source.documentId, sourcePage: source.page }
  }
}

/** The contract's Brief from its row and entries; the stored values are parsed, not trusted. */
function briefOf(row: BriefRow, entries: readonly EntryRow[]): ResearchBrief {
  const ordered = [...entries].sort((a, b) => a.position - b.position)
  return researchBriefSchema.parse({
    id: row.id,
    prospectId: row.prospectId,
    statements: ordered
      .filter((e) => e.role === 'statement')
      .map((e) => ({ text: e.text, source: citationOf(e) })),
    angle: {
      text: row.angleText,
      origin: row.angleOrigin,
      sources: ordered.filter((e) => e.role === 'angle_source').map(citationOf),
    },
    droppedCount: row.droppedCount,
    prospectUpdatedAt: row.prospectUpdatedAt.toISOString(),
    language: row.language,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  })
}

/** The Brief store over Postgres: every call runs in one Organization-scoped transaction. */
export function createPostgresBriefStore(inOrganization: InOrganization): BriefStore {
  const load = async (tx: Tx, organizationId: string, rows: readonly BriefRow[]) => {
    if (rows.length === 0) {
      return []
    }
    const entries = await tx
      .select()
      .from(outboundBriefStatements)
      .where(
        and(
          eq(outboundBriefStatements.organizationId, organizationId),
          inArray(
            outboundBriefStatements.briefId,
            rows.map((r) => r.id)
          )
        )
      )
      .orderBy(asc(outboundBriefStatements.position))
    return rows.map((row) =>
      briefOf(
        row,
        entries.filter((e) => e.briefId === row.id)
      )
    )
  }
  const one = async (tx: Tx, organizationId: string, rows: readonly BriefRow[]) =>
    (await load(tx, organizationId, rows.slice(0, 1)))[0] ?? null

  return {
    newest: (organizationId, prospectId) =>
      inOrganization(organizationId, async (tx) =>
        one(
          tx,
          organizationId,
          await tx
            .select()
            .from(outboundBriefs)
            .where(
              and(
                eq(outboundBriefs.organizationId, organizationId),
                eq(outboundBriefs.prospectId, prospectId)
              )
            )
            .orderBy(desc(outboundBriefs.createdAt), desc(outboundBriefs.id))
            .limit(1)
        )
      ),

    byRequestKey: (organizationId, key) =>
      inOrganization(organizationId, async (tx) =>
        one(
          tx,
          organizationId,
          await tx
            .select()
            .from(outboundBriefs)
            .where(
              and(
                eq(outboundBriefs.organizationId, organizationId),
                eq(outboundBriefs.requestKey, key)
              )
            )
        )
      ),

    insert: (organizationId, brief, requestKey) =>
      inOrganization(organizationId, async (tx) => {
        const [won] = await tx
          .insert(outboundBriefs)
          .values({
            id: brief.id,
            organizationId,
            prospectId: brief.prospectId,
            angleText: brief.angle.text,
            angleOrigin: brief.angle.origin,
            droppedCount: brief.droppedCount,
            prospectUpdatedAt: new Date(brief.prospectUpdatedAt),
            language: brief.language,
            model: brief.model,
            createdAt: new Date(brief.createdAt),
            expiresAt: new Date(brief.expiresAt),
            requestKey,
          })
          .onConflictDoNothing({
            target: [outboundBriefs.organizationId, outboundBriefs.requestKey],
          })
          .returning({ id: outboundBriefs.id })
        if (won === undefined) {
          // Another request got the key first: answer its Brief, drop ours.
          const winner = await one(
            tx,
            organizationId,
            await tx
              .select()
              .from(outboundBriefs)
              .where(
                and(
                  eq(outboundBriefs.organizationId, organizationId),
                  eq(outboundBriefs.requestKey, requestKey)
                )
              )
          )
          if (winner === null) {
            throw new Error('a Brief key conflict left no Brief to read')
          }
          return winner.prospectId === brief.prospectId
            ? { brief: winner, created: false }
            : 'reused'
        }
        const entries: {
          role: 'statement' | 'angle_source'
          text: string | null
          source: CitationSource
        }[] = [
          ...brief.statements.map((s: BriefStatement) => ({
            role: 'statement' as const,
            text: s.text,
            source: s.source,
          })),
          ...brief.angle.sources.map((source) => ({
            role: 'angle_source' as const,
            text: null,
            source,
          })),
        ]
        if (entries.length > 0) {
          await tx.insert(outboundBriefStatements).values(
            entries.map((entry, position) => ({
              organizationId,
              briefId: brief.id,
              position,
              role: entry.role,
              text: entry.text,
              ...columnsOf(entry.source),
            }))
          )
        }
        return { brief, created: true }
      }),

    get: (organizationId, briefId) =>
      inOrganization(organizationId, async (tx) =>
        one(
          tx,
          organizationId,
          await tx
            .select()
            .from(outboundBriefs)
            .where(
              and(eq(outboundBriefs.organizationId, organizationId), eq(outboundBriefs.id, briefId))
            )
        )
      ),

    list: (organizationId, prospectId, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(outboundBriefs)
          .where(
            and(
              eq(outboundBriefs.organizationId, organizationId),
              eq(outboundBriefs.prospectId, prospectId),
              after === null
                ? undefined
                : or(
                    lt(outboundBriefs.createdAt, new Date(after.createdAt)),
                    and(
                      eq(outboundBriefs.createdAt, new Date(after.createdAt)),
                      lt(outboundBriefs.id, after.id)
                    )
                  )
            )
          )
          .orderBy(desc(outboundBriefs.createdAt), desc(outboundBriefs.id))
          .limit(limit)
        return load(tx, organizationId, rows)
      }),
  }
}
