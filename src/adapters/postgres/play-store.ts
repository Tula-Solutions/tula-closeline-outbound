import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm'
import { type Play, playSchema, sequenceStepsSchema } from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { outboundPlayCitations, outboundPlays } from 'tula-closeline-db/schema'
import type { PlayStore } from '~/ports/play-store'
import type { InOrganization } from './store'

type PlayRow = typeof outboundPlays.$inferSelect
type CitationRow = typeof outboundPlayCitations.$inferSelect

/** The contract's Play from its rows; the stored values are parsed, not trusted. */
function playOf(row: PlayRow, citations: readonly CitationRow[]): Play {
  return playSchema.parse({
    id: row.id,
    name: row.name,
    intent: row.intent,
    goal: row.goal,
    source: row.source,
    status: row.status,
    steps: sequenceStepsSchema.parse(row.steps),
    citations: citations.map((c) =>
      c.kind === 'moment'
        ? { kind: 'moment', callId: c.callId, dealRecordId: c.dealRecordId }
        : { kind: 'document', documentId: c.documentId, page: c.page }
    ),
    evidenceCount: row.evidenceCount,
    noEvidence: citations.length === 0,
    createdByMembershipId: row.createdByMembershipId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

const columnsOf = (organizationId: string, play: Play) => ({
  id: play.id,
  organizationId,
  name: play.name,
  intent: play.intent,
  goal: play.goal,
  source: play.source as Exclude<Play['source'], 'builtin'>,
  status: play.status,
  steps: play.steps,
  evidenceCount: play.evidenceCount,
  createdByMembershipId: play.createdByMembershipId,
  createdAt: new Date(play.createdAt),
  updatedAt: new Date(play.updatedAt),
})

/** The citations of these Plays, in position order. */
async function citationsOf(tx: Transaction, organizationId: string, ids: readonly string[]) {
  if (ids.length === 0) {
    return []
  }
  return tx
    .select()
    .from(outboundPlayCitations)
    .where(
      and(
        eq(outboundPlayCitations.organizationId, organizationId),
        inArray(outboundPlayCitations.playId, [...ids])
      )
    )
    .orderBy(asc(outboundPlayCitations.position))
}

/** Reads a Play, locking its row when `lock` is set so two changes never interleave. */
async function load(tx: Transaction, organizationId: string, id: string, lock: boolean) {
  const query = tx
    .select()
    .from(outboundPlays)
    .where(and(eq(outboundPlays.organizationId, organizationId), eq(outboundPlays.id, id)))
  const [row] = await (lock ? query.for('update') : query)
  return row === undefined ? null : playOf(row, await citationsOf(tx, organizationId, [id]))
}

async function writeCitations(tx: Transaction, organizationId: string, play: Play) {
  if (play.citations.length === 0) {
    return
  }
  await tx.insert(outboundPlayCitations).values(
    play.citations.map((c, position) => ({
      organizationId,
      playId: play.id,
      position,
      kind: c.kind,
      callId: c.kind === 'moment' ? c.callId : null,
      dealRecordId: c.kind === 'moment' ? c.dealRecordId : null,
      documentId: c.kind === 'document' ? c.documentId : null,
      page: c.kind === 'document' ? c.page : null,
    }))
  )
}

/** The Play store over Postgres: every call runs in one Organization-scoped transaction. */
export function createPostgresPlayStore(inOrganization: InOrganization): PlayStore {
  return {
    insertIfAbsent: (organizationId, play) =>
      inOrganization(organizationId, async (tx) => {
        const inserted = await tx
          .insert(outboundPlays)
          .values(columnsOf(organizationId, play))
          .onConflictDoNothing()
          .returning({ id: outboundPlays.id })
        if (inserted.length === 0) {
          const existing = await load(tx, organizationId, play.id, false)
          if (existing === null) {
            throw new Error(`play ${play.id} neither inserted nor found`)
          }
          return { play: existing, created: false }
        }
        await writeCitations(tx, organizationId, play)
        return { play, created: true }
      }),

    find: (organizationId, id) =>
      inOrganization(organizationId, (tx) => load(tx, organizationId, id, false)),

    list: (organizationId, filter, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(outboundPlays)
          .where(
            and(
              eq(outboundPlays.organizationId, organizationId),
              filter.status === undefined ? undefined : eq(outboundPlays.status, filter.status),
              filter.intent === undefined ? undefined : eq(outboundPlays.intent, filter.intent),
              filter.source === undefined || filter.source === 'builtin'
                ? undefined
                : eq(outboundPlays.source, filter.source),
              after === null
                ? undefined
                : or(
                    lt(outboundPlays.createdAt, new Date(after.createdAt)),
                    and(
                      eq(outboundPlays.createdAt, new Date(after.createdAt)),
                      lt(outboundPlays.id, after.id)
                    )
                  )
            )
          )
          .orderBy(desc(outboundPlays.createdAt), desc(outboundPlays.id))
          .limit(limit + 1)
        const page = rows.slice(0, limit)
        const citations = await citationsOf(
          tx,
          organizationId,
          page.map((row) => row.id)
        )
        const items = page.map((row) =>
          playOf(
            row,
            citations.filter((c) => c.playId === row.id)
          )
        )
        const last = items[items.length - 1]
        return {
          items,
          next:
            rows.length > limit && last !== undefined
              ? { createdAt: last.createdAt, id: last.id }
              : null,
        }
      }),

    modify: (organizationId, id, change) =>
      inOrganization(organizationId, async (tx) => {
        const current = await load(tx, organizationId, id, true)
        if (current === null) {
          return null
        }
        const next = change(current)
        await tx
          .update(outboundPlays)
          .set(columnsOf(organizationId, next))
          .where(and(eq(outboundPlays.organizationId, organizationId), eq(outboundPlays.id, id)))
        return next
      }),
  }
}
