import {
  decodeCursor,
  ERRORS,
  encodeCursor,
  type ListMailboxesQuery,
  type MailCapacity,
  mailboxCursorSchema,
} from 'tula-closeline-contract'
import { domainError } from '~/http/domain-error'
import * as Mailboxes from '~/modules/mailbox/service'
import type { SendDeps } from './deps'
import { bucketsOf } from './limits'
import { nextOpen } from './window'

/**
 * What the Mailboxes the caller may see can still send today and this hour, and when each can
 * send next, with the Organization's remaining daily cap. One page, oldest connection first.
 */
export async function capacity(
  deps: SendDeps,
  caller: Mailboxes.MailboxCaller,
  query: Pick<ListMailboxesQuery, 'limit' | 'cursor'>
): Promise<MailCapacity> {
  let after = null
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, mailboxCursorSchema) ?? null
    if (after === null) {
      throw domainError(ERRORS['request.invalid'])
    }
  }
  const view = await Mailboxes.viewOf(deps.mailboxes, caller)
  const page = await deps.mailboxes.store.list(
    caller.organizationId,
    { visibleOwners: view.owners },
    after,
    Math.min(query.limit, Mailboxes.MAX_PAGE)
  )
  const now = deps.clock.now()
  const { dayStart, hourStart, nextHour, nextDay } = bucketsOf(now)
  const usage = await deps.store.usage(
    caller.organizationId,
    page.items.map((r) => r.id),
    dayStart.toISOString(),
    hourStart.toISOString()
  )
  const items = page.items.map((record) => {
    const { stopped, effective } = Mailboxes.effectiveLimitsOf(record, now)
    const used = usage.mailboxes[record.id] ?? { today: 0, thisHour: 0, lastAt: null }
    const remainingToday = Math.max(0, effective.perDay - used.today)
    const remainingThisHour = Math.min(
      Math.max(0, effective.perHour - used.thisHour),
      remainingToday
    )
    const usable = !stopped && effective.perDay > 0
    let nextSendAt: string | null = null
    if (usable) {
      let at = now
      if (used.lastAt !== null) {
        at = new Date(
          Math.max(at.getTime(), Date.parse(used.lastAt) + effective.minGapSeconds * 1000)
        )
      }
      if (remainingToday === 0) {
        at = new Date(Math.max(at.getTime(), nextDay.getTime()))
      } else if (remainingThisHour === 0) {
        at = new Date(Math.max(at.getTime(), nextHour.getTime()))
      }
      nextSendAt = nextOpen(record.limits.window, at).toISOString()
    }
    return {
      mailboxId: record.id,
      state: record.state,
      usable,
      remainingToday,
      remainingThisHour,
      nextSendAt,
    }
  })
  return {
    items,
    nextCursor: page.next === null ? null : encodeCursor(page.next),
    organizationRemainingToday: Math.max(0, deps.organizationDailyCap - usage.organizationToday),
    organizationDailyCap: deps.organizationDailyCap,
  }
}
