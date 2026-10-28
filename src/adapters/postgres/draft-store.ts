import { and, asc, eq, sql } from 'drizzle-orm'
import {
  DRAFT_CHECKS,
  type DraftId,
  type OutreachDraft,
  outreachDraftSchema,
} from 'tula-closeline-contract'
import {
  MAX_REGENERATE_KEYS,
  outboundDraftChecks,
  outboundDraftCitations,
  outboundDrafts,
} from 'tula-closeline-db/schema'
import type { DraftStore } from '~/ports/draft-store'
import { citationOf, columnsOf } from './brief-store'
import type { InOrganization } from './store'

type Tx = Parameters<Parameters<InOrganization>[1]>[0]
type DraftRow = typeof outboundDrafts.$inferSelect

/** The contract's Draft from its rows; the stored values are parsed, not trusted. */
async function load(tx: Tx, organizationId: string, row: DraftRow): Promise<OutreachDraft> {
  const [citations, checks] = await Promise.all([
    tx
      .select()
      .from(outboundDraftCitations)
      .where(
        and(
          eq(outboundDraftCitations.organizationId, organizationId),
          eq(outboundDraftCitations.draftId, row.id)
        )
      )
      .orderBy(asc(outboundDraftCitations.position)),
    tx
      .select()
      .from(outboundDraftChecks)
      .where(
        and(
          eq(outboundDraftChecks.organizationId, organizationId),
          eq(outboundDraftChecks.draftId, row.id)
        )
      ),
  ])
  return outreachDraftSchema.parse({
    id: row.id,
    prospectId: row.prospectId,
    campaignId: row.campaignId,
    stepKey: row.stepKey,
    channel: row.channel,
    goal: row.goal,
    language: row.language,
    subject: row.subject,
    body: row.body,
    revision: row.revision,
    source: row.source,
    citations: citations.map((c) => ({
      ...(citationOf(c) as object),
      applies: c.applies,
      ...(c.score === null ? {} : { score: c.score }),
    })),
    ungrounded: row.ungrounded,
    wonDealCount: row.wonDealCount,
    checks: DRAFT_CHECKS.flatMap((name) => {
      const found = checks.find((c) => c.check === name)
      return found === undefined
        ? []
        : [{ check: found.check, result: found.result, count: found.count }]
    }),
    autoSendable: row.autoSendable,
    brandVoiceId: row.brandVoiceId,
    voiceVersion: row.voiceVersion,
    briefId: row.briefId,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

const columnsOfDraft = (organizationId: string, draft: OutreachDraft) => ({
  organizationId,
  prospectId: draft.prospectId,
  campaignId: draft.campaignId,
  stepKey: draft.stepKey,
  channel: draft.channel,
  goal: draft.goal,
  language: draft.language,
  subject: draft.subject,
  body: draft.body,
  revision: draft.revision,
  source: draft.source,
  ungrounded: draft.ungrounded,
  wonDealCount: draft.wonDealCount,
  autoSendable: draft.autoSendable,
  brandVoiceId: draft.brandVoiceId,
  voiceVersion: draft.voiceVersion,
  briefId: draft.briefId,
  model: draft.model,
  updatedAt: new Date(draft.updatedAt),
})

/** Writes a Draft's Citations and checks; the caller has removed any earlier ones. */
async function writeChildren(tx: Tx, organizationId: string, draft: OutreachDraft) {
  if (draft.citations.length > 0) {
    await tx.insert(outboundDraftCitations).values(
      draft.citations.map((citation, position) => ({
        organizationId,
        draftId: draft.id,
        position,
        ...columnsOf(citation),
        applies: citation.applies,
        score: citation.score ?? null,
      }))
    )
  }
  if (draft.checks.length > 0) {
    await tx.insert(outboundDraftChecks).values(
      draft.checks.map((c) => ({
        organizationId,
        draftId: draft.id,
        check: c.check,
        result: c.result,
        count: c.count,
      }))
    )
  }
}

/** The Draft store over Postgres: every call runs in one Organization-scoped transaction. */
export function createPostgresDraftStore(inOrganization: InOrganization): DraftStore {
  const find = async (tx: Tx, organizationId: string, where: ReturnType<typeof and>) => {
    const [row] = await tx.select().from(outboundDrafts).where(where).limit(1)
    return row === undefined
      ? null
      : { draft: await load(tx, organizationId, row), variantKey: row.variantKey }
  }
  const byId = (organizationId: string, draftId: DraftId) =>
    and(eq(outboundDrafts.organizationId, organizationId), eq(outboundDrafts.id, draftId))

  return {
    get: (organizationId, draftId) =>
      inOrganization(organizationId, async (tx) => {
        const found = await find(tx, organizationId, byId(organizationId, draftId))
        return found?.draft ?? null
      }),

    byRequestKey: (organizationId, key) =>
      inOrganization(organizationId, (tx) =>
        find(
          tx,
          organizationId,
          and(eq(outboundDrafts.organizationId, organizationId), eq(outboundDrafts.requestKey, key))
        )
      ),

    regeneratedBy: (organizationId, draftId, key) =>
      inOrganization(organizationId, (tx) =>
        find(
          tx,
          organizationId,
          and(byId(organizationId, draftId), sql`${key} = any(${outboundDrafts.regenerateKeys})`)
        ).then((found) => found?.draft ?? null)
      ),

    insert: (organizationId, draft, requestKey, variantKey) =>
      inOrganization(organizationId, async (tx) => {
        const [won] = await tx
          .insert(outboundDrafts)
          .values({
            id: draft.id,
            ...columnsOfDraft(organizationId, draft),
            createdAt: new Date(draft.createdAt),
            requestKey,
            variantKey,
          })
          .onConflictDoNothing({
            target: [outboundDrafts.organizationId, outboundDrafts.requestKey],
          })
          .returning({ id: outboundDrafts.id })
        if (won === undefined) {
          const winner = await find(
            tx,
            organizationId,
            and(
              eq(outboundDrafts.organizationId, organizationId),
              eq(outboundDrafts.requestKey, requestKey)
            )
          )
          if (winner === null) {
            throw new Error('a Draft key conflict left no Draft to read')
          }
          return winner.draft.prospectId === draft.prospectId
            ? { ...winner, created: false }
            : 'reused'
        }
        await writeChildren(tx, organizationId, draft)
        return { draft, variantKey, created: true }
      }),

    revise: (organizationId, next, regenerateKey) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(outboundDrafts)
          .where(byId(organizationId, next.id))
          .limit(1)
          .for('update')
        if (row === undefined) {
          return 'missing' as const
        }
        if (row.regenerateKeys.includes(regenerateKey)) {
          return {
            draft: await load(tx, organizationId, row),
            variantKey: row.variantKey,
            created: false,
          }
        }
        if (row.revision !== next.revision - 1) {
          return 'stale' as const
        }
        await tx
          .update(outboundDrafts)
          .set({
            ...columnsOfDraft(organizationId, next),
            regenerateKeys: [...row.regenerateKeys, regenerateKey].slice(-MAX_REGENERATE_KEYS),
          })
          .where(byId(organizationId, next.id))
        for (const table of [outboundDraftCitations, outboundDraftChecks]) {
          await tx
            .delete(table)
            .where(and(eq(table.organizationId, organizationId), eq(table.draftId, next.id)))
        }
        await writeChildren(tx, organizationId, next)
        return { draft: next, variantKey: row.variantKey, created: true }
      }),
  }
}
