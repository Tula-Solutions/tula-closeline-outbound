import type { InboundKind } from '~/ports/mail-transport'

/** The few headers of an inbound message that decide what it is. */
export type InboundHeaders = {
  from: string
  subject: string
  contentType: string
  autoSubmitted: string
}

/** The most inbound messages one fetch returns. */
export const INBOUND_PAGE_SIZE = 50

/** A daemon sender with no delivery-status report is not trusted as a bounce, nor as a reply. */
const DAEMON = /(mailer-daemon|postmaster)@/i
const TEMPORARY = /\b(delayed|delay|temporar|warning)/i
const AUTO_REPLY = /^(automatic reply|auto(matic)?[ -]?reply|out of office)/i

/** Classifies an inbound message from its headers; null when it came from the Mailbox itself. */
export function classifyInbound(headers: InboundHeaders, ownAddress: string): InboundKind | null {
  const from = headers.from.toLowerCase()
  if (from.includes(ownAddress.toLowerCase())) {
    return null
  }
  if (/report-type=feedback-report/i.test(headers.contentType)) {
    return 'complaint'
  }
  if (/report-type=delivery-status/i.test(headers.contentType)) {
    return TEMPORARY.test(headers.subject) ? 'soft_bounce' : 'hard_bounce'
  }
  if (DAEMON.test(from)) {
    return null
  }
  if (
    (headers.autoSubmitted !== '' && headers.autoSubmitted.toLowerCase() !== 'no') ||
    AUTO_REPLY.test(headers.subject.trim())
  ) {
    return 'out_of_office'
  }
  return 'reply'
}
