import { and, desc, eq, gt, lt, or, sql } from 'drizzle-orm'
import {
  type SignalKindSetting,
  type SignalSource,
  signalKindSettingSchema,
} from 'tula-closeline-contract'
import { signalSettings, signals } from 'tula-closeline-db/schema'
import { z } from 'zod'
import {
  SettingsVersionConflictError,
  type SignalStore,
  type StoredSettings,
  type StoredSignal,
} from '~/ports/signal-store'
import type { InOrganization } from './store'

type SignalRow = typeof signals.$inferSelect

function sourceOf(row: SignalRow): SignalSource {
  if (row.sourceType === 'provider' && row.sourceProvider !== null) {
    return { type: 'provider', provider: row.sourceProvider }
  }
  if (row.sourceType === 'manual' && row.sourceUserId !== null) {
    return { type: 'manual', userId: row.sourceUserId } as SignalSource
  }
  return { type: 'webhook' }
}

const detailSchema = z.record(z.string(), z.unknown())

function signalOf(row: SignalRow): StoredSignal {
  return {
    id: row.id as StoredSignal['id'],
    prospectId: row.prospectId as StoredSignal['prospectId'],
    kind: row.kind,
    source: sourceOf(row),
    observedAt: row.observedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    detail: detailSchema.parse(row.detail),
  }
}

const kindsSchema = z.array(signalKindSettingSchema)

/** The exposed version: 0 until the first save, since a row may exist only for the fit criteria. */
function settingsOf(row: typeof signalSettings.$inferSelect | undefined): StoredSettings {
  if (row === undefined) {
    return { kinds: [], version: 0, updatedAt: null, webhook: { sealed: null, rotatedAt: null } }
  }
  const kinds = kindsSchema.parse(row.kinds)
  const sealed =
    row.webhookSecretCiphertext === null || row.webhookKeyId === null
      ? null
      : { keyId: row.webhookKeyId, ciphertext: new Uint8Array(row.webhookSecretCiphertext) }
  return {
    kinds,
    version: kinds.length === 0 ? 0 : row.version,
    updatedAt: kinds.length === 0 ? null : row.updatedAt.toISOString(),
    webhook: { sealed, rotatedAt: row.webhookRotatedAt?.toISOString() ?? null },
  }
}

/** The Signal store over Postgres: every call runs in one Organization-scoped transaction. */
export function createPostgresSignalStore(inOrganization: InOrganization): SignalStore {
  const lock = (tx: Parameters<Parameters<InOrganization>[1]>[0], organizationId: string) =>
    tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`)
  const readSettings = async (
    tx: Parameters<Parameters<InOrganization>[1]>[0],
    organizationId: string
  ) => {
    const [row] = await tx
      .select()
      .from(signalSettings)
      .where(eq(signalSettings.organizationId, organizationId))
    return row
  }
  return {
    settings: (organizationId) =>
      inOrganization(organizationId, async (tx) =>
        settingsOf(await readSettings(tx, organizationId))
      ),

    saveSettings: (organizationId, kinds: SignalKindSetting[], expectedVersion, at) =>
      inOrganization(organizationId, async (tx) => {
        await lock(tx, organizationId)
        const current = settingsOf(await readSettings(tx, organizationId))
        if (current.version !== expectedVersion) {
          throw new SettingsVersionConflictError()
        }
        const values = { kinds, version: expectedVersion + 1, updatedAt: new Date(at) }
        await tx
          .insert(signalSettings)
          .values({ organizationId, ...values })
          .onConflictDoUpdate({ target: signalSettings.organizationId, set: values })
        return settingsOf(await readSettings(tx, organizationId))
      }),

    setWebhookSecret: (organizationId, sealed, at) =>
      inOrganization(organizationId, async (tx) => {
        await lock(tx, organizationId)
        const values = {
          webhookSecretCiphertext: sealed.ciphertext,
          webhookKeyId: sealed.keyId,
          webhookRotatedAt: new Date(at),
        }
        await tx
          .insert(signalSettings)
          .values({ organizationId, kinds: [], ...values })
          .onConflictDoUpdate({ target: signalSettings.organizationId, set: values })
      }),

    record: (organizationId, signal, eventId) =>
      inOrganization(organizationId, async (tx) => {
        const inserted = await tx
          .insert(signals)
          .values({
            id: signal.id,
            organizationId,
            prospectId: signal.prospectId,
            kind: signal.kind,
            sourceType: signal.source.type,
            sourceProvider: signal.source.type === 'provider' ? signal.source.provider : null,
            sourceUserId: signal.source.type === 'manual' ? signal.source.userId : null,
            eventId,
            observedAt: new Date(signal.observedAt),
            recordedAt: new Date(signal.recordedAt),
            expiresAt: new Date(signal.expiresAt),
            detail: signal.detail,
          })
          .onConflictDoNothing()
          .returning()
        const [row] = inserted
        if (row !== undefined) {
          return { signal: signalOf(row), duplicate: false }
        }
        const [existing] = await tx
          .select()
          .from(signals)
          .where(
            and(
              eq(signals.organizationId, organizationId),
              or(
                eq(signals.id, signal.id),
                eventId === null ? undefined : eq(signals.eventId, eventId)
              )
            )
          )
          .limit(1)
        if (existing === undefined) {
          throw new Error('a Signal conflicted but none was found')
        }
        return { signal: signalOf(existing), duplicate: true }
      }),

    list: (organizationId, prospectId, filter) =>
      inOrganization(organizationId, async (tx) => {
        const after = filter.after
        const rows = await tx
          .select()
          .from(signals)
          .where(
            and(
              eq(signals.organizationId, organizationId),
              eq(signals.prospectId, prospectId),
              filter.kind === undefined ? undefined : eq(signals.kind, filter.kind),
              filter.expiresAfter === null
                ? undefined
                : gt(signals.expiresAt, new Date(filter.expiresAfter)),
              after === null
                ? undefined
                : or(
                    lt(signals.observedAt, new Date(after.observedAt)),
                    and(
                      eq(signals.observedAt, new Date(after.observedAt)),
                      lt(signals.id, after.id)
                    )
                  )
            )
          )
          .orderBy(desc(signals.observedAt), desc(signals.id))
          .limit(filter.limit + 1)
        const items = rows.slice(0, filter.limit).map(signalOf)
        const last = items.at(-1)
        return {
          items,
          next:
            rows.length > filter.limit && last !== undefined
              ? { observedAt: last.observedAt, id: last.id }
              : null,
        }
      }),

    get: (organizationId, signalId) =>
      inOrganization(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(signals)
          .where(and(eq(signals.organizationId, organizationId), eq(signals.id, signalId)))
        return row === undefined ? null : signalOf(row)
      }),
  }
}
