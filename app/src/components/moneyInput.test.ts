import { describe, expect, it } from 'vitest'
import { parseAmount } from './MoneyInput'

// Pure-logic coverage only — MoneyInput.tsx itself is a thin field (same
// pattern as components/Money.tsx's moneyParts / money.test.ts). See the
// plan's exact hard-cases list: "reject >2dp per currency decimals, '1,000'
// ok, '', '-', '0.005' rejected; BTC sats integer entry".
describe('parseAmount: fiat (GBP, 2dp)', () => {
  it('parses a plain decimal amount into minor units', () => {
    expect(parseAmount('4.50', 'GBP')).toBe(450)
    expect(parseAmount('0.01', 'GBP')).toBe(1)
    expect(parseAmount('10', 'GBP')).toBe(1000)
  })

  it('accepts comma thousands separators', () => {
    expect(parseAmount('1,000', 'GBP')).toBe(100000)
    expect(parseAmount('1,000.50', 'GBP')).toBe(100050)
  })

  it('rejects more than 2 decimal places rather than rounding or truncating', () => {
    expect(parseAmount('0.005', 'GBP')).toBeNull()
    expect(parseAmount('1.234', 'GBP')).toBeNull()
  })

  it('rejects empty, whitespace-only, and a bare minus', () => {
    expect(parseAmount('', 'GBP')).toBeNull()
    expect(parseAmount('   ', 'GBP')).toBeNull()
    expect(parseAmount('-', 'GBP')).toBeNull()
  })

  it('rejects negative amounts and zero', () => {
    expect(parseAmount('-5', 'GBP')).toBeNull()
    expect(parseAmount('-5.00', 'GBP')).toBeNull()
    expect(parseAmount('0', 'GBP')).toBeNull()
    expect(parseAmount('0.00', 'GBP')).toBeNull()
  })

  it('rejects non-numeric junk', () => {
    expect(parseAmount('abc', 'GBP')).toBeNull()
    expect(parseAmount('4.5.0', 'GBP')).toBeNull()
    expect(parseAmount('£4.50', 'GBP')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(parseAmount('  4.50  ', 'GBP')).toBe(450)
    expect(parseAmount(' 4 ', 'GBP')).toBe(400)
  })

  it('rejects an amount that would overflow a safe integer', () => {
    expect(parseAmount('90071992547409929007199254740992', 'GBP')).toBeNull()
  })

  it('rejects a comma in the wrong (non-thousands) position rather than silently stripping it — the 100x hazard', () => {
    // "4,50" must NOT be read as "450" (£4.50 mistyped European-style, or a
    // fat-fingered comma, either way NOT four hundred and fifty pounds).
    expect(parseAmount('4,50', 'GBP')).toBeNull()
    expect(parseAmount('1,00,000', 'GBP')).toBeNull() // Indian-style grouping, not this app's convention
    expect(parseAmount('12,3', 'GBP')).toBeNull()
    expect(parseAmount(',456', 'GBP')).toBeNull()
  })

  it('still accepts correctly 3-digit-grouped commas, including repeated groups and with a fraction', () => {
    expect(parseAmount('12,345,678', 'GBP')).toBe(1234567800)
    expect(parseAmount('123,456', 'GBP')).toBe(12345600)
  })

  it('rejects a lone "." and a "." with nothing on one side', () => {
    expect(parseAmount('.', 'GBP')).toBeNull()
    expect(parseAmount('4.', 'GBP')).toBeNull()
    expect(parseAmount('.5', 'GBP')).toBeNull()
  })

  it('rejects a leading "+" and scientific notation', () => {
    expect(parseAmount('+4', 'GBP')).toBeNull()
    expect(parseAmount('1e3', 'GBP')).toBeNull()
  })
})

describe('parseAmount: BTC (sats integer entry)', () => {
  it('parses a plain integer as sats', () => {
    expect(parseAmount('100', 'BTC')).toBe(100)
    expect(parseAmount('1', 'BTC')).toBe(1)
  })

  it('accepts comma thousands separators', () => {
    expect(parseAmount('21,000,000', 'BTC')).toBe(21000000)
  })

  it('rejects a decimal point entirely — sats have no sub-unit', () => {
    expect(parseAmount('1.5', 'BTC')).toBeNull()
    expect(parseAmount('0.00001234', 'BTC')).toBeNull()
  })

  it('rejects empty, a bare minus, negative, and zero', () => {
    expect(parseAmount('', 'BTC')).toBeNull()
    expect(parseAmount('-', 'BTC')).toBeNull()
    expect(parseAmount('-100', 'BTC')).toBeNull()
    expect(parseAmount('0', 'BTC')).toBeNull()
  })

  it('rejects a comma in the wrong position, same as fiat', () => {
    expect(parseAmount('4,50', 'BTC')).toBeNull()
  })

  it('accepts Number.MAX_SAFE_INTEGER sats exactly, rejects one more', () => {
    expect(parseAmount(String(Number.MAX_SAFE_INTEGER), 'BTC')).toBe(Number.MAX_SAFE_INTEGER)
    expect(parseAmount(String(Number.MAX_SAFE_INTEGER + 1), 'BTC')).toBeNull()
  })
})

describe('parseAmount: unknown currency', () => {
  it('throws via currencyOrThrow rather than silently accepting', () => {
    expect(() => parseAmount('4.50', 'DOGE')).toThrow(RangeError)
  })
})

// "Settle up" must be able to record a pot at £0 — every
// other flow keeps rejecting 0.
describe('parseAmount: { allowZero: true }', () => {
  it('accepts exactly 0 for fiat when allowZero is set', () => {
    expect(parseAmount('0', 'GBP', { allowZero: true })).toBe(0)
    expect(parseAmount('0.00', 'GBP', { allowZero: true })).toBe(0)
  })

  it('accepts exactly 0 sats for BTC when allowZero is set', () => {
    expect(parseAmount('0', 'BTC', { allowZero: true })).toBe(0)
  })

  it('still rejects negative amounts even with allowZero', () => {
    expect(parseAmount('-5', 'GBP', { allowZero: true })).toBeNull()
    expect(parseAmount('-1', 'BTC', { allowZero: true })).toBeNull()
  })

  it('still parses ordinary positive amounts the same as without the option', () => {
    expect(parseAmount('4.50', 'GBP', { allowZero: true })).toBe(450)
  })

  it('defaults to rejecting 0 when the option is omitted or false', () => {
    expect(parseAmount('0.00', 'GBP')).toBeNull()
    expect(parseAmount('0.00', 'GBP', { allowZero: false })).toBeNull()
  })
})
