import { describe, it, expect } from 'vitest'
import type { Account } from './types'
import { DENOMINATIONS, countTotal, auditResult, adjustmentEntry } from './audit'

const box: Account = { id: 'a-box', child: 'sam', name: 'Money box', currency: 'GBP', custody: 'physical' }
const meta = { id: 'e1', child: 'sam', createdAt: 100, author: 'child' as const }

describe('denominations', () => {
  it('GBP runs 1p to £50 note', () => {
    const minors = DENOMINATIONS.GBP!.map((d) => d.minor)
    expect(minors[0]).toBe(1)
    expect(minors[minors.length - 1]).toBe(5000)
  })
  it('no BTC denominations', () => {
    expect(DENOMINATIONS.BTC).toBeUndefined()
  })
})

describe('countTotal', () => {
  it('adds up mixed coins — the maths the child would otherwise do by hand', () => {
    // 7×1p + 3×20p + 2×£1 + 1×£5 note = 7 + 60 + 200 + 500
    expect(countTotal([
      { minor: 1, qty: 7 },
      { minor: 20, qty: 3 },
      { minor: 100, qty: 2 },
      { minor: 500, qty: 1 },
    ])).toBe(767)
  })
  it('rejects negative quantities', () => {
    expect(() => countTotal([{ minor: 100, qty: -1 }])).toThrow(RangeError)
  })
  it('rejects a non-positive denomination', () => {
    expect(() => countTotal([{ minor: -100, qty: 3 }])).toThrow(RangeError)
    expect(() => countTotal([{ minor: 0, qty: 1 }])).toThrow(RangeError)
  })
})

describe('auditResult and adjustment', () => {
  it('a matching count needs no adjustment', () => {
    const audit = auditResult({ id: 'au1', at: 100, author: 'child' }, box, 767, 767)
    expect(audit.deltaMinor).toBe(0)
    expect(adjustmentEntry(audit, box, meta)).toBeNull()
  })
  it('a short count produces a negative adjustment tied to the audit', () => {
    const audit = auditResult({ id: 'au2', at: 100, author: 'child' }, box, 700, 767)
    expect(audit.deltaMinor).toBe(-67)
    const adj = adjustmentEntry(audit, box, meta)!
    expect(adj.kind).toBe('adjustment')
    expect(adj.auditId).toBe('au2')
    expect(adj.countedMinor).toBe(700) // S3: carries the counted total; the delta is the leg
    expect(adj.legs).toEqual([{ account: 'a-box', currency: 'GBP', amountMinor: -67 }])
  })
  it('an over count produces a positive adjustment', () => {
    const audit = auditResult({ id: 'au3', at: 100, author: 'child' }, box, 800, 767)
    expect(adjustmentEntry(audit, box, meta)!.legs[0]!.amountMinor).toBe(33)
  })
  it('refuses an adjustment for a mismatched account', () => {
    const audit = auditResult({ id: 'au4', at: 100, author: 'child' }, box, 700, 767)
    const other: Account = { ...box, id: 'a-other' }
    expect(() => adjustmentEntry(audit, other, meta)).toThrow(/account/)
  })
  it('refuses an adjustment authored for a different child', () => {
    const audit = auditResult({ id: 'au5', at: 100, author: 'child' }, box, 700, 767)
    expect(() => adjustmentEntry(audit, box, { ...meta, child: 'alex' })).toThrow(/child/)
  })
})
