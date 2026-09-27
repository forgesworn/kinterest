import { describe, it, expect } from 'vitest'
import type { Account } from './types'
import { allowanceDue, allowanceEntry, legitimatePeriodKeys, periodKeyOf, type AllowanceConfig } from './allowance'
import { reverseEntry } from './ledger'

const acct: Account = { id: 'a-ledger', child: 'sam', name: 'With Mum & Dad', currency: 'GBP', custody: 'ledger' }
const cfg: AllowanceConfig = {
  child: 'sam', account: 'a-ledger', amountMinor: 500,
  cadence: 'weekly', day: 5, tz: 'Europe/London', startDay: '2026-08-01',
}
// Friday 2026-08-21, 09:00 London (BST) = 08:00 UTC
const now = Date.UTC(2026, 7, 21, 8, 0) / 1000

describe('allowanceDue', () => {
  it('lists every unpaid due day since startDay', () => {
    expect(allowanceDue(cfg, [], now)).toEqual(['2026-08-07', '2026-08-14', '2026-08-21'])
  })
  it('is idempotent: paid periods are excluded', () => {
    const paid = allowanceEntry(cfg, acct, '2026-08-07', { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })
    expect(allowanceDue(cfg, [paid], now)).toEqual(['2026-08-14', '2026-08-21'])
  })
  it('paused pays nothing', () => {
    expect(allowanceDue({ ...cfg, paused: true }, [], now)).toEqual([])
  })
  it('ignores foreign entries (other categories, other accounts)', () => {
    const paid = allowanceEntry(cfg, acct, '2026-08-07', { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })
    const other = { ...paid, id: 'e2', category: 'gift' }
    expect(allowanceDue(cfg, [other], now)).toContain('2026-08-07')
  })
  it('a reversed payment makes its period due again', () => {
    const paid = allowanceEntry(cfg, acct, '2026-08-07', { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })
    const reversal = reverseEntry(paid, { id: 'e2', child: 'sam', createdAt: 2, author: 'guardian' })
    expect(allowanceDue(cfg, [paid, reversal], now)).toContain('2026-08-07')
  })
})

describe('allowanceEntry', () => {
  it('builds a credit carrying the period key', () => {
    const e = allowanceEntry(cfg, acct, '2026-08-14', { id: 'e9', child: 'sam', createdAt: 2, author: 'guardian' })
    expect(e.kind).toBe('credit')
    expect(e.category).toBe('allowance')
    expect(e.periodKey).toBe('2026-W33')
    expect(e.legs[0]!.amountMinor).toBe(500)
  })
  it('refuses the wrong account', () => {
    const wrong: Account = { ...acct, id: 'a-box' }
    expect(() => allowanceEntry(cfg, wrong, '2026-08-14', { id: 'x', child: 'sam', createdAt: 2, author: 'guardian' }))
      .toThrow(/account/)
  })
})

describe('legitimatePeriodKeys', () => {
  it('contains exactly the period keys of every due day since startDay through now', () => {
    expect([...legitimatePeriodKeys(cfg, now)].sort()).toEqual(
      ['2026-08-07', '2026-08-14', '2026-08-21'].map((d) => periodKeyOf(cfg, d)).sort(),
    )
  })

  it('a hostile/fabricated periodKey is never in the set', () => {
    expect(legitimatePeriodKeys(cfg, now).has('xyz')).toBe(false)
    expect(legitimatePeriodKeys(cfg, now).has('')).toBe(false)
  })

  it('a far-future period (beyond today) is never in the set', () => {
    const farFuture = periodKeyOf(cfg, '2027-08-06') // a whole year past `now`
    expect(legitimatePeriodKeys(cfg, now).has(farFuture)).toBe(false)
  })

  it('a legitimate already-due period IS in the set, whether or not it has been paid', () => {
    expect(legitimatePeriodKeys(cfg, now).has(periodKeyOf(cfg, '2026-08-07'))).toBe(true)
  })

  it('does NOT gate on paused — a period due before a pause stays legitimate to claim', () => {
    expect(legitimatePeriodKeys({ ...cfg, paused: true }, now).has(periodKeyOf(cfg, '2026-08-07'))).toBe(true)
  })
})

describe('periodKey idempotence across a schedule change', () => {
  it('changing the due weekday within a period does not double-pay', () => {
    const paid = allowanceEntry(cfg, acct, '2026-08-07', { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })
    // day moved Friday(5) → Saturday(6); 2026-08-08 is in the same ISO week as 2026-08-07
    expect(allowanceDue({ ...cfg, day: 6 }, [paid], now)).not.toContain('2026-08-08')
  })
  it('an allowance entry with a matching periodKey but a leg on a different account does not count as paid', () => {
    const paid = allowanceEntry(cfg, acct, '2026-08-07', { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })
    const elsewhere = { ...paid, id: 'e2', legs: [{ ...paid.legs[0]!, account: 'a-other' }] }
    expect(allowanceDue(cfg, [elsewhere], now)).toContain('2026-08-07')
  })
})
