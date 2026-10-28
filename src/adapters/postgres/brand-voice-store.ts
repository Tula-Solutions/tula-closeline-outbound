import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { type BrandVoice, brandVoiceSchema } from 'tula-closeline-contract'
import { outboundBrandVoices } from 'tula-closeline-db/schema'
import type { BrandVoiceStore } from '~/ports/brand-voice-store'
import type { InOrganization } from './store'

type Row = typeof outboundBrandVoices.$inferSelect

/** The contract's Brand Voice from its row; the stored values are parsed, not trusted. */
function voiceOf(row: Row): BrandVoice {
  return brandVoiceSchema.parse({
    id: row.id,
    version: row.version,
    tone: row.tone,
    preferredWords: row.preferredWords,
    bannedPhrases: row.bannedPhrases,
    signOff: row.signOff,
    maxLengthCharacters: row.maxLengthCharacters,
    createdByMembershipId: row.createdByMembershipId,
    createdAt: row.createdAt.toISOString(),
  })
}

/** The Brand Voice store over Postgres: every call runs in one Organization-scoped transaction. */
export function createPostgresBrandVoiceStore(inOrganization: InOrganization): BrandVoiceStore {
  const newest = async (
    tx: Parameters<Parameters<InOrganization>[1]>[0],
    organizationId: string
  ) => {
    const [row] = await tx
      .select()
      .from(outboundBrandVoices)
      .where(eq(outboundBrandVoices.organizationId, organizationId))
      .orderBy(desc(outboundBrandVoices.version))
      .limit(1)
    return row === undefined ? null : voiceOf(row)
  }
  return {
    current: (organizationId) => inOrganization(organizationId, (tx) => newest(tx, organizationId)),

    save: (organizationId, decide) =>
      inOrganization(organizationId, async (tx) => {
        // Serialises saves per Organization; a first save has no row to lock.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`)
        const current = await newest(tx, organizationId)
        const decision = decide(current)
        if (decision.kind === 'unchanged') {
          if (current === null) {
            throw new Error('a save with nothing current cannot be unchanged')
          }
          return current
        }
        const { voice } = decision
        await tx.insert(outboundBrandVoices).values({
          id: voice.id,
          organizationId,
          version: voice.version,
          tone: voice.tone,
          preferredWords: voice.preferredWords,
          bannedPhrases: voice.bannedPhrases,
          signOff: voice.signOff,
          maxLengthCharacters: voice.maxLengthCharacters,
          createdByMembershipId: voice.createdByMembershipId,
          createdAt: new Date(voice.createdAt),
        })
        return voice
      }),

    list: (organizationId, before, limit) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(outboundBrandVoices)
          .where(
            and(
              eq(outboundBrandVoices.organizationId, organizationId),
              before === null ? undefined : lt(outboundBrandVoices.version, before)
            )
          )
          .orderBy(desc(outboundBrandVoices.version))
          .limit(limit + 1)
        const items = rows.slice(0, limit).map(voiceOf)
        const last = items.at(-1)
        return { items, next: rows.length > limit && last !== undefined ? last.version : null }
      }),
  }
}
