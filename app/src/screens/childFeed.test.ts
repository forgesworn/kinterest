import { describe, expect, it } from 'vitest'
import { creditEntry, debitEntry, exchangeEntry, transferEntry } from '../domain/ledger'
import { allowanceEntry } from '../domain/allowance'
import { interestEntry } from '../domain/interest'
import type { Account, Entry } from '../domain/types'
import type { AllowanceConfig } from '../domain/allowance'
import type { InterestConfig } from '../domain/interest'
import { buildChildFeed } from './childFeed'

const CHILD = 'sam'
const spending: Account = { id: 'acc-spend', child: CHILD, name: 'Spending', currency: 'GBP', custody: 'ledger' }
const savings: Account = { id: 'acc-save', child: CHILD, name: 'Savings', currency: 'GBP', custody: 'ledger' }
const btc: Account = { id: 'acc-btc', child: CHILD, name: 'Bitcoin', currency: 'BTC', custody: 'ledger' }
const accounts = [spending, savings, btc]

const AT = 1_755_000_000
const TZ = 'UTC'

function meta(id: string, author: 'guardian' | 'child' = 'guardian', note?: string) {
  return { id, child: CHILD, createdAt: AT, author, note }
}

function firstRow(entries: Entry[]) {
  const groups = buildChildFeed(entries, accounts, TZ, AT)
  return groups[0]!.rows[0]!
}

describe('buildChildFeed — every entry kind', () => {
  it('credit, guardian-authored: warm second-person, mentions the parent', () => {
    const e = creditEntry(meta('c1'), spending, 500)
    const row = firstRow([e])
    expect(row.title).toBe('Your parent added some money')
    expect(row.amountMinor).toBe(500)
  })

  it('credit, child-authored: second person, no parent mention', () => {
    const e = creditEntry(meta('c1', 'child'), spending, 500)
    expect(firstRow([e]).title).toBe('You added some money')
  })

  it('debit, guardian-authored', () => {
    const e = debitEntry(meta('d1'), spending, 350)
    const row = firstRow([e])
    expect(row.title).toBe('Your parent took some money out')
    expect(row.amountMinor).toBe(-350)
  })

  it('debit, child-authored', () => {
    const e = debitEntry(meta('d1', 'child'), spending, 350)
    expect(firstRow([e]).title).toBe('You took some money out')
  })

  it('transfer: warm copy, headline is the incoming leg, sub names both pots', () => {
    const e = transferEntry(meta('t1'), spending, savings, 500)
    const row = firstRow([e])
    expect(row.title).toBe('You moved money between your pots')
    expect(row.sub).toBe('Spending → Savings')
    expect(row.amountMinor).toBe(500)
  })

  it('exchange: warm copy, headline is the received leg', () => {
    const e = exchangeEntry(meta('x1'), spending, 1000, btc, 20000)
    const row = firstRow([e])
    expect(row.title).toBe('You changed some money')
    expect(row.sub).toBe('Spending → Bitcoin')
    expect(row.amountMinor).toBe(20000)
    expect(row.currency).toBe('BTC')
  })

  it('interest (kind AND category): celebratory copy, never the raw auto-note/period key', () => {
    const cfg: InterestConfig = { child: CHILD, account: spending.id, rateBps: 200, cadence: 'weekly', day: 5, tz: 'UTC', startDay: '2026-08-01' }
    const e = interestEntry(cfg, spending, '2026-08-07', 10_000, { id: 'i1', child: CHILD, createdAt: AT, author: 'guardian' })!
    const row = firstRow([e])
    expect(row.title).toBe('Interest day!')
    expect(row.title).not.toContain('2026-08-07')
  })

  it('adjustment: warm, neutral copy', () => {
    const e: Entry = {
      v: 1,
      id: 'adj1',
      child: CHILD,
      kind: 'adjustment',
      createdAt: AT,
      author: 'guardian',
      legs: [{ account: spending.id, currency: 'GBP', amountMinor: 50 }],
      auditId: 'audit-1',
    }
    expect(firstRow([e]).title).toBe('Things got tidied up')
  })
})

describe('buildChildFeed — category precedence and copy', () => {
  it('a deposit match reads as the parent matching what the child put in (audit S1)', () => {
    const e = creditEntry(meta('m1'), savings, 250, 'match')
    expect(firstRow([e]).title).toBe('Your parent matched the money you put in')
  })

  it('allowance category, guardian-authored: mentions the parent, never a raw period key/day', () => {
    const cfg: AllowanceConfig = { child: CHILD, account: spending.id, amountMinor: 500, cadence: 'weekly', day: 5, tz: 'UTC', startDay: '2026-08-01' }
    const e = allowanceEntry(cfg, spending, '2026-08-07', { id: 'al1', child: CHILD, createdAt: AT, author: 'guardian' })
    const row = firstRow([e])
    expect(row.title).toBe('Your parent added your pocket money')
    expect(row.title).not.toContain('2026-08-07')
    expect(row.title).not.toContain('W')
  })

  it('allowance category, child-authored (a future claim-originated credit): no parent mention', () => {
    const cfg: AllowanceConfig = { child: CHILD, account: spending.id, amountMinor: 500, cadence: 'weekly', day: 5, tz: 'UTC', startDay: '2026-08-01' }
    const e = allowanceEntry({ ...cfg }, spending, '2026-08-07', { id: 'al1', child: CHILD, createdAt: AT, author: 'child' })
    expect(firstRow([e]).title).toBe('Your pocket money arrived')
  })

  it('spend category is always phrased from the child\'s own point of view, regardless of author', () => {
    const e = debitEntry({ id: 's1', child: CHILD, createdAt: AT, author: 'guardian', note: 'Lego set' }, spending, 649, 'spend')
    const row = firstRow([e])
    expect(row.title).toBe('You spent some money')
    expect(row.sub).toBe('Lego set') // the Ask flow's own "what for" note surfaces as context
  })

  it('an unknown/unrecognised category falls back to the kind copy, not a crash or blank title', () => {
    const e = { ...creditEntry(meta('c1'), spending, 200), category: 'birthday-gift' }
    expect(firstRow([e]).title).toBe('Your parent added some money')
  })

  it('is immune to prototype-chain category strings ("toString"/"constructor")', () => {
    const asToString = { ...creditEntry(meta('c1'), spending, 200), category: 'toString' }
    const asConstructor = { ...creditEntry(meta('c2'), spending, 200), category: 'constructor' }
    expect(firstRow([asToString]).title).toBe('Your parent added some money')
    expect(firstRow([asConstructor]).title).toBe('Your parent added some money')
  })

  it('an entry\'s own note is never used verbatim as the title, even when set', () => {
    const e = creditEntry(meta('c1', 'guardian', 'Birthday money from Gran'), spending, 1000)
    const row = firstRow([e])
    expect(row.title).not.toBe('Birthday money from Gran')
    expect(row.title).toBe('Your parent added some money')
  })

  it('a non-spend note is not surfaced as sub — falls back to the account name', () => {
    const e = creditEntry(meta('c1', 'guardian', 'Birthday money from Gran'), spending, 1000)
    expect(firstRow([e]).sub).toBe('Spending')
  })
})

describe('buildChildFeed — grouping (shared day-labelling convention with the guardian feed)', () => {
  it('groups by day, newest day and newest entry first', () => {
    const day1 = Date.UTC(2026, 7, 10, 9, 0) / 1000
    const day2 = Date.UTC(2026, 7, 11, 9, 0) / 1000
    const e1 = creditEntry({ id: 'e1', child: CHILD, createdAt: day1, author: 'guardian' }, spending, 100)
    const e2 = creditEntry({ id: 'e2', child: CHILD, createdAt: day2, author: 'guardian' }, spending, 200)
    const groups = buildChildFeed([e1, e2], accounts, TZ, day2)
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-08-11', '2026-08-10'])
  })

  it('labels today/yesterday specially', () => {
    const today = Date.UTC(2026, 7, 11, 9, 0) / 1000
    const yesterday = Date.UTC(2026, 7, 10, 9, 0) / 1000
    const e1 = creditEntry({ id: 'e1', child: CHILD, createdAt: today, author: 'guardian' }, spending, 100)
    const e2 = creditEntry({ id: 'e2', child: CHILD, createdAt: yesterday, author: 'guardian' }, spending, 100)
    const groups = buildChildFeed([e1, e2], accounts, TZ, today)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
  })

  it('a row never carries an acked field — a child device never sends ENTRYs, so state.acks is always empty here', () => {
    const e1 = creditEntry(meta('e1'), spending, 100)
    const row = firstRow([e1])
    expect(row).not.toHaveProperty('acked')
  })

  it('empty entries -> empty groups', () => {
    expect(buildChildFeed([], accounts, TZ, AT)).toEqual([])
  })
})
