import { and, eq, sql } from 'drizzle-orm'
import { outboundModelUsage } from 'tula-closeline-db/schema'
import type { ModelUsageStore } from '~/ports/model-usage'
import type { InOrganization } from './store'

/** The usage store over Postgres: one row per Organization, month and model, added to atomically. */
export function createPostgresModelUsageStore(inOrganization: InOrganization): ModelUsageStore {
  return {
    spentMicros: (organizationId, month) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select({ sum: sql<string>`coalesce(sum(${outboundModelUsage.costMicros}), 0)` })
          .from(outboundModelUsage)
          .where(
            and(
              eq(outboundModelUsage.organizationId, organizationId),
              eq(outboundModelUsage.month, month)
            )
          )
        return Number(row?.sum ?? 0)
      }),
    record: (organizationId, month, model, usage) =>
      inOrganization(organizationId, async (tx) => {
        await tx
          .insert(outboundModelUsage)
          .values({ organizationId, month, model, ...usage, requestCount: 1 })
          .onConflictDoUpdate({
            target: [
              outboundModelUsage.organizationId,
              outboundModelUsage.month,
              outboundModelUsage.model,
            ],
            set: {
              inputTokens: sql`${outboundModelUsage.inputTokens} + ${usage.inputTokens}`,
              outputTokens: sql`${outboundModelUsage.outputTokens} + ${usage.outputTokens}`,
              requestCount: sql`${outboundModelUsage.requestCount} + 1`,
              costMicros: sql`${outboundModelUsage.costMicros} + ${usage.costMicros}`,
              updatedAt: sql`now()`,
            },
          })
      }),
  }
}
