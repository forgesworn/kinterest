import { describe, it, expect } from 'vitest'
import type { Account, Entry } from './types'
import {
  creditEntry,
  debitEntry,
  transferEntry,
  exchangeEntry,
  balances,
  reverseEntry,
  sortForDisplay,
  assertEntry,
  assertEntryAgainst,
  assertReversalOf,
} from './ledger'

const sam = 'sam'
const ledgerAcct: Account = { id: 'a-ledger', child: sam, name: 'With Mum & Dad', currency: 'GBP', custody: 'ledger' }
const moneyBox: Account = { id: 'a-box', child: sam, name: 'Money box', currency: 'GBP', custody: 'physical' }
const euros: Account = { id: 'a-eur', child: sam, name: 'Holiday euros', currency: 'EUR', custody: 'physical' }
const otherChild: Account = { id: 'a-other', child: 'alex', name: 'With Mum & Dad', currency: 'GBP', custody: 'ledger' }

const meta = (id: string, at = 1000) => ({ id, child: sam, createdAt: at, author: 'guardian' as const })

describe('entry construction', () => {
  it('credit has one positive leg on the account', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500, 'allowance')
    expect(e.kind).toBe('credit')
    expect(e.legs).toEqual([{ account: 'a-ledger', currency: 'GBP', amountMinor: 500 }])
    expect(e.category).toBe('allowance')
  })
  it('debit has one negative leg', () => {
    const e = debitEntry(meta('e2'), ledgerAcct, 600, 'purchase')
    expect(e.legs[0]!.amountMinor).toBe(-600)
  })
  it('rejects zero, negative, and float amounts', () => {
    expect(() => creditEntry(meta('x'), ledgerAcct, 0)).toThrow(RangeError)
    expect(() => creditEntry(meta('x'), ledgerAcct, -5)).toThrow(RangeError)
    expect(() => creditEntry(meta('x'), ledgerAcct, 4.5)).toThrow(RangeError)
  })
  it("rejects an account belonging to a different child", () => {
    expect(() => creditEntry(meta('x'), otherChild, 100)).toThrow(/child/)
  })
  it('transfer needs same currency, different accounts, same child', () => {
    const e = transferEntry(meta('e3'), moneyBox, ledgerAcct, 1000)
    expect(e.legs).toEqual([
      { account: 'a-box', currency: 'GBP', amountMinor: -1000 },
      { account: 'a-ledger', currency: 'GBP', amountMinor: 1000 },
    ])
    expect(() => transferEntry(meta('x'), moneyBox, euros, 100)).toThrow(/currency/)
    expect(() => transferEntry(meta('x'), moneyBox, moneyBox, 100)).toThrow(/same account/)
    expect(() => transferEntry(meta('x'), moneyBox, otherChild, 100)).toThrow(/child/)
  })
  it('exchange records both sides explicitly — the rate is implied, never computed', () => {
    const e = exchangeEntry(meta('e4'), euros, 2000, ledgerAcct, 1720)
    expect(e.kind).toBe('exchange')
    expect(e.legs).toEqual([
      { account: 'a-eur', currency: 'EUR', amountMinor: -2000 },
      { account: 'a-ledger', currency: 'GBP', amountMinor: 1720 },
    ])
    expect(() => exchangeEntry(meta('x'), moneyBox, 100, ledgerAcct, 100)).toThrow(/currenc/)
  })
})

describe('balances fold', () => {
  const entries: Entry[] = [
    creditEntry(meta('e1', 1), ledgerAcct, 500),
    creditEntry(meta('e2', 2), moneyBox, 300),
    transferEntry(meta('e3', 3), moneyBox, ledgerAcct, 200),
    debitEntry(meta('e4', 4), ledgerAcct, 150),
  ]
  it('folds to correct balances', () => {
    const b = balances(entries)
    expect(b.get('a-ledger')).toBe(550)
    expect(b.get('a-box')).toBe(100)
  })
  it('is order-independent', () => {
    const shuffled = [entries[3]!, entries[1]!, entries[0]!, entries[2]!]
    expect(balances(shuffled)).toEqual(balances(entries))
  })
})

describe('reversal', () => {
  it('reversal restores prior balances and links to the original', () => {
    const original = exchangeEntry(meta('e5', 5), euros, 2000, ledgerAcct, 1720)
    const reversal = reverseEntry(original, meta('e6', 6))
    expect(reversal.reverses).toBe('e5')
    expect(reversal.kind).toBe('exchange')
    const b = balances([original, reversal])
    expect(b.get('a-eur')).toBe(0)
    expect(b.get('a-ledger')).toBe(0)
  })
  it('refuses a reversal authored for a different child', () => {
    const original = creditEntry(meta('e7', 7), ledgerAcct, 500)
    expect(() => reverseEntry(original, { id: 'e8', child: 'alex', createdAt: 8, author: 'guardian' }))
      .toThrow(/child/)
  })
})

describe('assertEntry', () => {
  it('accepts a real credit entry', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500, 'allowance')
    expect(() => assertEntry(e)).not.toThrow()
  })
  it('accepts a real transfer entry', () => {
    const e = transferEntry(meta('e3'), moneyBox, ledgerAcct, 1000)
    expect(() => assertEntry(e)).not.toThrow()
  })
  it('rejects a NaN leg amount', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500)
    expect(() => assertEntry({ ...e, legs: [{ ...e.legs[0]!, amountMinor: NaN }] })).toThrow(RangeError)
  })
  it('rejects a float leg amount', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500)
    expect(() => assertEntry({ ...e, legs: [{ ...e.legs[0]!, amountMinor: 4.5 }] })).toThrow(RangeError)
  })
  it('rejects a zero leg amount', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500)
    expect(() => assertEntry({ ...e, legs: [{ ...e.legs[0]!, amountMinor: 0 }] })).toThrow(RangeError)
  })
  it('rejects an unknown currency', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500)
    expect(() => assertEntry({ ...e, legs: [{ ...e.legs[0]!, currency: 'DOGE' }] })).toThrow(RangeError)
  })
  it('rejects empty legs', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500)
    expect(() => assertEntry({ ...e, legs: [] })).toThrow(RangeError)
  })
  it('rejects 3 legs', () => {
    const e = transferEntry(meta('e1'), moneyBox, ledgerAcct, 100)
    expect(() => assertEntry({ ...e, legs: [...e.legs, e.legs[0]!] })).toThrow(RangeError)
  })
  it('rejects a credit with 2 legs', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500)
    const t = transferEntry(meta('e1'), moneyBox, ledgerAcct, 100)
    expect(() => assertEntry({ ...e, legs: t.legs })).toThrow(RangeError)
  })
  it('rejects a transfer with 1 leg', () => {
    const t = transferEntry(meta('e1'), moneyBox, ledgerAcct, 100)
    expect(() => assertEntry({ ...t, legs: [t.legs[0]!] })).toThrow(RangeError)
  })
  it('rejects an unknown kind', () => {
    const e = creditEntry(meta('e1'), ledgerAcct, 500)
    expect(() => assertEntry({ ...e, kind: 'bogus' as Entry['kind'] })).toThrow(RangeError)
  })
  it('rejects a negative createdAt', () => {
    const e = creditEntry(meta('e1', -1), ledgerAcct, 500)
    expect(() => assertEntry(e)).toThrow(RangeError)
  })
})

describe('sortForDisplay', () => {
  it('orders by createdAt then id', () => {
    const a = creditEntry({ id: 'B', child: sam, createdAt: 2, author: 'guardian' }, ledgerAcct, 1)
    const b = creditEntry({ id: 'A', child: sam, createdAt: 2, author: 'guardian' }, ledgerAcct, 1)
    const c = creditEntry({ id: 'Z', child: sam, createdAt: 1, author: 'guardian' }, ledgerAcct, 1)
    expect(sortForDisplay([a, b, c]).map((e) => e.id)).toEqual(['Z', 'A', 'B'])
  })
})

describe('assertEntry ledger invariants', () => {
  const meta = { id: 'e', child: 'sam', createdAt: 1, author: 'guardian' as const }
  const leg = (account: string, amountMinor: number, currency = 'GBP') => ({ account, currency, amountMinor })
  const entry = (kind: Entry['kind'], legs: Entry['legs'], extra: Partial<Entry> = {}): Entry => ({ v: 1, kind, legs, ...meta, ...extra })

  it.each([
    ['transfer that mints money (+100/+100)', entry('transfer', [leg('a', 100), leg('b', 100)])],
    ['transfer on one account', entry('transfer', [leg('a', -100), leg('a', 100)])],
    ['transfer across currencies', entry('transfer', [leg('a', -100), leg('b', 100, 'EUR')])],
    ['credit with a negative leg', entry('credit', [leg('a', -100)])],
    ['interest with a negative leg', entry('interest', [leg('a', -1)])],
    ['debit with a positive leg', entry('debit', [leg('a', 100)])],
    ['exchange with same-sign legs', entry('exchange', [leg('a', 100), leg('b', 90, 'EUR')])],
    ['exchange in one currency', entry('exchange', [leg('a', -100), leg('b', 100)])],
    ['an unsafe interest amount', entry('interest', [leg('a', 2 ** 53)])],
  ])('rejects %s', (_label, e) => {
    expect(() => assertEntry(e)).toThrow(RangeError)
  })

  it('accepts reversals of every kind (signs flipped) and signed adjustments', () => {
    const a: Account = { id: 'a', child: 'sam', name: 'A', currency: 'GBP', custody: 'ledger' }
    const b: Account = { id: 'b', child: 'sam', name: 'B', currency: 'GBP', custody: 'ledger' }
    const e: Account = { id: 'e', child: 'sam', name: 'E', currency: 'EUR', custody: 'ledger' }
    const originals = [creditEntry(meta, a, 100), debitEntry(meta, a, 100), transferEntry(meta, a, b, 100), exchangeEntry(meta, a, 100, e, 115)]
    for (const o of originals) {
      assertEntry(o)
      assertEntry(reverseEntry(o, { ...meta, id: `r-${o.kind}` }))
    }
    assertEntry(entry('adjustment', [leg('a', -250)], { auditId: 'x' }))
    assertEntry(entry('adjustment', [leg('a', 250)], { auditId: 'x' }))
  })
})

describe('assertEntryAgainst', () => {
  const accounts: Account[] = [
    { id: 'sam-gbp', child: 'sam', name: 'Spending', currency: 'GBP', custody: 'ledger' },
    { id: 'ella-gbp', child: 'ella', name: 'Spending', currency: 'GBP', custody: 'ledger' },
  ]
  const e = (account: string, currency = 'GBP'): Entry => ({ v: 1, id: 'e', child: 'sam', kind: 'debit', createdAt: 1, author: 'child', legs: [{ account, currency, amountMinor: -100 }] })
  it('accepts a leg on the entry child\'s own account in its currency', () => {
    expect(() => assertEntryAgainst(accounts, e('sam-gbp'))).not.toThrow()
  })
  it('rejects an unknown account, a sibling\'s account, and a currency mismatch', () => {
    expect(() => assertEntryAgainst(accounts, e('nope'))).toThrow(RangeError)
    expect(() => assertEntryAgainst(accounts, e('ella-gbp'))).toThrow(RangeError)
    expect(() => assertEntryAgainst(accounts, e('sam-gbp', 'EUR'))).toThrow(RangeError)
  })
})

describe('adjustment fields', () => {
  const adj: Entry = {
    v: 1, id: 'adj', child: sam, kind: 'adjustment', createdAt: 1, author: 'child',
    legs: [{ account: 'a-box', currency: 'GBP', amountMinor: -67 }],
  }
  it('an adjustment without auditId/countedMinor (stored or sent before they existed) still parses', () => {
    expect(() => assertEntry(adj)).not.toThrow()
  })
  it('accepts well-formed auditId and countedMinor', () => {
    expect(() => assertEntry({ ...adj, auditId: 'au1', countedMinor: 700 })).not.toThrow()
    expect(() => assertEntry({ ...adj, auditId: 'au1', countedMinor: 0 })).not.toThrow()
  })
  it('rejects malformed values, and countedMinor on any other kind', () => {
    expect(() => assertEntry({ ...adj, auditId: '' })).toThrow(RangeError)
    expect(() => assertEntry({ ...adj, countedMinor: -1 })).toThrow(RangeError)
    expect(() => assertEntry({ ...adj, countedMinor: 1.5 })).toThrow(RangeError)
    const credit = creditEntry({ id: 'c', child: sam, createdAt: 1, author: 'guardian' }, ledgerAcct, 100)
    expect(() => assertEntry({ ...credit, countedMinor: 100 })).toThrow(/only valid on an adjustment/)
  })
})

describe('sortForDisplay orders a catch-up by due day', () => {
  it('interleaves same-second scheduler payouts by due day: allowance, match, interest', () => {
    const at = 5000
    const mk = (kind: string, day: string): Entry => ({
      ...creditEntry({ id: `sched:${kind}:sam:a-ledger:${day}`, child: sam, createdAt: at, author: 'guardian' }, ledgerAcct, 100, kind),
    })
    const shuffled = [mk('interest', '2026-08-14'), mk('allowance', '2026-08-14'), mk('interest', '2026-08-07'), mk('match', '2026-08-14'), mk('allowance', '2026-08-07')]
    expect(sortForDisplay(shuffled).map((e) => e.id.split(':')[1] + '@' + e.id.split(':')[4])).toEqual([
      'allowance@2026-08-07', 'interest@2026-08-07', 'allowance@2026-08-14', 'match@2026-08-14', 'interest@2026-08-14',
    ])
  })
})

describe('balances overflow guard', () => {
  it('throws rather than return an unsafe sum', () => {
    const big = Number.MAX_SAFE_INTEGER
    const a = creditEntry({ id: 'a', child: sam, createdAt: 1, author: 'guardian' }, ledgerAcct, big)
    const b = creditEntry({ id: 'b', child: sam, createdAt: 2, author: 'guardian' }, ledgerAcct, 1)
    expect(() => balances([a, b])).toThrow(RangeError)
    expect(balances([a]).get('a-ledger')).toBe(big)
  })
})

describe('assertReversalOf', () => {
  const orig = creditEntry({ id: 'o', child: sam, createdAt: 1, author: 'guardian' }, ledgerAcct, 500)
  const m = { id: 'r', child: sam, createdAt: 2, author: 'guardian' as const }
  it('accepts an exact mirror', () => {
    expect(() => assertReversalOf(orig, reverseEntry(orig, m))).not.toThrow()
  })
  it('refuses a wrong target, child, kind, account, or amount', () => {
    const good = reverseEntry(orig, m)
    expect(() => assertReversalOf(orig, { ...good, reverses: 'x' })).toThrow(RangeError)
    expect(() => assertReversalOf(orig, { ...good, child: 'alex' })).toThrow(RangeError)
    expect(() => assertReversalOf(orig, { ...good, kind: 'interest' })).toThrow(RangeError)
    expect(() => assertReversalOf(orig, { ...good, legs: [{ ...good.legs[0]!, account: 'a-box' }] })).toThrow(RangeError)
    expect(() => assertReversalOf(orig, { ...good, legs: [{ ...good.legs[0]!, amountMinor: -1 }] })).toThrow(RangeError)
  })
})
