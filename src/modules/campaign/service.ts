import {
  CAMPAIGN_ERRORS,
  type Campaign,
  type CampaignId,
  campaignCursorSchema,
  type createCampaignRequestSchema,
  decodeCursor,
  ERRORS,
  type ErrorDefinition,
  encodeCursor,
  findSequenceProblems,
  formatId,
  type ListCampaignsQuery,
  MAX_VARIANTS,
  type MembershipId,
  MIN_VARIANTS,
  type OrganizationId,
  type Role,
  type Sequence,
  type SequenceProblem,
  type Step,
  type UserId,
  type updateCampaignRequestSchema,
  VARIANT_WEIGHT_TOTAL,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { z } from 'zod'
import { domainError } from '~/http/domain-error'
import type { CampaignFilter } from '~/ports/campaign-store'
import type { CampaignDeps } from './deps'

/** The largest page a list may ask for. */
export const MAX_PAGE = 100

/** Who is calling, as the verified token says. */
export type CampaignCaller = { userId: UserId; organizationId: OrganizationId; role: Role }

/** The body of a create, with the contract's defaults filled in. */
export type CreateBody = z.output<typeof createCampaignRequestSchema>

/** The body of an update. */
export type UpdateBody = z.output<typeof updateCampaignRequestSchema>

/** A body whose Steps passed the envelope but not yet the graph and variant rules. */
export type SequenceBody = { expectedVersion: number; steps: Step[] }

/** A Campaign and whether this call wrote it (a replay answers the stored one). */
export type Written = { campaign: Campaign; created: boolean }

function errorOf(code: keyof typeof CAMPAIGN_ERRORS): ErrorDefinition {
  return CAMPAIGN_ERRORS[code]
}

function notFound(): AppError {
  return domainError(errorOf('campaign.not_found'))
}

function invalidState(): AppError {
  return domainError(errorOf('campaign.invalid_state'))
}

/** An id that is the same for the same inputs, so a retry under one Idempotency-Key finds its first write. */
function derivedId(name: string): CampaignId {
  const hex = new Bun.CryptoHasher('sha256').update(name).digest('hex').slice(0, 32)
  return formatId('cpg', hex)
}

/** The Campaigns the caller may see: every owner's, or only these Memberships'. */
type View = { me: MembershipId; owners: readonly MembershipId[] | undefined }

async function viewOf(deps: CampaignDeps, caller: CampaignCaller): Promise<View> {
  const me = await deps.access.membershipIdOf(caller.organizationId, caller.userId)
  if (caller.role === 'owner' || caller.role === 'admin') {
    return { me, owners: undefined }
  }
  if (caller.role === 'manager') {
    const reps = await deps.access.teamRepIds(caller.organizationId, caller.userId)
    const memberships = await Promise.all(
      reps.map((rep) => deps.access.membershipIdOf(caller.organizationId, rep))
    )
    return { me, owners: [me, ...memberships] }
  }
  return { me, owners: [me] }
}

function sees(view: View, campaign: Campaign): boolean {
  return view.owners === undefined || view.owners.includes(campaign.ownerMembershipId)
}

/** The Campaign if the caller may see it; otherwise `campaign.not_found`, never a refusal. */
async function loadVisible(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId
): Promise<{ campaign: Campaign; view: View }> {
  const view = await viewOf(deps, caller)
  const campaign = await deps.store.find(caller.organizationId, id)
  if (campaign === null || !sees(view, campaign)) {
    throw notFound()
  }
  return { campaign, view }
}

/** Creates a draft Campaign owned by the caller; a repeat under the same key answers the first. */
export async function create(
  deps: CampaignDeps,
  caller: CampaignCaller,
  body: CreateBody,
  idempotencyKey: string
): Promise<Written> {
  if (body.playId !== null) {
    // Plays are not stored in this service yet, so no Play can be named.
    throw domainError(errorOf('play.not_found'))
  }
  const { me } = await viewOf(deps, caller)
  const now = deps.clock.now().toISOString()
  const campaign: Campaign = {
    id: derivedId(`${caller.organizationId}:create:${idempotencyKey}`),
    name: body.name,
    goal: body.goal,
    state: 'draft',
    audience: body.audience,
    audienceVersion: 1,
    sequenceVersion: 0,
    previewedVersion: null,
    previewedAt: null,
    approvalMode: body.approvalMode,
    language: body.language,
    sendWindow: body.sendWindow,
    windowZone: body.windowZone,
    dailyCap: body.dailyCap,
    ownerMembershipId: me,
    teamId: body.teamId,
    playId: body.playId,
    createdAt: now,
    updatedAt: now,
    launchedAt: null,
    archivedAt: null,
  }
  const written = await deps.store.insertIfAbsent(caller.organizationId, campaign, null, me)
  if (!written.created && !sameRequest(written.campaign, campaign)) {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  return written
}

/** What a create or duplicate request fixes about the Campaign it makes. */
function sameRequest(stored: Campaign, requested: Campaign): boolean {
  const fixed = (c: Campaign) => ({
    name: c.name,
    goal: c.goal,
    audience: c.audience,
    approvalMode: c.approvalMode,
    language: c.language,
    sendWindow: c.sendWindow,
    windowZone: c.windowZone,
    dailyCap: c.dailyCap,
    ownerMembershipId: c.ownerMembershipId,
    teamId: c.teamId,
    playId: c.playId,
  })
  return Bun.deepEquals(fixed(stored), fixed(requested))
}

/** Reads one Campaign the caller may see. */
export async function get(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId
): Promise<Campaign> {
  return (await loadVisible(deps, caller, id)).campaign
}

/** A newest-first page of the Campaigns the caller may see. */
export async function list(
  deps: CampaignDeps,
  caller: CampaignCaller,
  query: ListCampaignsQuery
): Promise<{ items: Campaign[]; nextCursor: string | null }> {
  let after = null
  if (query.cursor !== undefined) {
    const position = decodeCursor(query.cursor, campaignCursorSchema)
    if (position === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    after = position
  }
  const view = await viewOf(deps, caller)
  const filter: CampaignFilter = {
    visibleOwners: view.owners,
    state: query.state,
    ownerMembershipId: query.ownerMembershipId,
    teamId: query.teamId,
  }
  const page = await deps.store.list(
    caller.organizationId,
    filter,
    after,
    Math.min(query.limit, MAX_PAGE)
  )
  return { items: page.items, nextCursor: page.next === null ? null : encodeCursor(page.next) }
}

/** Changes a Campaign's settings; an audience or window change returns a ready Campaign to draft. */
export async function update(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId,
  body: UpdateBody
): Promise<Campaign> {
  await loadVisible(deps, caller, id)
  const now = deps.clock.now().toISOString()
  const changed = await deps.store.modify(caller.organizationId, id, (current) => {
    if (current.state === 'archived') {
      throw invalidState()
    }
    const audienceChanged =
      body.audience !== undefined && !Bun.deepEquals(body.audience, current.audience)
    const windowChanged =
      (body.sendWindow !== undefined && !Bun.deepEquals(body.sendWindow, current.sendWindow)) ||
      (body.windowZone !== undefined && body.windowZone !== current.windowZone)
    return {
      ...current,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.goal === undefined ? {} : { goal: body.goal }),
      ...(body.audience === undefined ? {} : { audience: body.audience }),
      ...(body.approvalMode === undefined ? {} : { approvalMode: body.approvalMode }),
      ...(body.sendWindow === undefined ? {} : { sendWindow: body.sendWindow }),
      ...(body.windowZone === undefined ? {} : { windowZone: body.windowZone }),
      ...(body.dailyCap === undefined ? {} : { dailyCap: body.dailyCap }),
      ...(body.teamId === undefined ? {} : { teamId: body.teamId }),
      audienceVersion: current.audienceVersion + (audienceChanged ? 1 : 0),
      state:
        current.state === 'ready' && (audienceChanged || windowChanged) ? 'draft' : current.state,
      updatedAt: now,
    }
  })
  if (changed === null) {
    throw notFound()
  }
  return changed
}

/** Copies a Campaign's settings, audience and Sequence into a new draft owned by the caller. */
export async function duplicate(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId,
  name: string,
  idempotencyKey: string
): Promise<Written> {
  const { campaign: source, view } = await loadVisible(deps, caller, id)
  const sequence =
    source.sequenceVersion === 0
      ? null
      : await deps.store.readSequence(caller.organizationId, id, source.sequenceVersion)
  const now = deps.clock.now().toISOString()
  const copy: Campaign = {
    ...source,
    id: derivedId(`${caller.organizationId}:duplicate:${id}:${idempotencyKey}`),
    name,
    state: 'draft',
    audienceVersion: 1,
    sequenceVersion: sequence === null ? 0 : 1,
    previewedVersion: null,
    previewedAt: null,
    ownerMembershipId: view.me,
    createdAt: now,
    updatedAt: now,
    launchedAt: null,
    archivedAt: null,
  }
  const written = await deps.store.insertIfAbsent(
    caller.organizationId,
    copy,
    sequence === null ? null : sequence.steps,
    view.me
  )
  if (!written.created && !sameRequest(written.campaign, copy)) {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  return written
}

/** Archives a Campaign; archiving an archived one changes nothing. */
export async function archive(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId
): Promise<Campaign> {
  await loadVisible(deps, caller, id)
  const now = deps.clock.now().toISOString()
  const changed = await deps.store.modify(caller.organizationId, id, (current) =>
    current.state === 'archived'
      ? current
      : { ...current, state: 'archived', archivedAt: now, updatedAt: now }
  )
  if (changed === null) {
    throw notFound()
  }
  return changed
}

/** Pauses a running Campaign; pausing a paused one changes nothing. */
export async function pause(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId
): Promise<Campaign> {
  await loadVisible(deps, caller, id)
  const now = deps.clock.now().toISOString()
  const changed = await deps.store.modify(caller.organizationId, id, (current) => {
    if (current.state === 'paused') {
      return current
    }
    if (current.state !== 'running') {
      throw invalidState()
    }
    return { ...current, state: 'paused', updatedAt: now }
  })
  if (changed === null) {
    throw notFound()
  }
  return changed
}

/** The Campaign's current Sequence; version 0 is the empty one. */
export async function getSequence(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId
): Promise<Sequence> {
  const { campaign } = await loadVisible(deps, caller, id)
  return currentSequence(deps, caller.organizationId, campaign)
}

async function currentSequence(
  deps: CampaignDeps,
  organizationId: OrganizationId,
  campaign: Campaign
): Promise<Sequence> {
  if (campaign.sequenceVersion === 0) {
    return emptySequence(campaign)
  }
  const found = await deps.store.readSequence(organizationId, campaign.id, campaign.sequenceVersion)
  if (found === null) {
    throw new Error(
      `campaign ${campaign.id} names Sequence version ${campaign.sequenceVersion}, which is not stored`
    )
  }
  return found
}

function emptySequence(campaign: Campaign): Sequence {
  return { campaignId: campaign.id, version: 0, steps: [], updatedAt: campaign.createdAt }
}

/** The error for a Sequence the graph rules refuse, naming each offending Step. */
function invalidSequence(problems: readonly SequenceProblem[]): AppError {
  const definition = errorOf('campaign.invalid_sequence')
  return new AppError({
    code: definition.code,
    status: definition.status,
    message: definition.message,
    details: { problems },
  })
}

/** Refuses a variant test whose size, weights or keys are wrong, naming its Step. */
function checkVariants(steps: readonly Step[]): void {
  for (const step of steps) {
    if (step.kind !== 'email' || step.variants === null) {
      continue
    }
    const { variants, promotion } = step.variants
    const weight = variants.reduce((sum, variant) => sum + variant.weight, 0)
    const keys = new Set(variants.map((variant) => variant.key))
    const valid =
      variants.length >= MIN_VARIANTS &&
      variants.length <= MAX_VARIANTS &&
      weight === VARIANT_WEIGHT_TOTAL &&
      keys.size === variants.length &&
      variants.every((variant) => variant.weight >= 1)
    if (!valid) {
      const definition = errorOf('variant.invalid_weights')
      throw new AppError({
        code: definition.code,
        status: definition.status,
        message: definition.message,
        details: { stepKey: step.key },
      })
    }
    if (promotion.mode === 'auto') {
      // The database keeps no automatic-promotion settings yet, so they cannot be stored.
      throw domainError(ERRORS['request.invalid'])
    }
  }
}

/** Saves the Steps as the next Sequence version after checking the graph and variants. */
export async function setSequence(
  deps: CampaignDeps,
  caller: CampaignCaller,
  id: CampaignId,
  body: SequenceBody
): Promise<Sequence> {
  const { campaign: seen, view } = await loadVisible(deps, caller, id)
  if (seen.state === 'archived') {
    throw invalidState()
  }
  const problems = findSequenceProblems(body.steps)
  if (problems.length > 0) {
    throw invalidSequence(problems)
  }
  checkVariants(body.steps)
  const now = deps.clock.now().toISOString()
  const saved = await deps.store.saveSequence(caller.organizationId, id, (campaign, current) => {
    if (campaign.state === 'archived') {
      throw invalidState()
    }
    // The same body again, as a client retries it, is the version already saved.
    const retry =
      current.version > 0 &&
      (body.expectedVersion === current.version || body.expectedVersion === current.version - 1) &&
      Bun.deepEquals(current.steps, body.steps)
    if (retry) {
      return { kind: 'unchanged' }
    }
    if (body.expectedVersion !== campaign.sequenceVersion) {
      throw domainError(errorOf('campaign.sequence_version_conflict'))
    }
    return {
      kind: 'save',
      campaign: {
        ...campaign,
        sequenceVersion: campaign.sequenceVersion + 1,
        state: campaign.state === 'ready' ? 'draft' : campaign.state,
        updatedAt: now,
      },
      steps: body.steps,
      createdBy: view.me,
    }
  })
  if (saved === null) {
    throw notFound()
  }
  return saved.sequence
}
