import { describe, it, expect } from 'vitest'
import { moneyParts } from './Money'

describe('moneyParts', () => {
  it('breaks down fiat amounts (symbol prefix, no suffix)', () => {
    expect(moneyParts('GBP', 450)).toEqual({
      sign: '',
      prefix: '£',
      whole: '4',
      fraction: '50',
      suffix: null,
    })
  })

  it('groups large major units with commas', () => {
    expect(moneyParts('GBP', 100000)).toEqual({
      sign: '',
      prefix: '£',
      whole: '1,000',
      fraction: '00',
      suffix: null,
    })
  })

  it('carries a negative sign separately from the digits', () => {
    expect(moneyParts('EUR', -2000)).toEqual({
      sign: '-',
      prefix: '€',
      whole: '20',
      fraction: '00',
      suffix: null,
    })
  })

  it('treats zero as non-negative', () => {
    expect(moneyParts('USD', 0)).toEqual({
      sign: '',
      prefix: '$',
      whole: '0',
      fraction: '00',
      suffix: null,
    })
  })

  it('breaks down bitcoin as whole sats with a pluralised suffix, no fraction', () => {
    expect(moneyParts('BTC', 12345)).toEqual({
      sign: '',
      prefix: '',
      whole: '12,345',
      fraction: null,
      suffix: 'sats',
    })
    expect(moneyParts('BTC', 1)).toEqual({
      sign: '',
      prefix: '',
      whole: '1',
      fraction: null,
      suffix: 'sat',
    })
  })

  it('pluralises sats by absolute value, sign kept separate', () => {
    expect(moneyParts('BTC', -1)).toEqual({
      sign: '-',
      prefix: '',
      whole: '1',
      fraction: null,
      suffix: 'sat',
    })
    expect(moneyParts('BTC', -2)).toEqual({
      sign: '-',
      prefix: '',
      whole: '2',
      fraction: null,
      suffix: 'sats',
    })
  })

  it('rejects unknown currency codes and prototype-chain keys', () => {
    expect(() => moneyParts('DOGE', 100)).toThrow(RangeError)
    expect(() => moneyParts('toString', 100)).toThrow(RangeError)
  })

  it('rejects non-integer or unsafe minor amounts', () => {
    for (const bad of [4.5, NaN, Infinity, 2 ** 53]) {
      expect(() => moneyParts('GBP', bad)).toThrow(RangeError)
    }
  })
})
