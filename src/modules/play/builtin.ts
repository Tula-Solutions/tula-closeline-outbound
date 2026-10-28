import {
  formatId,
  type Play,
  type PlayId,
  type PlayIntent,
  type Step,
} from 'tula-closeline-contract'

/** The creation time every built-in Play carries, so it sorts after every stored Play. */
export const BUILTIN_EPOCH = '1970-01-01T00:00:00.000Z'

const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 32)

/** An id that is the same for the same inputs, so a retry under one Idempotency-Key finds its first write. */
export const derivedPlayId = (name: string): PlayId => formatId('ply', sha(name))

const sequence = (first: string, followUp: string, waitHours: number): Step[] => [
  { kind: 'email', key: 'intro', goal: first, variants: null, next: 'pause' },
  { kind: 'wait', key: 'pause', waitHours, next: 'follow-up' },
  { kind: 'email', key: 'follow-up', goal: followUp, variants: null, next: 'done' },
  { kind: 'end', key: 'done' },
]

const BUILTIN: Record<PlayIntent, { name: string; goal: string; steps: Step[] }> = {
  cold_intro: {
    name: 'Cold intro',
    goal: 'Start a conversation with a Prospect who has not heard from us',
    steps: sequence(
      'Introduce us in two sentences and ask one question about their work',
      'Follow up once with one concrete benefit and a low-effort next step',
      72
    ),
  },
  closed_lost_reengagement: {
    name: 'Closed-lost re-engagement',
    goal: 'Reopen a conversation with a Prospect whose Deal was lost',
    steps: sequence(
      'Acknowledge the earlier conversation and share what has changed since',
      'Offer a short call to see whether the timing is better now',
      96
    ),
  },
  post_event_follow_up: {
    name: 'Post-event follow-up',
    goal: 'Follow up with a Prospect we met at an event while it is still fresh',
    steps: sequence(
      'Thank them for their time at the event and recall one thing they said',
      'Share one relevant resource and propose a time to talk',
      48
    ),
  },
  nurture: {
    name: 'Nurture',
    goal: 'Keep a Prospect who is not ready yet warm with useful, low-pressure notes',
    steps: sequence(
      'Share one useful idea related to their role, with no ask',
      'Check in lightly and ask whether priorities have changed',
      168
    ),
  },
}

/** The built-in Plays, one per intent: code, not data, because a stored Play always belongs to an Organization. */
export const BUILTIN_PLAYS: readonly Play[] = (
  Object.entries(BUILTIN) as [PlayIntent, (typeof BUILTIN)[PlayIntent]][]
).map(([intent, play]) => ({
  id: derivedPlayId(`builtin:${intent}`),
  ...play,
  intent,
  source: 'builtin',
  status: 'accepted',
  citations: [],
  evidenceCount: 0,
  noEvidence: true,
  createdByMembershipId: null,
  createdAt: BUILTIN_EPOCH,
  updatedAt: BUILTIN_EPOCH,
}))
