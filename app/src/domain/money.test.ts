import { describe, it, expect } from 'vitest'
import { CURRENCIES, assertMinor, assertPositiveMinor, formatMinor, currencyOrThrow } from './money'

describe('currencies', () => {
  it('knows the v1 set', () => {
    expect(Object.keys(CURRENCIES).sort()).toEqual(['BTC', 'EUR', 'GBP', 'USD'])
    expect(CURRENCIES.GBP!.decimals).toBe(2)
    expect(CURRENCIES.BTC!.decimals).toBe(8)
  })
  it('currencyOrThrow rejects unknown codes', () => {
    expect(() => currencyOrThrow('DOGE')).toThrow(RangeError)
    expect(currencyOrThrow('GBP').symbol).toBe('£')
  })
  it('currencyOrThrow rejects prototype-chain properties', () => {
    expect(() => currencyOrThrow('toString')).toThrow(RangeError)
    expect(() => currencyOrThrow('constructor')).toThrow(RangeError)
    expect(() => formatMinor('constructor', 100)).toThrow(RangeError)
  })
  it('freezes the registry and each spec', () => {
    expect(Object.isFrozen(CURRENCIES)).toBe(true)
    expect(Object.isFrozen(CURRENCIES.GBP)).toBe(true)
  })
})

describe('integer guards', () => {
  it('accepts safe integers', () => {
    expect(() => assertMinor(0)).not.toThrow()
    expect(() => assertMinor(-450)).not.toThrow()
  })
  it('rejects floats, NaN, unsafe integers', () => {
    for (const bad of [4.5, NaN, Infinity, 2 ** 53]) {
      expect(() => assertMinor(bad)).toThrow(RangeError)
    }
  })
  it('assertPositiveMinor rejects zero and negatives', () => {
    expect(() => assertPositiveMinor(0)).toThrow(RangeError)
    expect(() => assertPositiveMinor(-1)).toThrow(RangeError)
    expect(() => assertPositiveMinor(1)).not.toThrow()
  })
})

describe('formatMinor', () => {
  it('formats fiat with symbol and decimals', () => {
    expect(formatMinor('GBP', 450)).toBe('£4.50')
    expect(formatMinor('GBP', 100000)).toBe('£1,000.00')
    expect(formatMinor('EUR', -2000)).toBe('-€20.00')
  })
  it('formats bitcoin as sats', () => {
    expect(formatMinor('BTC', 12345)).toBe('12,345 sats')
    expect(formatMinor('BTC', 1)).toBe('1 sat')
  })
})
