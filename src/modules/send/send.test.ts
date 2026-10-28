import { describe, expect, test } from 'bun:test'
import {
  type CampaignId,
  formatId,
  MAIL_ERRORS,
  type MailboxId,
  type OrganizationId,
  type ProspectId,
} from 'tula-closeline-contract'
import { MailTransportError } from '~/ports/mail-transport'
import type { MailboxRecord } from '~/ports/mailbox-store'
import type { SendStore } from '~/ports/send-store'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'
import type { SendDeps } from './deps'
import { REASON_CODES, reconcile, type SendRequest, send } from './service'

const OPEN = {
  timeZone: 'UTC',
  days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as (
    | 'sun'
    | 'mon'
    | 'tue'
    | 'wed'
    | 'thu'
    | 'fri'
    | 'sat'
  )[],
  startMinute: 0,
  endMinute: 1440,
}

type Seen = { from: string; at: number }

async function world(options: { env?: Record<string, string> } = {}) {
  const t = await createTestApp(options.env === undefined ? {} : { env: options.env })
  const org = newOrganizationId()
  const owner: TestIdentity = { userId: newUserId(), organizationId: org, role: 'owner' }
  const call = async (method: string, path: string, as: TestIdentity, body?: unknown) => {
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(as)),
        'content-type': 'application/json',
        'idempotency-key': `key-${crypto.randomUUID()}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const connect = async (as: TestIdentity = owner) => {
    const started = await call('POST', '/v1/mailboxes/connect', as, { provider: 'gmail' })
    const url = new URL(started.body.authorizationUrl as string)
    const done = await call('POST', '/v1/mailboxes/connect/complete', as, {
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
    })
    expect(done.status).toBe(201)
    return done.body.id as MailboxId
  }
  const campaign = async (state: 'running' | 'paused' = 'running') => {
    const made = await call('POST', '/v1/campaigns', owner, {
      name: 'Q3',
      goal: 'Book calls',
      audience: { kind: 'filter', status: 'active' },
      sendWindow: { timeZone: 'UTC', days: ['mon'], startMinute: 540, endMinute: 1020 },
      dailyCap: 50,
    })
    const id = made.body.id as CampaignId
    await t.deps.campaigns.store.modify(org, id, (c) => ({ ...c, state, sendWindow: OPEN }))
    return id
  }
  const seen: Seen[] = []
  /** Send deps over the test container: logs each provider call and may rewrite stored Mailboxes. */
  const depsOf = (
    patch: {
      record?: (r: MailboxRecord) => MailboxRecord
      store?: (s: SendStore) => SendStore
      send?: (real: () => Promise<unknown>) => Promise<unknown>
      cap?: number
    } = {}
  ): SendDeps => {
    const base = t.deps.mailboxes
    const gmail = base.transports.gmail
    if (gmail === undefined) {
      throw new Error('the test container has a Gmail stand-in')
    }
    return {
      ...t.deps.send,
      store: patch.store?.(t.deps.send.store) ?? t.deps.send.store,
      organizationDailyCap: patch.cap ?? t.deps.send.organizationDailyCap,
      mailboxes: {
        ...base,
        store: {
          ...base.store,
          find: async (o, id) => {
            const r = await base.store.find(o, id)
            return r === null || patch.record === undefined ? r : patch.record(r)
          },
        },
        transports: {
          ...base.transports,
          gmail: {
            ...gmail,
            send: async (token, message) => {
              seen.push({ from: message.from.address, at: t.deps.clock.now().getTime() })
              await patch.send?.(async () => undefined)
              return gmail.send(token, message)
            },
          },
        },
      },
    }
  }
  const request = (mailboxIds: MailboxId[], extra: Partial<SendRequest> = {}): SendRequest => ({
    campaignId: '' as CampaignId,
    prospectId: formatId('prs', crypto.randomUUID()) as ProspectId,
    key: { enrollmentId: formatId('enr', crypto.randomUUID()), step: 0, attemptEpoch: 0 },
    recipient: { email: 'buyer@example.com', verified: true },
    acceptUnverified: false,
    mailboxIds,
    message: { subject: 'Hello', text: 'Hi there' },
    ...extra,
  })
  /** A request ready to send: the Prospect may be emailed and the Campaign is running. */
  const ready = async (mailboxIds: MailboxId[], extra: Partial<SendRequest> = {}) => {
    const r = request(mailboxIds, { campaignId: await campaign(), ...extra })
    t.deps.guard.allow({ organizationId: org, prospectId: r.prospectId }, 'email')
    return r
  }
  // Thursday 10:00 UTC: inside every Mailbox's weekday window.
  t.deps.clock.advance('10h')
  return { t, org, owner, call, connect, campaign, depsOf, request, ready, seen }
}

const unsent = (w: Awaited<ReturnType<typeof world>>) => w.t.deps.mail.accepted().length

describe('send', () => {
  test('sends one message with the unsubscribe link and settles it as sent; a replay is a duplicate', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const deps = w.depsOf()
    const r = await w.ready([mailbox])
    const stored = await send(deps, w.org, r)
    expect(stored.state).toBe('sent')
    expect(stored.mailboxId).toBe(mailbox)
    expect(stored.providerMessageId).toBeTruthy()
    const message = w.t.deps.mail.accepted()[0]
    expect(message?.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/app\.test\/unsubscribe\?t=/)
    expect(message?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(message?.text).toContain('Hi there')
    expect(message?.text).toContain('https://app.test/unsubscribe?t=')
    await expect(send(deps, w.org, r)).rejects.toMatchObject({ code: 'send.duplicate' })
    expect(unsent(w)).toBe(1)
  })

  test('a Campaign that is not running refuses and sends nothing', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const r = await w.ready([mailbox], { campaignId: await w.campaign('paused') })
    const stored = await send(w.depsOf(), w.org, r)
    expect(stored).toMatchObject({ state: 'refused', reason: 'campaign_not_running' })
    expect(REASON_CODES[stored.reason as 'campaign_not_running']).toBe(
      MAIL_ERRORS['send.campaign_not_running'].code
    )
    expect(unsent(w)).toBe(0)
  })

  test('an unknown Campaign is send.not_found', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const r = await w.ready([mailbox], { campaignId: formatId('cpg', crypto.randomUUID()) })
    await expect(send(w.depsOf(), w.org, r)).rejects.toMatchObject({ code: 'send.not_found' })
  })

  test('outside the window defers to the next opening, then the same key sends', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const campaign = await w.campaign()
    await w.t.deps.campaigns.store.modify(w.org, campaign, (c) => ({
      ...c,
      sendWindow: { timeZone: 'UTC', days: ['fri'], startMinute: 540, endMinute: 1020 },
    }))
    const deps = w.depsOf()
    const r = await w.ready([mailbox], { campaignId: campaign })
    const first = await send(deps, w.org, r)
    expect(first).toMatchObject({ state: 'deferred', reason: 'outside_window' })
    expect(first.retryAt).toBe('2026-01-02T09:00:00.000Z')
    expect(unsent(w)).toBe(0)
    w.t.deps.clock.advance('23h')
    const second = await send(deps, w.org, r)
    expect(second).toMatchObject({ state: 'sent', id: first.id })
    expect(unsent(w)).toBe(1)
  })

  test('an unverified address refuses unless the Campaign accepts it', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const deps = w.depsOf()
    const r = await w.ready([mailbox], { recipient: { email: 'a@example.com', verified: false } })
    expect(await send(deps, w.org, r)).toMatchObject({
      state: 'refused',
      reason: 'unverified_address',
    })
    expect(unsent(w)).toBe(0)
    const ok = await w.ready([mailbox], {
      recipient: { email: 'a@example.com', verified: false },
      acceptUnverified: true,
    })
    expect((await send(deps, w.org, ok)).state).toBe('sent')
  })

  for (const environment of ['local', 'dev', 'prod']) {
    test(`the Contact Check refuses a suppressed or unconsented Prospect in ${environment}`, async () => {
      const w = await world({ env: { ENVIRONMENT: environment } })
      const mailbox = await w.connect()
      const deps = w.depsOf()
      const suppressed = await w.ready([mailbox])
      w.t.deps.guard.deny(
        { organizationId: w.org, prospectId: suppressed.prospectId },
        'email',
        'consent.suppressed'
      )
      expect(await send(deps, w.org, suppressed)).toMatchObject({
        state: 'refused',
        reason: 'suppressed',
      })
      const none = await w.ready([mailbox])
      w.t.deps.guard.deny(
        { organizationId: w.org, prospectId: none.prospectId },
        'email',
        'consent.missing'
      )
      expect(await send(deps, w.org, none)).toMatchObject({
        state: 'refused',
        reason: 'no_consent',
      })
      expect(unsent(w)).toBe(0)
    })
  }

  test('an unavailable Contact Check fails closed: refused, nothing sent', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const r = await w.ready([mailbox])
    w.t.deps.guard.setUnavailable()
    expect(await send(w.depsOf(), w.org, r)).toMatchObject({
      state: 'refused',
      reason: 'no_consent',
    })
    expect(unsent(w)).toBe(0)
  })

  test('a paused or unknown Mailbox refuses with mailbox_unavailable', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const r = await w.ready([mailbox])
    const paused = w.depsOf({ record: (m) => ({ ...m, state: 'paused' }) })
    expect(await send(paused, w.org, r)).toMatchObject({
      state: 'refused',
      reason: 'mailbox_unavailable',
    })
    const none = await w.ready([formatId('mbx', crypto.randomUUID()) as MailboxId])
    expect(await send(w.depsOf(), w.org, none)).toMatchObject({ reason: 'mailbox_unavailable' })
    expect(unsent(w)).toBe(0)
  })

  test('the Mailbox gap defers with the time it ends, and a limit never rotates a follow-up away', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const deps = w.depsOf()
    expect((await send(deps, w.org, await w.ready([mailbox]))).state).toBe('sent')
    const second = await send(deps, w.org, await w.ready([mailbox]))
    expect(second).toMatchObject({ state: 'deferred', reason: 'limit_reached' })
    expect(second.retryAt).toBe('2026-01-01T10:01:00.000Z')
    expect(unsent(w)).toBe(1)
  })

  test('the Organization daily cap defers until the next day', async () => {
    const w = await world()
    const a = await w.connect()
    const b = await w.connect()
    const deps = w.depsOf({ cap: 1 })
    expect((await send(deps, w.org, await w.ready([a, b]))).state).toBe('sent')
    const second = await send(deps, w.org, await w.ready([a, b]))
    expect(second).toMatchObject({ state: 'deferred', reason: 'organization_cap_reached' })
    expect(second.retryAt).toBe('2026-01-02T00:00:00.000Z')
    expect(unsent(w)).toBe(1)
  })

  test('rotation spreads sends over Mailboxes, and a follow-up keeps its Mailbox and thread', async () => {
    const w = await world()
    const a = await w.connect()
    const b = await w.connect()
    const deps = w.depsOf()
    const first = await send(deps, w.org, await w.ready([a, b]))
    w.t.deps.clock.advance('2m')
    const other = await send(deps, w.org, await w.ready([a, b]))
    expect(new Set([first.mailboxId, other.mailboxId])).toEqual(new Set([a, b]))
    w.t.deps.clock.advance('2m')
    const follow = await send(
      deps,
      w.org,
      await w.ready([a, b], {
        key: { ...{ enrollmentId: first.enrollmentId, step: 1, attemptEpoch: 0 } },
      })
    )
    expect(follow.mailboxId).toBe(first.mailboxId)
    expect(w.t.deps.mail.accepted()[2]?.threadId).toBe(first.providerThreadId ?? undefined)
  })

  test('a crash after the provider accepted leaves the row sending; a retry is a duplicate and reconcile settles it without sending again', async () => {
    const w = await world()
    const mailbox = await w.connect()
    let armed = true
    const deps = w.depsOf({
      store: (s) => ({
        ...s,
        settle: async (...args) => {
          if (armed && args[2].state === 'sent') {
            armed = false
            throw new Error('database went away')
          }
          return s.settle(...args)
        },
      }),
    })
    const r = await w.ready([mailbox])
    await expect(send(deps, w.org, r)).rejects.toThrow('database went away')
    expect(unsent(w)).toBe(1)
    const key = `${r.key.enrollmentId}:0:0`
    expect((await deps.store.find(w.org, key))?.state).toBe('sending')
    await expect(send(deps, w.org, r)).rejects.toMatchObject({ code: 'send.duplicate' })
    expect(await reconcile(deps, w.org)).toBe(0)
    w.t.deps.clock.advance('11m')
    expect(await reconcile(deps, w.org)).toBe(1)
    expect(await reconcile(deps, w.org)).toBe(0)
    expect((await deps.store.find(w.org, key))?.state).toBe('sent')
    expect(unsent(w)).toBe(1)
  })

  test('a provider timeout leaves the row sending and never sends again; other failures settle failed', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const timeout = w.depsOf({
      send: async () => {
        throw new MailTransportError('timeout')
      },
    })
    const r = await w.ready([mailbox])
    await expect(send(timeout, w.org, r)).rejects.toMatchObject({ code: 'server.timeout' })
    expect((await timeout.store.find(w.org, `${r.key.enrollmentId}:0:0`))?.state).toBe('sending')
    await expect(send(timeout, w.org, r)).rejects.toMatchObject({ code: 'send.duplicate' })

    w.t.deps.clock.advance('2m')
    const failing = w.depsOf()
    w.t.deps.mail.failProvider(1)
    const f = await w.ready([mailbox])
    await expect(send(failing, w.org, f)).rejects.toMatchObject({ code: 'server.unavailable' })
    expect((await failing.store.find(w.org, `${f.key.enrollmentId}:0:0`))?.state).toBe('failed')
    await expect(send(failing, w.org, f)).rejects.toMatchObject({ code: 'send.duplicate' })
  })

  test('another Organization cannot use or see this one', async () => {
    const w = await world()
    const mailbox = await w.connect()
    const deps = w.depsOf()
    const r = await w.ready([mailbox])
    expect((await send(deps, w.org, r)).state).toBe('sent')
    const other: OrganizationId = newOrganizationId()
    expect(await deps.store.find(other, `${r.key.enrollmentId}:0:0`)).toBeNull()
    const theirs = { ...r, key: { ...r.key, step: 5 } }
    await expect(send(deps, other, theirs)).rejects.toMatchObject({ code: 'send.not_found' })
    const stranger: TestIdentity = { userId: newUserId(), organizationId: other, role: 'owner' }
    const page = await w.call('GET', '/v1/mail/capacity', stranger)
    expect(page.status).toBe(200)
    expect(page.body.items).toEqual([])
  })

  test('1,000 attempts never exceed a Mailbox gap, hour, day or the Organization cap', async () => {
    const w = await world()
    const ids = [await w.connect(), await w.connect(), await w.connect()]
    const limits = { perDay: 20, perHour: 8, minGapSeconds: 120, window: OPEN }
    const deps = w.depsOf({
      cap: 40,
      record: (m) => ({
        ...m,
        state: 'healthy',
        rampStartedAt: '2025-01-01T00:00:00.000Z',
        limits,
      }),
    })
    const campaign = await w.campaign()
    let sent = 0
    for (let i = 0; i < 1000; i++) {
      const r = await w.ready(ids, { campaignId: campaign })
      const stored = await send(deps, w.org, r)
      sent += stored.state === 'sent' ? 1 : 0
      w.t.deps.clock.advance('90s')
    }
    expect(sent).toBeGreaterThan(40)
    expect(w.seen.length).toBe(sent)
    const by = (key: (s: Seen) => string) => {
      const counts = new Map<string, number>()
      for (const s of w.seen) {
        counts.set(key(s), (counts.get(key(s)) ?? 0) + 1)
      }
      return Math.max(...counts.values())
    }
    expect(by((s) => `${s.from}|${Math.floor(s.at / 3_600_000)}`)).toBeLessThanOrEqual(8)
    expect(by((s) => `${s.from}|${Math.floor(s.at / 86_400_000)}`)).toBeLessThanOrEqual(20)
    expect(by((s) => `${Math.floor(s.at / 86_400_000)}`)).toBeLessThanOrEqual(40)
    for (const from of new Set(w.seen.map((s) => s.from))) {
      const times = w.seen.filter((s) => s.from === from).map((s) => s.at)
      for (let i = 1; i < times.length; i++) {
        expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(120_000)
      }
    }
  }, 60_000)
})

describe('capacity', () => {
  test('shows what is left today and this hour, and when each Mailbox sends next', async () => {
    const w = await world()
    const mailbox = await w.connect()
    expect((await send(w.depsOf(), w.org, await w.ready([mailbox]))).state).toBe('sent')
    const page = await w.call('GET', '/v1/mail/capacity', w.owner)
    expect(page.status).toBe(200)
    expect(page.body).toMatchObject({
      organizationDailyCap: 500,
      organizationRemainingToday: 499,
      nextCursor: null,
      items: [
        {
          mailboxId: mailbox,
          usable: true,
          remainingToday: 9,
          remainingThisHour: 4,
          nextSendAt: '2026-01-01T10:01:00.000Z',
        },
      ],
    })
  })

  test('a Rep is refused and an anonymous call is unauthenticated', async () => {
    const w = await world()
    const rep: TestIdentity = { userId: newUserId(), organizationId: w.org, role: 'rep' }
    expect((await w.call('GET', '/v1/mail/capacity', rep)).status).toBe(403)
    const anonymous = await w.t.app.request('/v1/mail/capacity')
    expect(anonymous.status).toBe(401)
  })
})
