import { describe, expect, it } from 'vitest'
import { creditEntry, debitEntry, exchangeEntry, transferEntry } from '../domain/ledger'
import { emptyState } from '../state/state'
import type { Account } from '../domain/types'
import type { InterestConfig } from '../domain/interest'
import {
  childOwnAccounts,
  childOwnEntries,
  formatBpsAsPercent,
  friendlyInterestRate,
  interestCountdownLabel,
  jarHighWaterMinor,
  jarState,
  nextInterestProjection,
} from './ChildHome'

const CHILD = 'sam-pk'
const SIBLING = 'ash-pk'
const AT = 1_755_000_000 // fixed anchor, exact value irrelevant

const spending: Account = { id: 'acc-spend', child: CHILD, name: 'Spending', currency: 'GBP', custody: 'ledger' }
const savings: Account = { id: 'acc-save', child: CHILD, name: 'Savings', currency: 'GBP', custody: 'ledger' }
const btc: Account = { id: 'acc-btc', child: CHILD, name: 'Bitcoin', currency: 'BTC', custody: 'ledger' }
const siblingAccount: Account = { id: 'acc-sib', child: SIBLING, name: 'Sibling pot', currency: 'GBP', custody: 'ledger' }
const archived: Account = { id: 'acc-old', child: CHILD, name: 'Old', currency: 'GBP', custody: 'ledger', archived: true }

// ============================================================================
// Self-scoping — "child sees ONLY their own data" is this module's whole
// privacy boundary (see ChildHome.tsx's own header).
// ============================================================================

describe('childOwnAccounts', () => {
  it('returns only the self child\'s own, non-archived accounts, excluding a sibling\'s entirely', () => {
    const app = { ...emptyState(), self: { pubkey: CHILD, childIndex: 0 } }
    app.docs.accounts.accounts = [spending, savings, siblingAccount, archived]
    const accounts = childOwnAccounts(app)
    expect(accounts.map((a) => a.id).sort()).toEqual(['acc-save', 'acc-spend'])
    expect(accounts.some((a) => a.child === SIBLING)).toBe(false)
  })

  it('self.pubkey null (not yet paired/unlocked) -> no accounts at all, never a sibling\'s by accident', () => {
    const app = { ...emptyState(), self: { pubkey: null, childIndex: null } }
    app.docs.accounts.accounts = [spending, siblingAccount]
    expect(childOwnAccounts(app)).toEqual([])
  })
})

describe('childOwnEntries', () => {
  it('returns only entries belonging to the self child, excluding a sibling\'s', () => {
    const app = { ...emptyState(), self: { pubkey: CHILD, childIndex: 0 } }
    const mine = creditEntry({ id: 'e1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 500)
    const siblings = creditEntry({ id: 'e2', child: SIBLING, createdAt: AT, author: 'guardian' }, siblingAccount, 500)
    app.entries = [mine, siblings]
    expect(childOwnEntries(app).map((e) => e.id)).toEqual(['e1'])
  })

  it('self.pubkey null -> no entries at all', () => {
    const app = { ...emptyState(), self: { pubkey: null, childIndex: null } }
    app.entries = [creditEntry({ id: 'e1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 500)]
    expect(childOwnEntries(app)).toEqual([])
  })
})

// ============================================================================
// jarHighWaterMinor
// ============================================================================

describe('jarHighWaterMinor', () => {
  it('no entries -> 0', () => {
    expect(jarHighWaterMinor([], [spending.id])).toBe(0)
  })

  it('grows to the peak running balance, then stays there after a later spend', () => {
    const deposit = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 1000)
    const spend = debitEntry({ id: 'd1', child: CHILD, createdAt: AT + 100, author: 'guardian' }, spending, 400)
    expect(jarHighWaterMinor([deposit], [spending.id])).toBe(1000)
    expect(jarHighWaterMinor([deposit, spend], [spending.id])).toBe(1000) // the spend drops the running balance, not the high-water mark
  })

  it('grows further on a later deposit that exceeds the prior peak', () => {
    const first = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 1000)
    const second = creditEntry({ id: 'c2', child: CHILD, createdAt: AT + 100, author: 'guardian' }, spending, 500)
    expect(jarHighWaterMinor([first, second], [spending.id])).toBe(1500)
  })

  it('order in the input array does not matter — createdAt decides chronology', () => {
    const first = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 1000)
    const second = creditEntry({ id: 'c2', child: CHILD, createdAt: AT + 100, author: 'guardian' }, spending, 500)
    expect(jarHighWaterMinor([second, first], [spending.id])).toBe(1500)
  })

  it('a leg naming an account outside accountIds is ignored entirely', () => {
    const mine = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 1000)
    const elsewhere = creditEntry({ id: 'c2', child: CHILD, createdAt: AT + 1, author: 'guardian' }, savings, 5000)
    expect(jarHighWaterMinor([mine, elsewhere], [spending.id])).toBe(1000)
  })

  it('sums across several accountIds sharing the tracked set', () => {
    const toSpending = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 500)
    const toSavings = creditEntry({ id: 'c2', child: CHILD, createdAt: AT + 1, author: 'guardian' }, savings, 300)
    expect(jarHighWaterMinor([toSpending, toSavings], [spending.id, savings.id])).toBe(800)
  })

  it('a transfer between two tracked accounts is a wash — the running total high-water mark is unaffected by the move itself', () => {
    const deposit = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 1000)
    const move = transferEntry({ id: 't1', child: CHILD, createdAt: AT + 1, author: 'guardian' }, spending, savings, 400)
    expect(jarHighWaterMinor([deposit, move], [spending.id, savings.id])).toBe(1000)
  })
})

// ============================================================================
// jarState — regression coverage for the review finding: `fill`'s numerator
// (balance) and denominator (highWater) must share the same account scope,
// or a converted second-currency balance can inflate fill relative to a
// high-water mark that never tracked it.
// ============================================================================

describe('jarState', () => {
  it('scopes both the balance and the high-water mark to the home-currency accounts only', () => {
    const deposit = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 1000)
    const state = jarState([spending], [deposit])
    expect(state.currency).toBe('GBP')
    expect(state.balanceMinor).toBe(1000)
    expect(state.highWaterMinor).toBe(1000)
  })

  it('a second-currency pot — even with a known, favourable exchange rate on record — never inflates the balance, the high-water mark, or the fill', () => {
    const deposit = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 1000)
    const withoutForeignPot = jarState([spending], [deposit])

    // A large BTC balance, plus a KNOWN exchange rate wildly favourable to
    // BTC (1p buys 1 sat — absurd on purpose, and against a THIRD account —
    // `savings` — that this test deliberately leaves OUT of `jarState`'s own
    // `accounts` argument, so the rate-establishing entry cannot itself
    // touch `spending`'s balance): if the foreign pot's converted value ever
    // reached the jar's balance/high-water via approxTotal's rate lookup,
    // this would inflate all three assertions below.
    const btcDeposit = creditEntry({ id: 'c2', child: CHILD, createdAt: AT + 1, author: 'guardian' }, btc, 1_000_000)
    const rate = exchangeEntry({ id: 'x1', child: CHILD, createdAt: AT + 2, author: 'guardian' }, savings, 100, btc, 1)
    const withForeignPot = jarState([spending, btc], [deposit, btcDeposit, rate])

    expect(withForeignPot.currency).toBe('GBP')
    expect(withForeignPot.balanceMinor).toBe(withoutForeignPot.balanceMinor)
    expect(withForeignPot.highWaterMinor).toBe(withoutForeignPot.highWaterMinor)
    expect(withForeignPot.fill).toBe(withoutForeignPot.fill)
  })

  it('fill is exactly jarFill(balanceMinor, highWaterMinor) over the home-currency scope — the soft-target headroom carries through', () => {
    const deposit = creditEntry({ id: 'c1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 10_000)
    const state = jarState([spending], [deposit])
    expect(state.fill).toBeCloseTo(1 / 1.2, 5) // a brand-new all-time high: ~83%, per Jar.tsx's own soft-target headroom
  })
})

// ============================================================================
// Interest panel formatters
// ============================================================================

describe('formatBpsAsPercent', () => {
  it('formats whole percentages with no trailing fraction', () => {
    expect(formatBpsAsPercent(200)).toBe('2%')
    expect(formatBpsAsPercent(0)).toBe('0%')
  })

  it('formats a half-percent step', () => {
    expect(formatBpsAsPercent(350)).toBe('3.5%')
  })

  it('formats a two-decimal-place rate', () => {
    expect(formatBpsAsPercent(375)).toBe('3.75%')
    expect(formatBpsAsPercent(1)).toBe('0.01%')
  })

  it('is total against negative/non-finite input — degrades to 0%, never throws', () => {
    expect(() => formatBpsAsPercent(-5)).not.toThrow()
    expect(formatBpsAsPercent(-5)).toBe('0%')
    expect(formatBpsAsPercent(Number.NaN)).toBe('0%')
  })
})

describe('friendlyInterestRate', () => {
  it('weekly: "<rate>% every <weekday>" — never a raw ISO weekday number', () => {
    const cfg: Pick<InterestConfig, 'rateBps' | 'cadence' | 'day'> = { rateBps: 200, cadence: 'weekly', day: 5 }
    expect(friendlyInterestRate(cfg)).toBe('2% every Friday')
  })

  it('monthly: "<rate>% on the <ordinal> of the month"', () => {
    expect(friendlyInterestRate({ rateBps: 200, cadence: 'monthly', day: 1 })).toBe('2% on the 1st of the month')
    expect(friendlyInterestRate({ rateBps: 200, cadence: 'monthly', day: 2 })).toContain('2nd')
    expect(friendlyInterestRate({ rateBps: 200, cadence: 'monthly', day: 3 })).toContain('3rd')
    expect(friendlyInterestRate({ rateBps: 200, cadence: 'monthly', day: 11 })).toContain('11th')
    expect(friendlyInterestRate({ rateBps: 200, cadence: 'monthly', day: 21 })).toContain('21st')
  })

  it('never mentions bps/rateBps by name — only the friendly percent', () => {
    const copy = friendlyInterestRate({ rateBps: 350, cadence: 'weekly', day: 1 })
    expect(copy).not.toMatch(/bps/i)
    expect(copy).toBe('3.5% every Monday')
  })
})

describe('interestCountdownLabel', () => {
  it('null dueDay -> a calm "not set up" line', () => {
    expect(interestCountdownLabel(null, '2026-08-10')).toBe('No interest day set up yet')
  })

  it('due today', () => {
    expect(interestCountdownLabel('2026-08-10', '2026-08-10')).toBe('Interest day is today!')
  })

  it('due tomorrow', () => {
    expect(interestCountdownLabel('2026-08-11', '2026-08-10')).toBe('Interest day is tomorrow!')
  })

  it('due within the week: counts in days', () => {
    expect(interestCountdownLabel('2026-08-15', '2026-08-10')).toBe('Interest day in 5 days')
  })

  it('due a full week or more away: counts in weeks, never a raw period key', () => {
    expect(interestCountdownLabel('2026-08-17', '2026-08-10')).toBe('Wait 1 more week for interest day')
    expect(interestCountdownLabel('2026-08-24', '2026-08-10')).toBe('Wait 2 more weeks for interest day')
    expect(interestCountdownLabel('2026-08-17', '2026-08-10')).not.toMatch(/W\d/)
  })
})

describe('nextInterestProjection', () => {
  it('projects the balance after exactly the next interest payment', () => {
    // 2% of £10.00 (1000p) rounded half-up = 20p -> 1020p.
    expect(nextInterestProjection(200, 1000)).toBe(1020)
  })

  it('a zero/negative balance projects to itself — no interest on nothing', () => {
    expect(nextInterestProjection(200, 0)).toBe(0)
  })

  it('is total against arithmetic overflow — null, never an uncaught throw', () => {
    expect(() => nextInterestProjection(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(nextInterestProjection(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBeNull()
  })
})
