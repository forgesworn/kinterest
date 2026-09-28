import { describe, it, expect } from 'vitest'
import type { Account } from './types'
import { interestMinor, matchMinor, project, interestDue, interestEntry, balanceAsOf, effectiveDay, projectBalance, depositMinor, depositsInWindow, matchDue, matchEntry, matchWindowStart, type InterestConfig } from './interest'
import { creditEntry, reverseEntry, transferEntry } from './ledger'

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
  it('never reopens a period before the latest payout, even one that paid nothing', () => {
    // 08-07 paid 0 (no entry); 08-14 paid. 08-07 is closed by the watermark.
    const paid = interestEntry(cfg, acct, '2026-08-14', 10000, { id: 'e2', child: 'sam', createdAt: 1, author: 'guardian' })!
    expect(interestDue(cfg, [paid], now)).toEqual(['2026-08-21'])
  })
  it('a payout on another account does not move the watermark', () => {
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

describe('balanceAsOf / effectiveDay', () => {
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

describe('deposit match', () => {
  const acct: Account = { id: 'L', child: 'kid', name: 'With Mum & Dad', currency: 'GBP', custody: 'ledger' }
  const box: Account = { id: 'B', child: 'kid', name: 'Money box', currency: 'GBP', custody: 'physical' }
  const cfg: InterestConfig = {
    child: 'kid', account: 'L', rateBps: 0, cadence: 'weekly', day: 5, tz: 'Europe/London', startDay: '2026-08-01',
    matchBps: 5000, matchCapMinor: 300,
  }
  const at = (d: number, h = 10) => Date.UTC(2026, 7, d, h) / 1000
  const meta = (id: string, d: number) => ({ id, child: 'kid', createdAt: at(d), author: 'guardian' as const })

  it('counts credits given to the child, but not allowance, interest, match, spend refunds, transfers or adjustments', () => {
    const none = new Set<string>()
    expect(depositMinor(creditEntry(meta('g', 3), acct, 1000, 'gift'), 'L', none)).toBe(1000)
    expect(depositMinor(creditEntry(meta('m', 3), acct, 1000), 'L', none)).toBe(1000)
    expect(depositMinor(creditEntry(meta('a', 3), acct, 1000, 'allowance'), 'L', none)).toBe(0)
    expect(depositMinor(creditEntry(meta('i', 3), acct, 1000, 'interest'), 'L', none)).toBe(0)
    expect(depositMinor(creditEntry(meta('x', 3), acct, 1000, 'match'), 'L', none)).toBe(0)
    expect(depositMinor(creditEntry(meta('s', 3), acct, 1000, 'spend'), 'L', none)).toBe(0)
    expect(depositMinor(transferEntry(meta('t', 3), box, acct, 1000), 'L', none)).toBe(0)
    expect(depositMinor(creditEntry(meta('o', 3), box, 1000), 'L', none)).toBe(0) // another account
    const reversed = creditEntry(meta('r', 3), acct, 1000)
    expect(depositMinor(reversed, 'L', new Set(['r']))).toBe(0)
    expect(depositMinor(reverseEntry(reversed, meta('rr', 4)), 'L', none)).toBe(0)
  })

  it('a match window runs from the previous due day (inclusive) to the due day (exclusive), never before startDay', () => {
    expect(matchWindowStart(cfg, '2026-08-14')).toBe('2026-08-07')
    expect(matchWindowStart(cfg, '2026-08-07')).toBe('2026-08-01') // previous Friday 07-31 is before startDay
    expect(matchWindowStart({ cadence: 'monthly', day: 31, startDay: '2026-01-01' }, '2026-03-31')).toBe('2026-02-28')
  })

  it('sums deposits inside the window only', () => {
    const entries = [
      creditEntry(meta('d0', 6), acct, 50), // before the previous due day: previous window
      creditEntry(meta('d1', 7), acct, 100), // on the previous due day: this window
      creditEntry(meta('d2', 8), acct, 200),
      creditEntry(meta('d3', 14), acct, 300), // on the due day: next window
      creditEntry(meta('d4', 15), acct, 400),
    ]
    expect(depositsInWindow(entries, 'L', '2026-08-07', '2026-08-14', 'Europe/London')).toBe(300)
  })

  it('pays 50p per £1 deposited, capped per period, as a match credit carrying the periodKey', () => {
    const e = matchEntry(cfg, acct, '2026-08-14', 1000, { id: 'sched:match:kid:L:2026-08-14', child: 'kid', createdAt: at(14), author: 'guardian' })
    expect(e?.kind).toBe('credit')
    expect(e?.category).toBe('match')
    expect(e?.periodKey).toBe('2026-W33')
    expect(e?.legs[0]!.amountMinor).toBe(300) // 500 capped at 300
    expect(matchEntry(cfg, acct, '2026-08-14', 0, meta('z', 14))).toBeNull()
    expect(matchEntry({ ...cfg, matchCapMinor: undefined }, acct, '2026-08-14', 1000, meta('y', 14))!.legs[0]!.amountMinor).toBe(500)
  })

  it('matchDue is empty with no match configured, and idempotent by periodKey once paid', () => {
    expect(matchDue({ ...cfg, matchBps: undefined }, [], at(21))).toEqual([])
    expect(matchDue({ ...cfg, matchBps: 0 }, [], at(21))).toEqual([])
    expect(matchDue({ ...cfg, paused: true }, [], at(21))).toEqual([])
    expect(matchDue(cfg, [], at(21))).toEqual(['2026-08-07', '2026-08-14', '2026-08-21'])
    const paid = { ...creditEntry(meta('sched:match:kid:L:2026-08-14', 14), acct, 100, 'match'), periodKey: '2026-W33' }
    expect(matchDue(cfg, [paid], at(21))).toEqual(['2026-08-21'])
  })

  it('an interest payout closes match periods before its own period, not its own', () => {
    const interest = { ...creditEntry(meta('sched:interest:kid:L:2026-08-14', 14), acct, 10, 'interest'), kind: 'interest' as const, periodKey: '2026-W33' }
    expect(matchDue(cfg, [interest], at(21))).toEqual(['2026-08-14', '2026-08-21'])
  })

  it('a scheduled match counts as of the due day it pays for', () => {
    const e = { ...creditEntry({ id: 'sched:match:kid:L:2026-08-14', child: 'kid', createdAt: at(20), author: 'guardian' }, acct, 100, 'match'), periodKey: '2026-W33' }
    expect(effectiveDay(e, 'Europe/London')).toBe('2026-08-14')
  })
})

describe('projectBalance', () => {
  it('is the last point of the compounding path', () => {
    expect(projectBalance(1000, 1000, 4)).toBe(1464)
    expect(projectBalance(1000, 1000, 4)).toBe(project(1000, 1000, 4)[3])
  })
  it('returns the balance unchanged for 0 periods, and pays nothing on a non-positive balance', () => {
    expect(projectBalance(1234, 500, 0)).toBe(1234)
    expect(projectBalance(0, 500, 4)).toBe(0)
    expect(projectBalance(-50, 500, 4)).toBe(-50)
  })
  it('pays at least 1 minor unit per period on a positive balance', () => {
    expect(projectBalance(1, 1, 4)).toBe(5)
  })
  it('throws on bad periods or overflow', () => {
    expect(() => projectBalance(100, 100, -1)).toThrow(RangeError)
    expect(() => projectBalance(Number.MAX_SAFE_INTEGER, 10000, 1)).toThrow(RangeError)
  })
})

describe('project overflow guard', () => {
  it('throws when the running balance plus deposits leaves safe integers', () => {
    expect(() => project(Number.MAX_SAFE_INTEGER - 1, 0, 2, 1)).toThrow(RangeError)
  })
})
