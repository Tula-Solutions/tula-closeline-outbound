import { afterAll } from 'bun:test'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { formatId, type MembershipId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { linkedinChannelSettings, linkedinRiskAcceptances } from 'tula-closeline-db/schema'
import { integrationUrls } from '~/integration-support'
import { describeLinkedinStore } from '~/ports/linkedin-store.behaviour'
import { createPostgresLinkedinStore } from './linkedin-store'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

describeLinkedinStore('postgres', () => ({
  store: createPostgresLinkedinStore((organizationId, fn) =>
    withOrganization(database.db, organizationId, fn)
  ),
  seedChannel: (organizationId, { enabled, acceptedVersion }) =>
    withOrganization(database.db, organizationId, async (tx) => {
      await tx
        .insert(linkedinChannelSettings)
        .values({ organizationId, enabled })
        .onConflictDoUpdate({ target: linkedinChannelSettings.organizationId, set: { enabled } })
      // The service cannot delete an acceptance; a replacement revokes the old ones, as the product does.
      await tx
        .update(linkedinRiskAcceptances)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(linkedinRiskAcceptances.organizationId, organizationId),
            isNull(linkedinRiskAcceptances.revokedAt)
          )
        )
      if (acceptedVersion !== null) {
        await tx.insert(linkedinRiskAcceptances).values({
          id: formatId('lra', crypto.randomUUID()),
          organizationId,
          wordingVersion: acceptedVersion,
          acceptedByMembershipId: formatId('mem', crypto.randomUUID()) as MembershipId,
          typedFullName: 'Ada Admin',
        })
      }
    }),
}))
