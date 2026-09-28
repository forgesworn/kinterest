import { describe, expect, it } from 'vitest'
import { exchangeEntry } from '../domain/ledger'
import type { Account } from '../domain/types'
import { firstAccountWithPartner, pickCounterpartId, suggestRate } from './QuickActions'

// Pure-logic coverage only — QuickActions.tsx's sheets are thin React forms
// (same split as PairDevice.tsx/Home.tsx: a tested pure helper, an
// untested-directly component). `suggestRate` is a thin wrapper over
// feed.ts's `lastExchangeRate` — see that module's own (more exhaustive)
// test file for the underlying scan's edge cases; this file only asserts
// suggestRate's own contract from the Exchange sheet's point of view.

const CHILD = 'sam'
const spending: Account = { id: 'acc-spend', child: CHILD, name: 'Spending', currency: 'GBP', custody: 'ledger' }
const savings: Account = { id: 'acc-save', child: CHILD, name: 'Savings', currency: 'GBP', custody: 'ledger' }
const euros: Account = { id: 'acc-eur', child: CHILD, name: 'Holiday', currency: 'EUR', custody: 'ledger' }
const btc: Account = { id: 'acc-btc', child: CHILD, name: 'Bitcoin', currency: 'BTC', custody: 'ledger' }
const AT = 1_755_000_000
const sameCurrency = (a: Account, from: Account): boolean => a.currency === from.currency
const differentCurrency = (a: Account, from: Account): boolean => a.currency !== from.currency

function meta(id: string, createdAt: number) {
  return { id, child: CHILD, createdAt, author: 'guardian' as const }
}

describe('suggestRate', () => {
  it('returns null with no prior exchange between the two currencies', () => {
    expect(suggestRate([], 'GBP', 'BTC')).toBeNull()
  })

  it('suggests the rate implied by the most recent matching-direction exchange', () => {
    const e = exchangeEntry(meta('e1', AT), spending, 1000, btc, 20000) // £10.00 -> 20,000 sats
    expect(suggestRate([e], 'GBP', 'BTC')).toBeCloseTo(0.00002, 10)
  })

  it('suggests the inverse rate for the opposite direction', () => {
    const e = exchangeEntry(meta('e1', AT), spending, 1000, btc, 20000)
    expect(suggestRate([e], 'BTC', 'GBP')).toBeCloseTo(50000, 6)
  })

  it('prefers the most recent of several prior exchanges', () => {
    const older = exchangeEntry(meta('e1', AT), spending, 1000, btc, 20000)
    const newer = exchangeEntry(meta('e2', AT + 60), spending, 1000, btc, 22000)
    expect(suggestRate([older, newer], 'GBP', 'BTC')).toBeCloseTo(0.000022, 10)
  })
})

describe('pickCounterpartId', () => {
  const accounts = [spending, savings, euros, btc]

  it('keeps the current counterpart when it is still compatible with the new from-account', () => {
    // fromId switches spending -> savings (both GBP); savings' counterpart
    // (euros, a different currency) stays a valid "different-currency" pick.
    expect(pickCounterpartId(accounts, savings.id, euros.id, differentCurrency)).toBe(euros.id)
  })

  it('picks a fresh counterpart when the current one is no longer compatible', () => {
    // fromId switches to savings (GBP); the current counterpart (btc, BTC)
    // is no longer a valid SAME-currency pick — spending (also GBP) is.
    expect(pickCounterpartId(accounts, savings.id, btc.id, sameCurrency)).toBe(spending.id)
  })

  it('never picks the from-account itself as its own counterpart', () => {
    const result = pickCounterpartId(accounts, spending.id, spending.id, sameCurrency)
    expect(result).not.toBe(spending.id)
    expect(result).toBe(savings.id)
  })

  it('returns "" when no compatible counterpart exists', () => {
    // The lone account, as its own would-be counterpart, is always excluded.
    expect(pickCounterpartId([spending], spending.id, '', differentCurrency)).toBe('')
    expect(pickCounterpartId([btc], btc.id, '', differentCurrency)).toBe('')
    // Two GBP accounts only — no OTHER currency to exchange with.
    expect(pickCounterpartId([spending, savings], spending.id, '', differentCurrency)).toBe('')
  })

  it('returns "" for an unknown from-account id rather than throwing', () => {
    expect(pickCounterpartId(accounts, 'does-not-exist', spending.id, sameCurrency)).toBe('')
  })
})

// Transfer must not default to (or get stuck on) a "from"
// account whose currency has no same-currency partner, when a compatible
// pair exists elsewhere in the list.
describe('firstAccountWithPartner', () => {
  it('picks accounts[0] when it already has a same-currency partner', () => {
    expect(firstAccountWithPartner([spending, savings], sameCurrency)).toBe(spending.id)
  })

  it('skips a lone odd-currency-out account[0], picking the first account that DOES have a partner', () => {
    // euros is alone in EUR; spending/savings are both GBP.
    const list = [euros, spending, savings]
    expect(firstAccountWithPartner(list, sameCurrency)).toBe(spending.id)
  })

  it('falls back to accounts[0] when nothing in the list has a partner at all', () => {
    const list = [spending, euros, btc] // every currency is unique
    expect(firstAccountWithPartner(list, sameCurrency)).toBe(spending.id)
  })

  it('works for the "different currency" (Exchange) compatibility rule too', () => {
    // spending (GBP) has no different-currency partner among [spending, savings]
    // alone, but euros makes one available for spending or savings.
    expect(firstAccountWithPartner([spending, savings, euros], differentCurrency)).toBe(spending.id)
  })
})
