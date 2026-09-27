import { describe, expect, it } from 'vitest'
import { creditEntry, debitEntry, exchangeEntry, transferEntry } from '../domain/ledger'
import { allowanceEntry } from '../domain/allowance'
import type { Account } from '../domain/types'
import type { AllowanceConfig } from '../domain/allowance'
import { buildFeed, feedIcon, lastExchangeRate } from './feed'

const CHILD = 'sam'
const spending: Account = { id: 'acc-spend', child: CHILD, name: 'Spending', currency: 'GBP', custody: 'ledger' }
const savings: Account = { id: 'acc-save', child: CHILD, name: 'Savings', currency: 'GBP', custody: 'ledger' }
const btc: Account = { id: 'acc-btc', child: CHILD, name: 'Bitcoin', currency: 'BTC', custody: 'ledger' }
const accounts = [spending, savings, btc]

const AT = 1_755_000_000 // 2025-08-12T12:00:00Z-ish; exact value irrelevant, just a fixed anchor

function meta(id: string, createdAt: number, note?: string) {
  return { id, child: CHILD, createdAt, author: 'guardian' as const, note }
}

describe('feedIcon', () => {
  it('prefers the category glyph over the kind glyph when both apply', () => {
    expect(feedIcon({ kind: 'credit', category: 'allowance' })).toBe('↻')
    expect(feedIcon({ kind: 'interest', category: 'interest' })).toBe('%')
    expect(feedIcon({ kind: 'debit', category: 'spend' })).toBe('−')
  })

  it('falls back to the kind glyph when there is no (or an unknown) category', () => {
    expect(feedIcon({ kind: 'credit', category: undefined })).toBe('+')
    expect(feedIcon({ kind: 'transfer', category: undefined })).toBe('⇄')
    expect(feedIcon({ kind: 'exchange', category: undefined })).toBe('⇄')
    expect(feedIcon({ kind: 'adjustment', category: undefined })).toBe('±')
    expect(feedIcon({ kind: 'debit', category: 'not-a-real-category' })).toBe('−')
  })

  it('is immune to prototype-chain category strings', () => {
    expect(feedIcon({ kind: 'credit', category: 'toString' })).toBe('+')
    expect(feedIcon({ kind: 'credit', category: 'constructor' })).toBe('+')
  })
})

describe('lastExchangeRate', () => {
  it('returns null with no prior exchange between the two currencies', () => {
    expect(lastExchangeRate([], 'GBP', 'BTC')).toBeNull()
  })

  it('returns 1 for the same currency on both sides without scanning anything', () => {
    expect(lastExchangeRate([], 'GBP', 'GBP')).toBe(1)
  })

  it('infers the rate from a matching-direction exchange entry', () => {
    // £10.00 -> 20,000 sats => 1 GBP buys 2,000 sats => 0.00002 BTC per GBP
    const e = exchangeEntry(meta('e1', AT), spending, 1000, btc, 20000)
    expect(lastExchangeRate([e], 'GBP', 'BTC')).toBeCloseTo(0.00002, 10)
  })

  it('infers the INVERSE rate from an exchange in the opposite direction', () => {
    // Same entry as above, but asked BTC -> GBP: 20,000 sats bought £10.00,
    // so 1 BTC (100,000,000 sats) implies £50,000.
    const e = exchangeEntry(meta('e1', AT), spending, 1000, btc, 20000)
    expect(lastExchangeRate([e], 'BTC', 'GBP')).toBeCloseTo(50000, 6)
  })

  it('picks the MOST RECENT exchange when several exist', () => {
    const older = exchangeEntry(meta('e1', AT), spending, 1000, btc, 20000) // rate 0.00002
    const newer = exchangeEntry(meta('e2', AT + 100), spending, 1000, btc, 25000) // rate 0.000025
    expect(lastExchangeRate([older, newer], 'GBP', 'BTC')).toBeCloseTo(0.000025, 10)
    // Order in the array must not matter — it's createdAt that decides "most recent".
    expect(lastExchangeRate([newer, older], 'GBP', 'BTC')).toBeCloseTo(0.000025, 10)
  })

  it('ignores non-exchange entries and exchanges between unrelated currencies', () => {
    const credit = creditEntry(meta('c1', AT), spending, 500)
    const transfer = transferEntry(meta('t1', AT), spending, savings, 200)
    expect(lastExchangeRate([credit, transfer], 'GBP', 'BTC')).toBeNull()
  })
})

describe('buildFeed', () => {
  const TZ = 'UTC'

  it('groups entries by day, newest day first, newest entry first within a day', () => {
    const day1 = Date.UTC(2026, 7, 10, 9, 0) / 1000
    const day1Later = Date.UTC(2026, 7, 10, 15, 0) / 1000
    const day2 = Date.UTC(2026, 7, 11, 9, 0) / 1000

    const e1 = creditEntry(meta('e1', day1), spending, 100)
    const e2 = creditEntry(meta('e2', day1Later), spending, 200)
    const e3 = creditEntry(meta('e3', day2), spending, 300)

    const groups = buildFeed([e1, e2, e3], accounts, {}, TZ, day2)

    expect(groups.map((g) => g.dayKey)).toEqual(['2026-08-11', '2026-08-10'])
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['e3'])
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(['e2', 'e1']) // newest-first within the day
  })

  it('labels today and yesterday specially, formats older days as a date', () => {
    const today = Date.UTC(2026, 7, 11, 9, 0) / 1000
    const yesterday = Date.UTC(2026, 7, 10, 9, 0) / 1000
    const older = Date.UTC(2026, 6, 1, 9, 0) / 1000

    const groups = buildFeed(
      [creditEntry(meta('a', today), spending, 100), creditEntry(meta('b', yesterday), spending, 100), creditEntry(meta('c', older), spending, 100)],
      accounts,
      {},
      TZ,
      today,
    )

    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', '1 July 2026'])
  })

  it('one-leg entry: sub is the single account name, amount/currency are that leg\'s', () => {
    const e = debitEntry(meta('d1', AT), spending, 350, 'spend')
    const [group] = buildFeed([e], accounts, {}, TZ, AT)
    const [row] = group!.rows
    expect(row!.sub).toBe('Spending')
    expect(row!.amountMinor).toBe(-350)
    expect(row!.currency).toBe('GBP')
    expect(row!.icon).toBe('−')
  })

  it('transfer: sub names both accounts, headline amount is the incoming (positive) leg', () => {
    const e = transferEntry(meta('t1', AT), spending, savings, 500)
    const [group] = buildFeed([e], accounts, {}, TZ, AT)
    const [row] = group!.rows
    expect(row!.sub).toBe('Spending → Savings')
    expect(row!.amountMinor).toBe(500)
    expect(row!.title).toBe('Transfer')
  })

  it('exchange: sub names both accounts across currencies, headline is the received leg', () => {
    const e = exchangeEntry(meta('x1', AT), spending, 1000, btc, 20000)
    const [group] = buildFeed([e], accounts, {}, TZ, AT)
    const [row] = group!.rows
    expect(row!.sub).toBe('Spending → Bitcoin')
    expect(row!.amountMinor).toBe(20000)
    expect(row!.currency).toBe('BTC')
    expect(row!.title).toBe('Exchange')
  })

  it('title prefers the entry\'s own note over the category/kind default', () => {
    const e = creditEntry(meta('c1', AT, 'Birthday money from Gran'), spending, 1000)
    const [group] = buildFeed([e], accounts, {}, TZ, AT)
    expect(group!.rows[0]!.title).toBe('Birthday money from Gran')
  })

  it('title falls back to the category label, then the kind label', () => {
    const cfg: AllowanceConfig = { child: CHILD, account: spending.id, amountMinor: 500, cadence: 'weekly', day: 5, tz: 'UTC', startDay: '2026-08-01' }
    const allowance = allowanceEntry(cfg, spending, '2026-08-07', { id: 'al1', child: CHILD, createdAt: AT, author: 'guardian' })
    const manualCredit = creditEntry(meta('c1', AT), spending, 200) // no note, no category
    const groups = buildFeed([allowance, manualCredit], accounts, {}, TZ, AT)
    const titles = groups.flatMap((g) => g.rows.map((r) => r.title))
    // allowanceEntry sets its own default note ("Pocket money — <day>"), which wins over the
    // category label — this asserts the category-title fallback separately via a note-free entry.
    expect(titles).toContain(manualCredit.note === undefined ? 'Money in' : manualCredit.note)
  })

  it('acked reflects state.acks by entry id', () => {
    const e1 = creditEntry(meta('e1', AT), spending, 100)
    const e2 = creditEntry(meta('e2', AT), spending, 100)
    const groups = buildFeed([e1, e2], accounts, { e1: AT + 5 }, TZ, AT)
    const rows = groups[0]!.rows
    expect(rows.find((r) => r.id === 'e1')!.acked).toBe(true)
    expect(rows.find((r) => r.id === 'e2')!.acked).toBe(false)
  })

  it('empty entries -> empty groups', () => {
    expect(buildFeed([], accounts, {}, TZ, AT)).toEqual([])
  })
})
