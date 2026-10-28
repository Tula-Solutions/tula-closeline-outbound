import { describe, expect, test } from 'bun:test'
import {
  type CampaignId,
  type EnrollmentId,
  formatId,
  type MailboxId,
  type OrganizationId,
  type ProspectId,
} from 'tula-closeline-contract'
import type { InboundKind } from '~/ports/mail-transport'
import { createTestApp, newOrganizationId, newUserId, type TestIdentity } from '~/testing'
import { send } from '../send/service'
import { signUnsubscribe } from '../send/unsubscribe'
import * as MailEvents from './service'
import { SOFT_BOUNCE_LIMIT } from './service'
import { signWebhookState } from './state'

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
const EMAIL = 'buyer@example.com'
const BODY_MARKER = 'SECRET-BODY-TEXT-9f2c'

/** A Mailbox, a running Campaign and a Prospect with one message sent to them in an Enrollment. */
async function world(organizationId: OrganizationId = newOrganizationId()) {
  const t = await createTestApp()
  const owner: TestIdentity = { userId: newUserId(), organizationId, role: 'owner' }
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await t.app.request(path, {
      method,
      headers: {
        ...(await t.bearer(owner)),
        'content-type': 'application/json',
        'idempotency-key': `key-${crypto.randomUUID()}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return (await response.json()) as Record<string, unknown>
  }
  const started = await call('POST', '/v1/mailboxes/connect', { provider: 'gmail' })
  const url = new URL(started.authorizationUrl as string)
  const done = await call('POST', '/v1/mailboxes/connect/complete', {
    state: url.searchParams.get('state'),
    code: url.searchParams.get('code'),
  })
  const mailboxId = done.id as MailboxId
  const made = await call('POST', '/v1/campaigns', {
    name: 'Q3',
    goal: 'Book calls',
    audience: { kind: 'filter', status: 'active' },
    sendWindow: { timeZone: 'UTC', days: ['mon'], startMinute: 540, endMinute: 1020 },
    dailyCap: 50,
  })
  const campaignId = made.id as CampaignId
  await t.deps.campaigns.store.modify(organizationId, campaignId, (c) => ({
    ...c,
    state: 'running',
    sendWindow: OPEN,
  }))
  t.deps.clock.advance('10h')

  /** Enrolls a fresh Prospect (with an address in core) and sends it one message. */
  const prospect = async () => {
    const prospectId = formatId('prs', crypto.randomUUID()) as ProspectId
    const enrollmentId = formatId('enr', crypto.randomUUID()) as EnrollmentId
    const now = t.deps.clock.now().toISOString()
    t.deps.core.seed(organizationId, {
      id: prospectId,
      ownerId: owner.userId,
      values: { email: EMAIL },
    })
    await t.deps.campaigns.enrollments.insertIfAbsent(
      organizationId,
      {
        id: enrollmentId,
        campaignId,
        prospectId,
        attemptEpoch: 0,
        enrolledAt: now,
        completedAt: null,
        state: 'active',
        stopReason: null,
        currentStepKey: 'step-1',
        currentStep: 0,
        nextDueAt: now,
        stoppedAt: null,
      },
      []
    )
    t.deps.guard.allow({ organizationId, prospectId }, 'email')
    const sent = await send(t.deps.send, organizationId, {
      campaignId,
      prospectId,
      key: { enrollmentId, step: 0, attemptEpoch: 0 },
      recipient: { email: EMAIL, verified: true },
      acceptUnverified: false,
      mailboxIds: [mailboxId],
      message: { subject: 'Hello', text: 'Hi there' },
    })
    expect(sent.state).toBe('sent')
    return { prospectId, enrollmentId, threadId: sent.providerThreadId as string }
  }
  /** The provider delivers a notice about the thread; the Mailbox is then read. */
  const arrives = async (threadId: string, kind: InboundKind, id = crypto.randomUUID()) => {
    t.deps.mail.receive({
      providerMessageId: id,
      threadId,
      kind,
      receivedAt: t.deps.clock.now().toISOString(),
    })
    t.deps.clock.advance('1m')
    return (await MailEvents.pollMailbox(t.deps.inboundMail, organizationId, mailboxId)).handled
  }
  const enrollment = (id: EnrollmentId) => t.deps.campaigns.enrollments.find(organizationId, id)
  const token = (prospectId: ProspectId, at: OrganizationId = organizationId) =>
    signUnsubscribe(t.deps.env.MAIL_STATE_SECRET, {
      organizationId: at,
      prospectId,
      campaignId,
      expiresAt: Math.floor(t.deps.clock.now().getTime() / 1000) + 3600,
    })
  return { t, organizationId, mailboxId, campaignId, prospect, arrives, enrollment, token }
}

describe('mail events', () => {
  test('a hard bounce suppresses the address, stops the Enrollment and publishes once', async () => {
    const w = await world()
    const p = await w.prospect()
    expect(await w.arrives(p.threadId, 'hard_bounce')).toBe(1)
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([
      { email: EMAIL, why: 'bounce' },
    ])
    expect((await w.enrollment(p.enrollmentId))?.stopReason).toBe('hard_bounce')
    expect(w.t.deps.inboundEvents.map((e) => e.event.name)).toEqual(['mail.bounced'])
  })

  test('a soft bounce retries within a bound and the last one counts as hard', async () => {
    const w = await world()
    const p = await w.prospect()
    for (let i = 1; i < SOFT_BOUNCE_LIMIT; i++) {
      await w.arrives(p.threadId, 'soft_bounce')
      expect((await w.enrollment(p.enrollmentId))?.state).toBe('active')
    }
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([])
    await w.arrives(p.threadId, 'soft_bounce')
    expect((await w.enrollment(p.enrollmentId))?.stopReason).toBe('hard_bounce')
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toHaveLength(1)
    const kinds = w.t.deps.inboundEvents.flatMap((e) =>
      e.event.name === 'mail.bounced' ? [e.event.payload.kind] : []
    )
    expect(kinds).toEqual(['soft', 'soft', 'hard'])
  })

  test('a replayed soft bounce is not counted again and escalates nothing', async () => {
    const w = await world()
    const p = await w.prospect()
    const second = crypto.randomUUID()
    await w.arrives(p.threadId, 'soft_bounce')
    await w.arrives(p.threadId, 'soft_bounce', second)
    const notice = {
      providerMessageId: second,
      threadId: p.threadId,
      kind: 'soft_bounce' as const,
      receivedAt: w.t.deps.clock.now().toISOString(),
    }
    await MailEvents.ingest(w.t.deps.inboundMail, w.organizationId, w.mailboxId, notice)
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([])
    expect((await w.enrollment(p.enrollmentId))?.state).toBe('active')
    expect(w.t.deps.inboundEvents).toHaveLength(2)
  })

  test('a notice that fails is read again at the next poll', async () => {
    const w = await world()
    const p = await w.prospect()
    const real = w.t.deps.inboundMail.suppression
    let down = true
    const deps = {
      ...w.t.deps.inboundMail,
      suppression: {
        ...real,
        recordDeliveryFailure: async (...args: Parameters<typeof real.recordDeliveryFailure>) => {
          if (down) {
            throw new Error('core is down')
          }
          return real.recordDeliveryFailure(...args)
        },
      },
    }
    w.t.deps.mail.receive({
      providerMessageId: 'bounce-1',
      threadId: p.threadId,
      kind: 'hard_bounce',
      receivedAt: w.t.deps.clock.now().toISOString(),
    })
    w.t.deps.clock.advance('1m')
    await expect(MailEvents.pollMailbox(deps, w.organizationId, w.mailboxId)).rejects.toThrow(
      'the cursor stays'
    )
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([])
    down = false
    w.t.deps.clock.advance('1m')
    await MailEvents.pollMailbox(deps, w.organizationId, w.mailboxId)
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([
      { email: EMAIL, why: 'bounce' },
    ])
  })

  test('a complaint pauses the Mailbox once and suppresses the address', async () => {
    const w = await world()
    const p = await w.prospect()
    await w.arrives(p.threadId, 'complaint')
    const mailbox = await w.t.deps.mailboxes.store.find(w.organizationId, w.mailboxId)
    expect(mailbox?.state).toBe('paused')
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([
      { email: EMAIL, why: 'complaint' },
    ])
    expect((await w.enrollment(p.enrollmentId))?.stopReason).toBe('complaint')
    const paused = w.t.deps.mailEvents.filter((e) => e.event.reason === 'complaint_spike')
    expect(paused).toHaveLength(1)
  })

  test('a reply stops the sequence and publishes mail.replied; an out-of-office does not stop it', async () => {
    const w = await world()
    const a = await w.prospect()
    await w.arrives(a.threadId, 'out_of_office')
    expect((await w.enrollment(a.enrollmentId))?.state).toBe('active')
    await w.arrives(a.threadId, 'reply')
    expect((await w.enrollment(a.enrollmentId))?.stopReason).toBe('replied')
    expect(w.t.deps.inboundEvents.map((e) => e.event.name)).toEqual([
      'mail.out_of_office',
      'mail.replied',
    ])
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([])
  })

  test('a replayed notification changes nothing', async () => {
    const w = await world()
    const p = await w.prospect()
    const notice = {
      providerMessageId: 'msg-1',
      threadId: p.threadId,
      kind: 'complaint' as const,
      receivedAt: w.t.deps.clock.now().toISOString(),
    }
    const first = await MailEvents.ingest(
      w.t.deps.inboundMail,
      w.organizationId,
      w.mailboxId,
      notice
    )
    const again = await MailEvents.ingest(
      w.t.deps.inboundMail,
      w.organizationId,
      w.mailboxId,
      notice
    )
    expect([first, again]).toEqual(['handled', 'duplicate'])
    expect(w.t.deps.inboundEvents).toHaveLength(1)
    expect(w.t.deps.mailEvents.filter((e) => e.event.reason === 'complaint_spike')).toHaveLength(1)
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toHaveLength(1)
  })

  test('a notice for a thread we did not send is ignored', async () => {
    const w = await world()
    await w.prospect()
    expect(await w.arrives('thread-of-someone-else', 'reply')).toBe(0)
    expect(w.t.deps.inboundEvents).toEqual([])
  })

  test('no message body, address or token reaches the logs', async () => {
    const w = await world()
    const p = await w.prospect()
    const token = w.token(p.prospectId)
    w.t.deps.mail.receive({
      providerMessageId: 'msg-body',
      threadId: p.threadId,
      kind: 'hard_bounce',
      receivedAt: w.t.deps.clock.now().toISOString(),
      // A hostile provider notice: extra fields are never read.
      ...({ body: BODY_MARKER, snippet: BODY_MARKER } as object),
    })
    await MailEvents.pollMailbox(w.t.deps.inboundMail, w.organizationId, w.mailboxId)
    await MailEvents.unsubscribe(w.t.deps.inboundMail, token, 'link')
    await w.t.app.request(`/v1/public/mail/unsubscribe/${token}`)
    const logs = w.t.deps.logLines.join('\n')
    expect(logs).not.toContain(BODY_MARKER)
    expect(logs).not.toContain(EMAIL)
    expect(logs).not.toContain(token)
  })
})

describe('unsubscribe', () => {
  const post = (w: Awaited<ReturnType<typeof world>>, token: string, body?: string) =>
    w.t.app.request(`/v1/public/mail/unsubscribe/${token}`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }),
    })

  test('suppresses at once, with the same answer for a known and an unknown Prospect', async () => {
    const w = await world()
    const p = await w.prospect()
    const known = await post(w, w.token(p.prospectId), 'List-Unsubscribe=One-Click')
    const unknown = await post(w, w.token(formatId('prs', crypto.randomUUID()) as ProspectId))
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(await known.json()).toEqual(await unknown.json())
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([
      { email: EMAIL, why: 'unsubscribe' },
    ])
    expect((await w.enrollment(p.enrollmentId))?.stopReason).toBe('unsubscribed')
    const event = w.t.deps.inboundEvents[0]?.event
    expect(event).toMatchObject({ name: 'mail.unsubscribed', payload: { source: 'one_click' } })
    // Doing it again changes nothing.
    await post(w, w.token(p.prospectId))
    expect(w.t.deps.inboundEvents).toHaveLength(1)
  })

  test('the page answers a genuine token and nothing else', async () => {
    const w = await world()
    const p = await w.prospect()
    const page = await w.t.app.request(`/v1/public/mail/unsubscribe/${w.token(p.prospectId)}`)
    expect(page.status).toBe(200)
    expect(await page.json()).toEqual({ organizationName: 'the sender' })
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([])
  })

  test('a forged, tampered or expired token is refused and suppresses nothing', async () => {
    const w = await world()
    const p = await w.prospect()
    const real = w.token(p.prospectId)
    const forged = signUnsubscribe('x'.repeat(40), {
      organizationId: w.organizationId,
      prospectId: p.prospectId,
      campaignId: w.campaignId,
      expiresAt: 2_000_000_000,
    })
    const expired = real
    w.t.deps.clock.advance('800h')
    for (const token of [
      forged,
      `${real.slice(0, -1)}${real.endsWith('A') ? 'B' : 'A'}`,
      expired,
    ]) {
      const response = await post(w, token)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'unsubscribe.invalid_token' },
      })
    }
    expect(w.t.deps.suppression.suppressed(w.organizationId)).toEqual([])
  })

  test("a token for one Organization's Prospect cannot suppress in another", async () => {
    const a = await world()
    const pa = await a.prospect()
    const b = await world()
    const pb = await b.prospect()
    // Org B's Prospect id inside a token that names Org A: only Org A is touched, and A has no such Prospect.
    await MailEvents.unsubscribe(a.t.deps.inboundMail, a.token(pb.prospectId), 'link')
    expect(a.t.deps.suppression.suppressed(a.organizationId)).toEqual([])
    expect((await b.enrollment(pb.enrollmentId))?.state).toBe('active')
    // A's own token stops A's Enrollment and not B's.
    await MailEvents.unsubscribe(a.t.deps.inboundMail, a.token(pa.prospectId), 'link')
    expect((await a.enrollment(pa.enrollmentId))?.stopReason).toBe('unsubscribed')
    expect((await b.enrollment(pb.enrollmentId))?.state).toBe('active')
  })
})

describe('the Sequence engine', () => {
  test('a reply and an unsubscribe end the Prospect in every Campaign, not only the one that sent', async () => {
    const w = await world()
    const other = async (prospectId: ProspectId) => {
      const id = formatId('enr', crypto.randomUUID()) as EnrollmentId
      const now = w.t.deps.clock.now().toISOString()
      await w.t.deps.campaigns.enrollments.insertIfAbsent(
        w.organizationId,
        {
          id,
          campaignId: formatId('cpg', crypto.randomUUID()) as CampaignId,
          prospectId,
          attemptEpoch: 0,
          enrolledAt: now,
          completedAt: null,
          state: 'active',
          stopReason: null,
          currentStepKey: 'step-1',
          currentStep: 0,
          nextDueAt: now,
          stoppedAt: null,
        },
        []
      )
      return id
    }
    const p = await w.prospect()
    const second = await other(p.prospectId)
    await w.arrives(p.threadId, 'reply')
    expect((await w.enrollment(second))?.stopReason).toBe('replied')
    const q = await w.prospect()
    const third = await other(q.prospectId)
    await MailEvents.unsubscribe(w.t.deps.inboundMail, w.token(q.prospectId), 'link')
    expect((await w.enrollment(third))?.stopReason).toBe('unsubscribed')
  })
})

describe('webhooks', () => {
  /** Runs the queue until it has nothing left. */
  const drain = async (w: Awaited<ReturnType<typeof world>>) => {
    for (let i = 0; i < 10 && (await w.t.deps.consumer.pollOnce()) > 0; i++) {}
  }

  test('Gmail: a genuine state only queues a poll (nothing is read on the request); a missing or forged one is 401', async () => {
    const w = await world()
    const p = await w.prospect()
    w.t.deps.mail.receive({
      providerMessageId: 'msg-hook',
      threadId: p.threadId,
      kind: 'reply',
      receivedAt: w.t.deps.clock.now().toISOString(),
    })
    w.t.deps.clock.advance('1m')
    const state = signWebhookState(w.t.deps.env.MAIL_STATE_SECRET, w.organizationId, w.mailboxId)
    const url = '/v1/public/mail/webhooks/gmail'
    const bad = await w.t.app.request(`${url}?state=${state.slice(0, -2)}xx`, { method: 'POST' })
    const none = await w.t.app.request(url, { method: 'POST' })
    expect([bad.status, none.status]).toEqual([401, 401])
    expect(w.t.deps.queue.depth().visible).toBe(0)
    const ok = await w.t.app.request(`${url}?state=${state}`, { method: 'POST', body: '{}' })
    expect(ok.status).toBe(204)
    expect((await w.enrollment(p.enrollmentId))?.state).toBe('active')
    expect(w.t.deps.queue.depth().visible).toBe(1)
    await drain(w)
    expect((await w.enrollment(p.enrollmentId))?.stopReason).toBe('replied')
  })

  test('a long inbox is read a bounded page at a time, the queue carrying on until it is done', async () => {
    const w = await world()
    const p = await w.prospect()
    for (let i = 0; i < 120; i++) {
      w.t.deps.mail.receive({
        providerMessageId: `other-${i}`,
        threadId: `unrelated-${i}`,
        kind: 'reply',
        receivedAt: w.t.deps.clock.now().toISOString(),
      })
    }
    w.t.deps.mail.receive({
      providerMessageId: 'late',
      threadId: p.threadId,
      kind: 'reply',
      receivedAt: w.t.deps.clock.now().toISOString(),
    })
    w.t.deps.clock.advance('1m')
    await MailEvents.enqueuePoll(w.t.deps.inboundMail, w.organizationId, w.mailboxId)
    await w.t.deps.consumer.pollOnce()
    expect((await w.enrollment(p.enrollmentId))?.state).toBe('active')
    await drain(w)
    expect((await w.enrollment(p.enrollmentId))?.stopReason).toBe('replied')
  })

  test('a poll that fails is retried from the same cursor and loses nothing', async () => {
    const w = await world()
    const p = await w.prospect()
    w.t.deps.mail.receive({
      providerMessageId: 'msg-retry',
      threadId: p.threadId,
      kind: 'reply',
      receivedAt: w.t.deps.clock.now().toISOString(),
    })
    w.t.deps.clock.advance('1m')
    const deps = w.t.deps.inboundMail
    const real = deps.stopProspect
    let down = true
    deps.stopProspect = async (...args) => {
      if (down) {
        throw new Error('engine down')
      }
      return real(...args)
    }
    await expect(MailEvents.pollMailbox(deps, w.organizationId, w.mailboxId)).rejects.toThrow()
    down = false
    await MailEvents.pollMailbox(deps, w.organizationId, w.mailboxId)
    expect((await w.enrollment(p.enrollmentId))?.stopReason).toBe('replied')
  })

  test('Graph: the validation handshake echoes the token; notifications need a genuine clientState', async () => {
    const w = await world()
    const url = '/v1/public/mail/webhooks/graph'
    const handshake = await w.t.app.request(`${url}?validationToken=abc%20123`, { method: 'POST' })
    expect(handshake.status).toBe(200)
    expect(handshake.headers.get('content-type')).toContain('text/plain')
    expect(await handshake.text()).toBe('abc 123')
    const post = (clientState: string) =>
      w.t.app.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: [{ clientState }] }),
      })
    expect((await post('forged')).status).toBe(401)
    const state = signWebhookState(w.t.deps.env.MAIL_STATE_SECRET, w.organizationId, w.mailboxId)
    expect((await post(state)).status).toBe(202)
  })
})
