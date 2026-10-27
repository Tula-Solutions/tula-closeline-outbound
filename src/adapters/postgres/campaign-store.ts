import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm'
import {
  type Campaign,
  type CampaignId,
  campaignSchema,
  type Sequence,
  type Step,
  stepSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  outboundCampaigns,
  outboundSequences,
  outboundSteps,
  outboundVariants,
} from 'tula-closeline-db/schema'
import type { CampaignStore } from '~/ports/campaign-store'
import type { InOrganization } from './store'

type CampaignRow = typeof outboundCampaigns.$inferSelect

/** The contract's Campaign from its row; the stored JSON is parsed, not trusted. */
function campaignOf(row: CampaignRow): Campaign {
  return campaignSchema.parse({
    id: row.id,
    name: row.name,
    goal: row.goal,
    state: row.state,
    audience: row.audience,
    audienceVersion: row.audienceVersion,
    sequenceVersion: row.sequenceVersion,
    previewedVersion: row.previewedVersion,
    previewedAt: row.previewedAt?.toISOString() ?? null,
    approvalMode: row.approvalMode,
    language: row.language,
    sendWindow: row.sendWindow,
    windowZone: row.windowZone,
    dailyCap: row.dailyCap,
    ownerMembershipId: row.ownerMembershipId,
    teamId: row.teamId,
    playId: row.playId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    launchedAt: row.launchedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  })
}

function dateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value)
}

/** The columns of a Campaign, as an insert or an update takes them. */
function rowOf(organizationId: string, campaign: Campaign) {
  return {
    id: campaign.id,
    organizationId,
    name: campaign.name,
    goal: campaign.goal,
    state: campaign.state,
    audience: campaign.audience,
    audienceVersion: campaign.audienceVersion,
    sequenceVersion: campaign.sequenceVersion,
    previewedVersion: campaign.previewedVersion,
    previewedAt: dateOrNull(campaign.previewedAt),
    approvalMode: campaign.approvalMode,
    language: campaign.language,
    sendWindow: campaign.sendWindow,
    windowZone: campaign.windowZone,
    dailyCap: campaign.dailyCap,
    ownerMembershipId: campaign.ownerMembershipId,
    teamId: campaign.teamId,
    playId: campaign.playId,
    createdAt: new Date(campaign.createdAt),
    updatedAt: new Date(campaign.updatedAt),
    launchedAt: dateOrNull(campaign.launchedAt),
    archivedAt: dateOrNull(campaign.archivedAt),
  }
}

/** A stored Step row. */
type StepRow = typeof outboundSteps.$inferSelect

/** A stored variant row. */
type VariantRow = typeof outboundVariants.$inferSelect

/** Reads a Campaign row, locking it when `lock` is set so two changes never interleave. */
async function load(tx: Transaction, organizationId: string, id: string, lock: boolean) {
  const query = tx
    .select()
    .from(outboundCampaigns)
    .where(and(eq(outboundCampaigns.organizationId, organizationId), eq(outboundCampaigns.id, id)))
  const [row] = await (lock ? query.for('update') : query)
  return row === undefined ? null : campaignOf(row)
}

/** The `steps` row of one Step at a position. */
function stepRow(
  scope: { organizationId: string; campaignId: string; version: number },
  step: Step,
  position: number
) {
  const base = { ...scope, position, key: step.key, kind: step.kind }
  switch (step.kind) {
    case 'email':
      return { ...base, goal: step.goal, nextKey: step.next }
    case 'wait':
      return { ...base, waitHours: step.waitHours, nextKey: step.next }
    case 'branch':
      return { ...base, arms: step.arms, defaultNextKey: step.default }
    case 'rep_task':
      return {
        ...base,
        task: step.task,
        instruction: step.instruction,
        dueInHours: step.dueInHours,
        nextKey: step.next,
      }
    case 'end':
      return base
  }
}

/** Writes the Steps (and the variants of each email Step) of one Sequence version. */
async function writeSteps(
  tx: Transaction,
  organizationId: string,
  campaignId: string,
  version: number,
  steps: readonly Step[]
): Promise<void> {
  const scope = { organizationId, campaignId, version }
  await tx
    .insert(outboundSteps)
    .values(steps.map((step, position) => stepRow(scope, step, position)))
  const variants = steps.flatMap((step) =>
    step.kind === 'email' && step.variants !== null
      ? step.variants.variants.map((variant, position) => ({
          ...scope,
          stepKey: step.key,
          key: variant.key,
          position,
          label: variant.label,
          angle: variant.angle,
          weight: variant.weight,
        }))
      : []
  )
  if (variants.length > 0) {
    await tx.insert(outboundVariants).values(variants)
  }
}

/** The Step a `steps` row stands for, with the variants stored under it. */
function stepOf(row: StepRow, variantRows: readonly VariantRow[]): Step {
  switch (row.kind) {
    case 'email': {
      const own = variantRows.filter((variant) => variant.stepKey === row.key)
      return stepSchema.parse({
        kind: 'email',
        key: row.key,
        goal: row.goal,
        variants:
          own.length === 0
            ? null
            : {
                variants: own.map((variant) => ({
                  key: variant.key,
                  label: variant.label,
                  angle: variant.angle,
                  weight: variant.weight,
                })),
                // The database keeps no automatic-promotion settings, so a stored test is manual.
                promotion: { mode: 'manual' },
              },
        next: row.nextKey,
      })
    }
    case 'wait':
      return stepSchema.parse({
        kind: 'wait',
        key: row.key,
        waitHours: row.waitHours,
        next: row.nextKey,
      })
    case 'branch':
      return stepSchema.parse({
        kind: 'branch',
        key: row.key,
        arms: row.arms,
        default: row.defaultNextKey,
      })
    case 'rep_task':
      return stepSchema.parse({
        kind: 'rep_task',
        key: row.key,
        task: row.task,
        instruction: row.instruction,
        dueInHours: row.dueInHours,
        next: row.nextKey,
      })
    case 'end':
      return stepSchema.parse({ kind: 'end', key: row.key })
  }
}

/** One version of a Sequence rebuilt from its rows, or null when that version is not stored. */
async function readVersion(
  tx: Transaction,
  organizationId: string,
  campaignId: string,
  version: number
): Promise<Sequence | null> {
  const [sequence] = await tx
    .select()
    .from(outboundSequences)
    .where(
      and(
        eq(outboundSequences.organizationId, organizationId),
        eq(outboundSequences.campaignId, campaignId),
        eq(outboundSequences.version, version)
      )
    )
  if (sequence === undefined) {
    return null
  }
  const rows = await tx
    .select()
    .from(outboundSteps)
    .where(
      and(
        eq(outboundSteps.organizationId, organizationId),
        eq(outboundSteps.campaignId, campaignId),
        eq(outboundSteps.version, version)
      )
    )
    .orderBy(asc(outboundSteps.position))
  const variantRows = await tx
    .select()
    .from(outboundVariants)
    .where(
      and(
        eq(outboundVariants.organizationId, organizationId),
        eq(outboundVariants.campaignId, campaignId),
        eq(outboundVariants.version, version)
      )
    )
    .orderBy(asc(outboundVariants.position))
  const steps = rows.map((row) => stepOf(row, variantRows))
  return {
    campaignId: campaignId as CampaignId,
    version,
    steps,
    updatedAt: sequence.createdAt.toISOString(),
  }
}

/** The Campaign store over Postgres: every call runs in one Organization-scoped transaction. */
export function createPostgresCampaignStore(inOrganization: InOrganization): CampaignStore {
  return {
    insertIfAbsent: (organizationId, campaign, steps, createdBy) =>
      inOrganization(organizationId, async (tx) => {
        const inserted = await tx
          .insert(outboundCampaigns)
          .values(rowOf(organizationId, campaign))
          .onConflictDoNothing()
          .returning({ id: outboundCampaigns.id })
        if (inserted.length === 0) {
          const existing = await load(tx, organizationId, campaign.id, false)
          if (existing === null) {
            throw new Error(`campaign ${campaign.id} neither inserted nor found`)
          }
          return { campaign: existing, created: false }
        }
        if (steps !== null) {
          await tx.insert(outboundSequences).values({
            organizationId,
            campaignId: campaign.id,
            version: campaign.sequenceVersion,
            createdByMembershipId: createdBy,
            createdAt: new Date(campaign.createdAt),
          })
          await writeSteps(tx, organizationId, campaign.id, campaign.sequenceVersion, steps)
        }
        return { campaign, created: true }
      }),

    find: (organizationId, id) =>
      inOrganization(organizationId, (tx) => load(tx, organizationId, id, false)),

    list: (organizationId, filter, after, limit) =>
      inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(outboundCampaigns)
          .where(
            and(
              eq(outboundCampaigns.organizationId, organizationId),
              filter.visibleOwners === undefined
                ? undefined
                : inArray(outboundCampaigns.ownerMembershipId, [...filter.visibleOwners]),
              filter.state === undefined ? undefined : eq(outboundCampaigns.state, filter.state),
              filter.ownerMembershipId === undefined
                ? undefined
                : eq(outboundCampaigns.ownerMembershipId, filter.ownerMembershipId),
              filter.teamId === undefined ? undefined : eq(outboundCampaigns.teamId, filter.teamId),
              after === null
                ? undefined
                : or(
                    lt(outboundCampaigns.createdAt, new Date(after.createdAt)),
                    and(
                      eq(outboundCampaigns.createdAt, new Date(after.createdAt)),
                      lt(outboundCampaigns.id, after.id)
                    )
                  )
            )
          )
          .orderBy(desc(outboundCampaigns.createdAt), desc(outboundCampaigns.id))
          .limit(limit + 1)
        const items = rows.slice(0, limit).map(campaignOf)
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
          .update(outboundCampaigns)
          .set(rowOf(organizationId, next))
          .where(
            and(eq(outboundCampaigns.organizationId, organizationId), eq(outboundCampaigns.id, id))
          )
        return next
      }),

    readSequence: (organizationId, id, version) =>
      inOrganization(organizationId, (tx) => readVersion(tx, organizationId, id, version)),

    saveSequence: (organizationId, id, decide) =>
      inOrganization(organizationId, async (tx) => {
        const campaign = await load(tx, organizationId, id, true)
        if (campaign === null) {
          return null
        }
        const current =
          campaign.sequenceVersion === 0
            ? { campaignId: id, version: 0, steps: [], updatedAt: campaign.createdAt }
            : await readVersion(tx, organizationId, id, campaign.sequenceVersion)
        if (current === null) {
          throw new Error(`campaign ${id} names Sequence version ${campaign.sequenceVersion}`)
        }
        const decision = decide(campaign, current)
        if (decision.kind === 'unchanged') {
          return { campaign, sequence: current }
        }
        const version = decision.campaign.sequenceVersion
        await tx.insert(outboundSequences).values({
          organizationId,
          campaignId: id,
          version,
          createdByMembershipId: decision.createdBy,
          createdAt: new Date(decision.campaign.updatedAt),
        })
        await writeSteps(tx, organizationId, id, version, decision.steps)
        await tx
          .update(outboundCampaigns)
          .set(rowOf(organizationId, decision.campaign))
          .where(
            and(eq(outboundCampaigns.organizationId, organizationId), eq(outboundCampaigns.id, id))
          )
        return {
          campaign: decision.campaign,
          sequence: {
            campaignId: id,
            version,
            steps: [...decision.steps],
            updatedAt: decision.campaign.updatedAt,
          },
        }
      }),
  }
}
