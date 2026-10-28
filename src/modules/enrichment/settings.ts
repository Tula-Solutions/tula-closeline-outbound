import {
  decodeCursor,
  ENRICHMENT_ERRORS,
  type EnrichmentBudget,
  ERRORS,
  encodeCursor,
  type FieldGroup,
  type OrganizationId,
  type ProviderKey,
  type ProviderSettings,
  type SetProviderRequest,
  type SetWaterfallRequest,
  type SpendEntry,
  type Waterfall,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { domainError } from '~/http/domain-error'
import { orderOf, type StoredProvider, versionOf } from '~/ports/provider-config'
import type { EnrichmentDeps } from './deps'
import { monthOf } from './waterfall'

const cursorSchema = z.object({ provider: z.string().max(64) })

/** What the deployment offers: each provider key and the groups it serves. */
function offered(deps: EnrichmentDeps): Map<ProviderKey, Set<FieldGroup>> {
  const out = new Map<ProviderKey, Set<FieldGroup>>()
  for (const p of deps.providers) {
    out.set(p.key, new Set([...(out.get(p.key) ?? []), ...p.groups]))
  }
  for (const v of deps.verifiers) {
    out.set(v.key, new Set([...(out.get(v.key) ?? []), 'email_verification' as const]))
  }
  return out
}

function viewOf(
  provider: ProviderKey,
  groups: Set<FieldGroup>,
  row: StoredProvider | undefined
): ProviderSettings {
  return {
    provider,
    enabled: row?.enabled ?? false,
    credentialSet: row?.credentialSet ?? false,
    credentialUpdatedAt: row?.credentialUpdatedAt ?? null,
    groups: [...groups].sort(),
    updatedAt: row?.updatedAt ?? null,
  }
}

/** Lists the providers this deployment offers with the Organization's switch and whether a key is stored. */
export async function listProviders(
  deps: EnrichmentDeps,
  caller: { organizationId: OrganizationId },
  query: { cursor?: string; limit: number }
): Promise<{ items: ProviderSettings[]; nextCursor: string | null }> {
  let after = ''
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor, cursorSchema)
    if (decoded === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    after = decoded.provider
  }
  const rows = new Map(
    (await deps.config.listStored(caller.organizationId)).map((row) => [row.provider, row])
  )
  const keys = [...offered(deps)].sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => k > after)
  const page = keys.slice(0, query.limit)
  const last = page.at(-1)
  return {
    items: page.map(([key, groups]) => viewOf(key, groups, rows.get(key))),
    nextCursor:
      keys.length > page.length && last !== undefined ? encodeCursor({ provider: last[0] }) : null,
  }
}

/** Switches a provider on or off and stores, removes or keeps the Organization's own key; the answer holds no key. */
export async function setProvider(
  deps: EnrichmentDeps,
  caller: { organizationId: OrganizationId },
  provider: ProviderKey,
  body: SetProviderRequest
): Promise<ProviderSettings> {
  const groups = offered(deps).get(provider)
  if (groups === undefined) {
    throw domainError(ENRICHMENT_ERRORS['enrichment.provider_unknown'])
  }
  let credential: Awaited<ReturnType<EnrichmentDeps['vault']['seal']>> | null | undefined
  if (typeof body.apiKey === 'string') {
    if (!deps.vault.configured) {
      throw domainError(ERRORS['server.unavailable'])
    }
    credential = await deps.vault.seal({
      organizationId: caller.organizationId,
      provider,
      plaintext: body.apiKey,
    })
  } else if (body.apiKey === null) {
    credential = null
  }
  const row = await deps.config.save(
    caller.organizationId,
    provider,
    { enabled: body.enabled, ...(credential === undefined ? {} : { credential }) },
    deps.clock.now()
  )
  return viewOf(provider, groups, row)
}

/** The order per group: the stored one, or while none is stored the default (by key). */
export async function getWaterfall(
  deps: EnrichmentDeps,
  caller: { organizationId: OrganizationId }
): Promise<Waterfall> {
  const rows = await deps.config.listStored(caller.organizationId)
  const version = versionOf(rows)
  if (version > 0) {
    const stamp =
      rows
        .map((r) => r.updatedAt ?? '')
        .sort()
        .at(-1) ?? null
    return { order: orderOf(rows), version, updatedAt: stamp === '' ? null : stamp } as Waterfall
  }
  const byGroup = (group: FieldGroup) =>
    [...offered(deps)]
      .filter(([, groups]) => groups.has(group))
      .map(([key]) => key)
      .sort((a, b) => a.localeCompare(b))
  return {
    order: {
      person: byGroup('person'),
      company: byGroup('company'),
      email_verification: byGroup('email_verification'),
    },
    version: 0,
    updatedAt: null,
  }
}

/** Saves the order per group; a stale `expectedVersion` is `version_conflict`, an unknown provider `invalid_waterfall`. */
export async function setWaterfall(
  deps: EnrichmentDeps,
  caller: { organizationId: OrganizationId },
  body: SetWaterfallRequest
): Promise<Waterfall> {
  const available = offered(deps)
  for (const group of ['person', 'company', 'email_verification'] as const) {
    for (const provider of body.order[group]) {
      if (!available.get(provider)?.has(group)) {
        throw domainError(ENRICHMENT_ERRORS['enrichment.invalid_waterfall'])
      }
    }
  }
  const saved = await deps.config.setOrder(
    caller.organizationId,
    body.order,
    body.expectedVersion,
    deps.clock.now()
  )
  if (saved === null) {
    throw domainError(ENRICHMENT_ERRORS['enrichment.version_conflict'])
  }
  return getWaterfall(deps, caller)
}

const spendCursorSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/),
  provider: z.string().max(64),
})

/** This month's budget: the limits from configuration, what is spent and held, and when it resets (UTC). */
export async function getBudget(
  deps: EnrichmentDeps,
  caller: { organizationId: OrganizationId }
): Promise<EnrichmentBudget> {
  const now = deps.clock.now()
  const month = monthOf(now)
  const spent = await deps.store.monthSpend(caller.organizationId, month)
  const limit = deps.limits.monthlyBudgetMicros
  return {
    month: month.slice(0, 7),
    monthlyLimitMicros: limit,
    perRunCeilingMicros: Math.min(deps.limits.runCeilingMicros, limit),
    spentMicros: spent,
    remainingMicros: Math.max(0, limit - spent),
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    version: 0,
    updatedAt: null,
  }
}

/** Lists spend by month and provider, newest month first, optionally for one month. */
export async function listSpend(
  deps: EnrichmentDeps,
  caller: { organizationId: OrganizationId },
  query: { cursor?: string | undefined; limit: number; month?: string | undefined }
): Promise<{ items: SpendEntry[]; nextCursor: string | null }> {
  let after: { month: string; provider: string } | undefined
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, spendCursorSchema)
    if (after === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
  }
  const page = await deps.store.listSpend(caller.organizationId, {
    month: query.month === undefined ? undefined : `${query.month}-01`,
    after,
    limit: query.limit,
  })
  return {
    items: page.items.map((row) => ({ ...row, month: row.month.slice(0, 7) })),
    nextCursor: page.next === null ? null : encodeCursor(page.next),
  }
}
