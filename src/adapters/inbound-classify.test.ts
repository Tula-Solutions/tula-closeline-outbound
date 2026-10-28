import { describe, expect, test } from 'bun:test'
import { classifyInbound } from './inbound-classify'

const base = {
  from: 'Ana <ana@prospect.test>',
  subject: 'Re: hello',
  contentType: 'text/plain',
  autoSubmitted: '',
}

describe('classifyInbound', () => {
  test('a person writing back is a reply', () => {
    expect(classifyInbound(base, 'rep@us.test')).toBe('reply')
  })
  test('the Mailbox itself is ignored', () => {
    expect(classifyInbound({ ...base, from: 'Rep <REP@us.test>' }, 'rep@us.test')).toBeNull()
  })
  test('a daemon is a hard bounce, or a soft one when the subject says delayed', () => {
    const daemon = {
      ...base,
      from: 'Mail Delivery <mailer-daemon@x.test>',
      contentType: 'multipart/report; report-type=delivery-status',
    }
    expect(classifyInbound({ ...daemon, subject: 'Undeliverable' }, 'rep@us.test')).toBe(
      'hard_bounce'
    )
    expect(classifyInbound({ ...daemon, subject: 'Delivery delayed' }, 'rep@us.test')).toBe(
      'soft_bounce'
    )
  })
  test('a daemon-looking sender without a delivery-status report is ignored', () => {
    const forged = { ...base, from: 'mailer-daemon@x.test', subject: 'Undeliverable' }
    expect(classifyInbound(forged, 'rep@us.test')).toBeNull()
  })
  test('a feedback report is a complaint and an auto reply is out of office', () => {
    const report = { ...base, contentType: 'multipart/report; report-type=feedback-report' }
    expect(classifyInbound(report, 'rep@us.test')).toBe('complaint')
    expect(classifyInbound({ ...base, autoSubmitted: 'auto-replied' }, 'rep@us.test')).toBe(
      'out_of_office'
    )
    expect(classifyInbound({ ...base, subject: 'Out of office: back Monday' }, 'rep@us.test')).toBe(
      'out_of_office'
    )
  })
})
