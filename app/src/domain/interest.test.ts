import { describe, it, expect } from 'vitest'
import type { Account } from './types'
import { interestMinor, matchMinor, project, interestDue, interestEntry, balanceAsOf, effectiveDay, type InterestConfig } from './interest'
import { reverseEntry } from './ledger'

describe('interestMinor', () => {
  it('computes basis points on the balance', () => {
    expect(interestMinor(10000, 100)).toBe(100) // £100 at 1% → £1
    expect(interestMinor(1000, 100)).toBe(10)
  })
  it('rounds half-up in the child\'s favour', () => {
    expect(interestMinor(50, 100)).toBe(1) // raw 0.5p → 1p
    expect(interestMinor(49, 100)).toBe(1) // raw 0.49p rounds to 0 → floor of 1 applies
  })
  it('pays at least 1 minor unit on any positive balance', () => {
    expect(interestMinor(1, 1)).toBe(1)
  })
  it('pays nothing on zero or negative balances or rates', () => {
    expect(interestMinor(0, 500)).toBe(0)
    expect(interestMinor(-100, 500)).toBe(0)
    expect(interestMinor(100, 0)).toBe(0)
  })
  it('throws rather than silently corrupting on overflow', () => {
    expect(() => interestMinor(Number.MAX_SAFE_INTEGER, 10000)).toThrow(RangeError)
  })
})

describe('matchMinor', () => {
  it('matches deposits at the given rate', () => {
    expect(matchMinor(200, 5000)).toBe(100) // 50% match on £2
  })
  it('caps the match when a cap is set', () => {
    expect(matchMinor(10000, 5000, 300)).toBe(300)
  })
  it('never matches non-positive deposits', () => {
    expect(matchMinor(0, 5000)).toBe(0)
    expect(matchMinor(-500, 5000)).toBe(0)
  })
  it('throws rather than silently corrupting on overflow', () => {
    expect(() => matchMinor(Number.MAX_SAFE_INTEGER, 10000)).toThrow(RangeError)
  })
  it('rejects a negative match cap', () => {
    expect(() => matchMinor(1000, 5000, -1)).toThrow(RangeError)
  })
  it('validates the cap even when the deposit is non-positive', () => {
    expect(() => matchMinor(0, 5000, -999)).toThrow(RangeError)
  })
})

describe('project', () => {
  it('compounds period by period with the same rounding', () => {
    expect(project(10000, 100, 3)).toEqual([10100, 10201, 10303])
  })
  it('includes per-period deposits before interest', () => {
    // deposit 1000, then 1% interest on the new balance
    expect(project(0, 100, 2, 1000)).toEqual([1010, 2030])
  })
  it('returns empty for zero periods', () => {
    expect(project(500, 100, 0)).toEqual([])
  })
  it('rejects a negative period count', () => {
    expect(() => project(100, 100, -1)).toThrow(RangeError)
  })
  it('rejects a fractional period count', () => {
    expect(() => project(100, 100, 2.5)).toThrow(RangeError)
  })
  it('rejects a non-integer deposit per period', () => {
    expect(() => project(100, 100, 2, 4.5)).toThrow(RangeError)
  })
})

const acct: Account = { id: 'a-ledger', child: 'sam', name: 'With Mum & Dad', currency: 'GBP', custody: 'ledger' }
const cfg: InterestConfig = {
  child: 'sam', account: 'a-ledger', rateBps: 100,
  cadence: 'weekly', day: 5, tz: 'Europe/London', startDay: '2026-08-01',
}
// Friday 2026-08-21, 09:00 London (BST) = 08:00 UTC
const now = Date.UTC(2026, 7, 21, 8, 0) / 1000

describe('interestDue', () => {
  it('lists every unpaid due day since startDay', () => {
    expect(interestDue(cfg, [], now)).toEqual(['2026-08-07', '2026-08-14', '2026-08-21'])
  })
  it('is idempotent: paid periods (via periodKey) are excluded', () => {
    const paid = interestEntry(cfg, acct, '2026-08-07', 10000, { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })!
    expect(interestDue(cfg, [paid], now)).toEqual(['2026-08-14', '2026-08-21'])
  })
  it('paused pays nothing', () => {
    expect(interestDue({ ...cfg, paused: true }, [], now)).toEqual([])
  })
  it('R1: never reopens a period before the latest payout, even one that paid nothing', () => {
    // 08-07 paid 0 (no entry); 08-14 paid. 08-07 is closed by the watermark.
    const paid = interestEntry(cfg, acct, '2026-08-14', 10000, { id: 'e2', child: 'sam', createdAt: 1, author: 'guardian' })!
    expect(interestDue(cfg, [paid], now)).toEqual(['2026-08-21'])
  })
  it('R1: a payout on another account does not move the watermark', () => {
    const other: Account = { ...acct, id: 'other' }
    const paid = interestEntry({ ...cfg, account: 'other' }, other, '2026-08-14', 10000, { id: 'e3', child: 'sam', createdAt: 1, author: 'guardian' })!
    expect(interestDue(cfg, [paid], now)).toEqual(['2026-08-07', '2026-08-14', '2026-08-21'])
  })
  it('a reversed payment makes its period due again', () => {
    const paid = interestEntry(cfg, acct, '2026-08-07', 10000, { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })!
    const reversal = reverseEntry(paid, { id: 'e2', child: 'sam', createdAt: 2, author: 'guardian' })
    expect(interestDue(cfg, [paid, reversal], now)).toContain('2026-08-07')
  })
  it('changing the due weekday within a period does not double-pay', () => {
    const paid = interestEntry(cfg, acct, '2026-08-07', 10000, { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })!
    expect(interestDue({ ...cfg, day: 6 }, [paid], now)).not.toContain('2026-08-08')
  })
  it('an interest entry with a matching periodKey but a leg on a different account does not count as paid', () => {
    const paid = interestEntry(cfg, acct, '2026-08-07', 10000, { id: 'e1', child: 'sam', createdAt: 1, author: 'guardian' })!
    const elsewhere = { ...paid, id: 'e2', legs: [{ ...paid.legs[0]!, account: 'a-other' }] }
    expect(interestDue(cfg, [elsewhere], now)).toContain('2026-08-07')
  })
})

describe('interestEntry', () => {
  it('builds an interest credit carrying the period key', () => {
    const e = interestEntry(cfg, acct, '2026-08-14', 10000, { id: 'e9', child: 'sam', createdAt: 2, author: 'guardian' })!
    expect(e.kind).toBe('interest')
    expect(e.category).toBe('interest')
    expect(e.periodKey).toBe('2026-W33')
    expect(e.legs).toEqual([{ account: 'a-ledger', currency: 'GBP', amountMinor: 100 }])
    expect(e.note).toBe('Interest — 2026-08-14')
  })
  it('returns null when the balance earns nothing', () => {
    expect(interestEntry(cfg, acct, '2026-08-14', 0, { id: 'e9', child: 'sam', createdAt: 2, author: 'guardian' })).toBeNull()
  })
  it('refuses the wrong account', () => {
    const wrong: Account = { ...acct, id: 'a-box' }
    expect(() => interestEntry(cfg, wrong, '2026-08-14', 10000, { id: 'x', child: 'sam', createdAt: 2, author: 'guardian' }))
      .toThrow(/account/)
  })
  it('refuses a mismatched child', () => {
    expect(() => interestEntry(cfg, acct, '2026-08-14', 10000, { id: 'x', child: 'alex', createdAt: 2, author: 'guardian' }))
      .toThrow(/child/)
  })
})

describe('balanceAsOf / effectiveDay (audit D2)', () => {
  const leg = (amountMinor: number) => [{ account: 'acc', currency: 'GBP', amountMinor }]
  const at = Date.UTC(2026, 8, 20, 23, 30) / 1000 // 20 Sep 23:30 UTC = 21 Sep 00:30 London
  it('counts ordinary entries by createdAt in the config timezone', () => {
    const e = { v: 1 as const, id: 'x', child: 'c', kind: 'credit' as const, createdAt: at, author: 'guardian' as const, legs: leg(500) }
    expect(balanceAsOf([e], 'acc', '2026-09-20', 'UTC')).toBe(500)
    expect(balanceAsOf([e], 'acc', '2026-09-20', 'Europe/London')).toBe(0)
  })
  it('counts a guardian scheduler payout as of its own due day, never a child-authored look-alike', () => {
    const base = { v: 1 as const, child: 'c', kind: 'credit' as const, createdAt: at, legs: leg(500) }
    const sched = { ...base, id: 'sched:allowance:c:acc:2026-09-04', author: 'guardian' as const }
    const forged = { ...base, id: 'sched:allowance:c:acc:2026-09-04', author: 'child' as const }
    expect(effectiveDay(sched, 'UTC')).toBe('2026-09-04')
    expect(effectiveDay(forged, 'UTC')).toBe('2026-09-20')
  })
})
