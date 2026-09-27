export interface CurrencySpec {
  code: string
  decimals: number
  symbol: string
  name: string
}

export const CURRENCIES: Record<string, CurrencySpec> = Object.freeze({
  GBP: Object.freeze({ code: 'GBP', decimals: 2, symbol: '£', name: 'Pound sterling' }),
  EUR: Object.freeze({ code: 'EUR', decimals: 2, symbol: '€', name: 'Euro' }),
  USD: Object.freeze({ code: 'USD', decimals: 2, symbol: '$', name: 'US dollar' }),
  BTC: Object.freeze({ code: 'BTC', decimals: 8, symbol: '₿', name: 'Bitcoin' }),
})

export function currencyOrThrow(code: string): CurrencySpec {
  // hasOwnProperty guard: a bare `CURRENCIES[code]` lookup falls through to
  // Object.prototype for keys like 'toString' or 'constructor', returning
  // junk instead of throwing — a real risk since currency codes often come
  // straight from user/device input.
  if (!Object.prototype.hasOwnProperty.call(CURRENCIES, code)) throw new RangeError(`unknown currency: ${code}`)
  return CURRENCIES[code]!
}

export function assertMinor(n: number): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`amount must be a safe integer of minor units, got ${n}`)
}

export function assertPositiveMinor(n: number): void {
  assertMinor(n)
  if (n <= 0) throw new RangeError(`amount must be positive, got ${n}`)
}

const groups = new Intl.NumberFormat('en-GB')

export interface MoneyParts {
  /** '-' for negative amounts, '' otherwise (zero is not negative). */
  sign: '' | '-'
  /** Currency symbol shown before the whole-unit digits; '' for BTC (unit is a suffix instead). */
  prefix: string
  /** Grouped whole-unit digits: major units for fiat, whole sats for BTC. */
  whole: string
  /** Grouped fractional digits, zero-padded to the currency's decimals; null for BTC (no sub-sat fraction). */
  fraction: string | null
  /** Trailing unit label ('sat' | 'sats'); null for fiat, which uses a symbol prefix instead. */
  suffix: string | null
}

// en-GB grouping (comma thousands) and symbol-first (£1,000.00) is deliberate
// for every fiat currency here, not just GBP — this is a UK family app and
// that's the house style regardless of which currency an account holds.
//
// Structured breakdown behind formatMinor's string output, so callers that
// need to style the sign/symbol/digits/unit independently (e.g. Money.tsx)
// can do so without re-parsing formatted text. formatMinor is built on this.
export function moneyParts(currencyCode: string, minor: number): MoneyParts {
  assertMinor(minor)
  const spec = currencyOrThrow(currencyCode)
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  if (spec.code === 'BTC') {
    const suffix = abs === 1 ? 'sat' : 'sats'
    return { sign, prefix: '', whole: groups.format(abs), fraction: null, suffix }
  }
  const base = 10 ** spec.decimals
  const major = Math.floor(abs / base)
  const fraction = String(abs % base).padStart(spec.decimals, '0')
  return { sign, prefix: spec.symbol, whole: groups.format(major), fraction, suffix: null }
}

export function formatMinor(currencyCode: string, minor: number): string {
  const parts = moneyParts(currencyCode, minor)
  if (parts.suffix !== null) return `${parts.sign}${parts.whole} ${parts.suffix}`
  return `${parts.sign}${parts.prefix}${parts.whole}.${parts.fraction}`
}
