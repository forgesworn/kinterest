import { describe, it, expect } from 'vitest'
import type { AuditResult } from '../domain/audit'
import type { Entry } from '../domain/types'
import {
  auditOutcome,
  coinCountTotal,
  denominationRows,
  emptyCoinCounts,
  entriesSinceLastAudit,
  lastAuditFor,
  setCoinCount,
  type CoinCounts,
} from './coinCount'

describe('denominationRows', () => {
  it('GBP runs 1p to £50 note', () => {
    const rows = denominationRows('GBP')
    expect(rows[0]).toEqual({ label: '1p', minor: 1 })
    expect(rows[rows.length - 1]).toEqual({ label: '£50 note', minor: 5000 })
  })

  it('an unknown/uncounted currency (e.g. BTC) has no rows', () => {
    expect(denominationRows('BTC')).toEqual([])
  })
})

describe('emptyCoinCounts', () => {
  it('zeroes every denomination for the currency', () => {
    const counts = emptyCoinCounts('GBP')
    expect(Object.keys(counts)).toHaveLength(denominationRows('GBP').length)
    expect(Object.values(counts).every((qty) => qty === 0)).toBe(true)
  })

  it('is empty for a currency with no denomination table', () => {
    expect(emptyCoinCounts('BTC')).toEqual({})
  })
})

describe('setCoinCount', () => {
  it('sets a denomination immutably', () => {
    const c0 = emptyCoinCounts('GBP')
    const c1 = setCoinCount(c0, 100, 3)
    expect(c1).not.toBe(c0)
    expect(c1[100]).toBe(3)
    expect(c0[100]).toBe(0) // c0 untouched
  })

  it('refuses a negative quantity — same reference back', () => {
    const c0 = emptyCoinCounts('GBP')
    const c1 = setCoinCount(c0, 100, -1)
    expect(c1).toBe(c0)
  })

  it('refuses a non-integer quantity — same reference back', () => {
    const c0 = emptyCoinCounts('GBP')
    const c1 = setCoinCount(c0, 100, 1.5)
    expect(c1).toBe(c0)
  })

  it('a fresh minor key not already present is still set (a currency-agnostic setter)', () => {
    const c1 = setCoinCount({}, 500, 2)
    expect(c1).toEqual({ 500: 2 })
  })
})

describe('coinCountTotal', () => {
  it('adds up mixed coins via countTotal', () => {
    // 7×1p + 3×20p + 2×£1 + 1×£5 note = 7 + 60 + 200 + 500 = 767
    let counts: CoinCounts = emptyCoinCounts('GBP')
    counts = setCoinCount(counts, 1, 7)
    counts = setCoinCount(counts, 20, 3)
    counts = setCoinCount(counts, 100, 2)
    counts = setCoinCount(counts, 500, 1)
    expect(coinCountTotal(counts)).toBe(767)
  })

  it('an all-zero count totals to 0', () => {
    expect(coinCountTotal(emptyCoinCounts('GBP'))).toBe(0)
  })

  it('an empty count (no denomination table) totals to 0 without throwing', () => {
    expect(coinCountTotal({})).toBe(0)
  })
})

describe('auditOutcome', () => {
  it('matches on exact equality', () => {
    expect(auditOutcome(767, 767)).toBe('match')
  })

  it('a 1p delta either way is a mismatch — no near-enough tolerance', () => {
    expect(auditOutcome(768, 767)).toBe('mismatch')
    expect(auditOutcome(766, 767)).toBe('mismatch')
  })
})

describe('lastAuditFor', () => {
  const audit = (id: string, account: string, at: number): AuditResult => ({
    id,
    account,
    child: 'sam',
    countedMinor: 0,
    expectedMinor: 0,
    deltaMinor: 0,
    at,
    author: 'child',
  })

  it('null when the account has never been audited', () => {
    expect(lastAuditFor([audit('au1', 'other-acc', 100)], 'a-box')).toBeNull()
  })

  it('picks the most recent (by at) audit for the account, ignoring others', () => {
    const audits = [audit('au1', 'a-box', 100), audit('au2', 'other-acc', 999), audit('au3', 'a-box', 500)]
    expect(lastAuditFor(audits, 'a-box')?.id).toBe('au3')
  })
})

describe('entriesSinceLastAudit', () => {
  const entry = (id: string, account: string, createdAt: number): Entry => ({
    v: 1,
    id,
    child: 'sam',
    kind: 'credit',
    createdAt,
    author: 'guardian',
    legs: [{ account, currency: 'GBP', amountMinor: 100 }],
  })
  const audit = (id: string, account: string, at: number): AuditResult => ({
    id,
    account,
    child: 'sam',
    countedMinor: 0,
    expectedMinor: 0,
    deltaMinor: 0,
    at,
    author: 'child',
  })

  it('with no prior audit, returns every entry touching the account, oldest first', () => {
    const entries = [entry('e2', 'a-box', 200), entry('e1', 'a-box', 100), entry('e-other', 'a-other', 150)]
    const rows = entriesSinceLastAudit(entries, [], 'a-box')
    expect(rows.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('with a prior audit, returns only entries strictly after it', () => {
    const entries = [entry('e-before', 'a-box', 100), entry('e-after', 'a-box', 900)]
    const audits = [audit('au1', 'a-box', 500)]
    const rows = entriesSinceLastAudit(entries, audits, 'a-box')
    expect(rows.map((e) => e.id)).toEqual(['e-after'])
  })

  it('an entry created at exactly the audit time is excluded (strictly after)', () => {
    const entries = [entry('e-at', 'a-box', 500)]
    const audits = [audit('au1', 'a-box', 500)]
    expect(entriesSinceLastAudit(entries, audits, 'a-box')).toEqual([])
  })

  it('ignores entries for a different account entirely', () => {
    const entries = [entry('e1', 'a-other', 100)]
    expect(entriesSinceLastAudit(entries, [], 'a-box')).toEqual([])
  })
})
