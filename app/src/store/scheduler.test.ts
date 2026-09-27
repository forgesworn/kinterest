// store/scheduler.ts — pure allowance/interest due-date scan. See the
// module's header for the design (idempotent by periodKey, gated periods
// surface as claims rather than auto-paying).

import { describe, expect, it } from 'vitest'
import { addEntry, emptyState } from '../state/state'
import type { AppState } from '../state/types'
import type { AllowanceConfig } from '../domain/allowance'
import type { InterestConfig } from '../domain/interest'
import { balances, creditEntry, transferEntry } from '../domain/ledger'
import { reanchorConfigs } from '../domain/reanchor'
import { runSchedulers } from './scheduler'

const ACCOUNT_ID = 'a-ledger'
const CHILD = 'sam'

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...emptyState(),
    role: 'guardian',
    docs: {
      ...emptyState().docs,
      accounts: { v: 1, issuedAt: 1, accounts: [{ id: ACCOUNT_ID, child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }] },
    },
    ...overrides,
  }
}

const allowanceCfg: AllowanceConfig = {
  child: CHILD,
  account: ACCOUNT_ID,
  amountMinor: 500,
  cadence: 'weekly',
  day: 5,
  tz: 'Europe/London',
  startDay: '2026-08-01',
}

// Friday 2026-08-21, 09:00 London (BST) = 08:00 UTC — matches
// domain/allowance.test.ts's fixture, so `dueDays` here is known-good:
// ['2026-08-07', '2026-08-14', '2026-08-21'].
const NOW = Date.UTC(2026, 7, 21, 8, 0) / 1000

describe('runSchedulers: allowance', () => {
  it('proposes one entry per due day for an ungated config', () => {
    const state = baseState({ docs: { ...baseState().docs, allowance: { v: 1, issuedAt: 1, configs: [allowanceCfg] } } })

    const { entries, claims } = runSchedulers(state, NOW)

    expect(entries).toHaveLength(3)
    expect(entries.every((e) => e.category === 'allowance' && e.child === CHILD)).toBe(true)
    expect(entries.map((e) => e.periodKey).sort()).toEqual(['2026-W32', '2026-W33', '2026-W34'])
    expect(claims).toEqual([])
  })

  it('is idempotent: folding the first run\'s entries into state makes the second run empty', () => {
    const state = baseState({ docs: { ...baseState().docs, allowance: { v: 1, issuedAt: 1, configs: [allowanceCfg] } } })

    const first = runSchedulers(state, NOW)
    expect(first.entries.length).toBeGreaterThan(0)

    let next = state
    for (const entry of first.entries) next = addEntry(next, entry)

    const second = runSchedulers(next, NOW)
    expect(second.entries).toEqual([])
    expect(second.claims).toEqual([])
  })

  it('a paused config proposes nothing', () => {
    const state = baseState({
      docs: { ...baseState().docs, allowance: { v: 1, issuedAt: 1, configs: [{ ...allowanceCfg, paused: true }] } },
    })
    expect(runSchedulers(state, NOW)).toEqual({ entries: [], claims: [] })
  })

  it('a config for a missing/archived account is skipped rather than throwing', () => {
    const state = baseState({
      docs: {
        ...baseState().docs,
        allowance: { v: 1, issuedAt: 1, configs: [{ ...allowanceCfg, account: 'does-not-exist' }] },
      },
    })
    expect(() => runSchedulers(state, NOW)).not.toThrow()
    expect(runSchedulers(state, NOW)).toEqual({ entries: [], claims: [] })
  })

  it('choresGate suppresses auto-pay and surfaces an allowance.claim per due period instead', () => {
    const state = baseState({
      docs: { ...baseState().docs, allowance: { v: 1, issuedAt: 1, configs: [{ ...allowanceCfg, choresGate: true }] } },
    })

    const { entries, claims } = runSchedulers(state, NOW)

    expect(entries).toEqual([])
    expect(claims).toHaveLength(3)
    expect(claims.every((c) => c.op === 'allowance.claim' && c.child === CHILD)).toBe(true)
    expect(claims.map((c) => (c.params as { periodKey: string }).periodKey).sort()).toEqual(['2026-W32', '2026-W33', '2026-W34'])
  })

  it('auditGate suppresses auto-pay the same way as choresGate', () => {
    const state = baseState({
      docs: { ...baseState().docs, allowance: { v: 1, issuedAt: 1, configs: [{ ...allowanceCfg, auditGate: true }] } },
    })

    const { entries, claims } = runSchedulers(state, NOW)

    expect(entries).toEqual([])
    expect(claims).toHaveLength(3)
  })

  it('a gated claim is idempotent too — re-running before the gate clears keeps proposing the same claims, not duplicating them onto a paid ledger', () => {
    // Gated periods never get folded into state.entries by the scheduler
    // itself (nothing pays them) — a second run without any state change
    // proposes the identical claims again, which is correct: the guardian
    // hasn't released the gate yet, so the same reqId-shaped claim is still
    // the right thing for the approvals inbox to show.
    const state = baseState({
      docs: { ...baseState().docs, allowance: { v: 1, issuedAt: 1, configs: [{ ...allowanceCfg, choresGate: true }] } },
    })
    const first = runSchedulers(state, NOW)
    const second = runSchedulers(state, NOW)
    expect(second.claims.map((c) => c.reqId)).toEqual(first.claims.map((c) => c.reqId))
  })
})

const interestCfg: InterestConfig = {
  child: CHILD,
  account: ACCOUNT_ID,
  rateBps: 500, // 5%
  cadence: 'monthly',
  day: 1,
  tz: 'UTC',
  startDay: '2026-06-30',
}

// 2026-07-15 UTC — exactly one monthly due day (2026-07-01) has elapsed
// since the 2026-06-30 startDay by this point, per domain/period.ts's
// dueDays (fromExclusive..toInclusive); 2026-08-01 itself isn't reached yet.
const NOW_INTEREST = Date.UTC(2026, 6, 15, 0, 0) / 1000

describe('runSchedulers: interest', () => {
  it('computes interest against the running balance (existing entries folded via balances())', () => {
    const seeded = baseState({
      docs: { ...baseState().docs, interest: { v: 1, issuedAt: 1, configs: [interestCfg] } },
    })
    // Seed a starting balance so interest has something to compute against.
    const withBalance = addEntry(seeded, {
      v: 1,
      id: 'seed-1',
      child: CHILD,
      kind: 'credit',
      createdAt: 1,
      author: 'guardian',
      legs: [{ account: ACCOUNT_ID, currency: 'GBP', amountMinor: 10_000 }],
    })

    const { entries } = runSchedulers(withBalance, NOW_INTEREST)

    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('interest')
    // 10000 * 500bps / 10000 = 500, half-up rounding doesn't change an exact result.
    expect(entries[0]!.legs[0]!.amountMinor).toBe(500)
  })

  it('zero balance yields no interest entry (interestMinor floors to 0 and interestEntry returns null)', () => {
    const state = baseState({
      docs: { ...baseState().docs, interest: { v: 1, issuedAt: 1, configs: [interestCfg] } },
    })
    expect(runSchedulers(state, NOW_INTEREST).entries).toEqual([])
  })

  it('is idempotent: a second run after folding the first is empty', () => {
    const seeded = baseState({
      docs: { ...baseState().docs, interest: { v: 1, issuedAt: 1, configs: [interestCfg] } },
    })
    const withBalance = addEntry(seeded, {
      v: 1,
      id: 'seed-1',
      child: CHILD,
      kind: 'credit',
      createdAt: 1,
      author: 'guardian',
      legs: [{ account: ACCOUNT_ID, currency: 'GBP', amountMinor: 10_000 }],
    })
    const first = runSchedulers(withBalance, NOW_INTEREST)
    expect(first.entries).toHaveLength(1)

    let next = withBalance
    for (const entry of first.entries) next = addEntry(next, entry)

    expect(runSchedulers(next, NOW_INTEREST).entries).toEqual([])
  })

  it('a paused interest config proposes nothing', () => {
    const seeded = baseState({
      docs: { ...baseState().docs, interest: { v: 1, issuedAt: 1, configs: [{ ...interestCfg, paused: true }] } },
    })
    const withBalance = addEntry(seeded, {
      v: 1,
      id: 'seed-1',
      child: CHILD,
      kind: 'credit',
      createdAt: 1,
      author: 'guardian',
      legs: [{ account: ACCOUNT_ID, currency: 'GBP', amountMinor: 10_000 }],
    })
    expect(runSchedulers(withBalance, NOW_INTEREST).entries).toEqual([])
  })
})

describe('runSchedulers: per-config isolation (defence in depth)', () => {
  // A hostile/corrupt rateBps large enough to overflow
  // domain/interest.ts#interestMinor's `balanceMinor * rateBps` safe-integer
  // check — the kind of value a hand-edited localStorage blob or a config
  // that predates settingsForms.ts's own 1000% cap (MAX_BPS) could still
  // carry. Review finding: this used to throw straight out of
  // `runSchedulers`, and since that runs inside store.tsx's own reducer
  // updater on every launch, it took down entries for every OTHER child
  // too. Each config now runs in its own try/catch — see scheduler.ts's
  // own comment on the loop.
  const POISONED_RATE_BPS = 9_007_199_254_740_991 // Number.MAX_SAFE_INTEGER

  it('a poisoned interest config is skipped without throwing, leaving a healthy sibling config unaffected', () => {
    const OTHER_ACCOUNT_ID = 'a-ledger-2'
    const OTHER_CHILD = 'alex'
    const poisonedCfg: InterestConfig = { ...interestCfg, rateBps: POISONED_RATE_BPS }
    const healthyCfg: InterestConfig = { ...interestCfg, child: OTHER_CHILD, account: OTHER_ACCOUNT_ID }

    const seeded = baseState({
      docs: {
        ...baseState().docs,
        accounts: {
          v: 1,
          issuedAt: 1,
          accounts: [
            { id: ACCOUNT_ID, child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger' },
            { id: OTHER_ACCOUNT_ID, child: OTHER_CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger' },
          ],
        },
        interest: { v: 1, issuedAt: 1, configs: [poisonedCfg, healthyCfg] },
      },
    })
    const withBalances = [
      { account: ACCOUNT_ID, child: CHILD },
      { account: OTHER_ACCOUNT_ID, child: OTHER_CHILD },
    ].reduce(
      (s, { account, child }) =>
        addEntry(s, {
          v: 1,
          id: `seed-${account}`,
          child,
          kind: 'credit',
          createdAt: 1,
          author: 'guardian',
          legs: [{ account, currency: 'GBP', amountMinor: 10_000 }],
        }),
      seeded,
    )

    expect(() => runSchedulers(withBalances, NOW_INTEREST)).not.toThrow()
    const { entries } = runSchedulers(withBalances, NOW_INTEREST)

    // The poisoned config contributes nothing for CHILD's account...
    expect(entries.some((e) => e.legs.some((l) => l.account === ACCOUNT_ID))).toBe(false)
    // ...but the healthy sibling config still pays normally.
    const otherEntries = entries.filter((e) => e.legs.some((l) => l.account === OTHER_ACCOUNT_ID))
    expect(otherEntries).toHaveLength(1)
    expect(otherEntries[0]!.kind).toBe('interest')
  })

  it('a poisoned allowance config (an out-of-range day domain/period.ts#dueDays would reject) is skipped without throwing', () => {
    // A day value settingsForms.ts's own validDay would refuse at the form
    // boundary, but state itself has no such guard (a hand-edited
    // localStorage blob, or a config written before that validation
    // existed) — domain/period.ts#dueDays throws a RangeError for it.
    const poisonedCfg: AllowanceConfig = { ...allowanceCfg, day: 999 }
    const state = baseState({
      docs: { ...baseState().docs, allowance: { v: 1, issuedAt: 1, configs: [poisonedCfg] } },
    })
    expect(() => runSchedulers(state, NOW)).not.toThrow()
    expect(runSchedulers(state, NOW).entries).toEqual([])
  })
})

describe('runSchedulers: allowance + interest on the same account, same pass', () => {
  it('interest sees the balance INCLUDING an allowance entry this same pass just proposed', () => {
    // Both configs due at NOW; allowance is processed first (see
    // scheduler.ts's ordering) so interest's balance fold picks up the
    // allowance entry this same call is about to also return.
    const weeklyInterestCfg: InterestConfig = { ...interestCfg, cadence: 'weekly', day: 5, startDay: '2026-08-14' }
    const state = baseState({
      docs: {
        ...baseState().docs,
        allowance: { v: 1, issuedAt: 1, configs: [allowanceCfg] },
        interest: { v: 1, issuedAt: 1, configs: [weeklyInterestCfg] },
      },
    })

    const { entries } = runSchedulers(state, NOW)
    const allowanceEntries = entries.filter((e) => e.kind === 'credit')
    const interestEntries = entries.filter((e) => e.kind === 'interest')

    expect(allowanceEntries.length).toBeGreaterThan(0)
    expect(interestEntries).toHaveLength(1)

    const balanceBeforeInterest = balances(allowanceEntries).get(ACCOUNT_ID) ?? 0
    // 5% of the balance that already includes this pass's allowance credits.
    expect(interestEntries[0]!.legs[0]!.amountMinor).toBeGreaterThan(0)
    expect(balanceBeforeInterest).toBeGreaterThan(0)
  })
})

describe('runSchedulers: refused gated periods (audit D4)', () => {
  it('never auto-pays a period whose scheduler claim was denied or dismissed, even with the gate off', () => {
    const decided = (periodKey: string, status: 'denied' | 'dismissed') => ({
      request: { v: 1 as const, op: 'allowance.claim' as const, reqId: `scheduler:${CHILD}:${ACCOUNT_ID}:${periodKey}`, nonce: 'n', child: CHILD, ts: 1, params: { periodKey } },
      authorPk: CHILD,
      status,
      decidedAt: 2,
      createdAt: 1,
    })
    const state = baseState({
      docs: { ...baseState().docs, allowance: { v: 1, issuedAt: 1, configs: [allowanceCfg] } },
      requests: [decided('2026-W32', 'denied'), decided('2026-W33', 'dismissed')],
    })
    const { entries } = runSchedulers(state, NOW)
    expect(entries.map((e) => e.periodKey)).toEqual(['2026-W34'])
  })
})

describe('runSchedulers: interest on the balance as of each due day (audit D2)', () => {
  const cfg: InterestConfig = { child: CHILD, account: ACCOUNT_ID, rateBps: 100, cadence: 'weekly', day: 5, tz: 'UTC', startDay: '2026-03-01' }
  const deposit = (id: string, amountMinor: number, createdAt: number) => ({
    v: 1 as const, id, child: CHILD, kind: 'credit' as const, createdAt, author: 'guardian' as const,
    legs: [{ account: ACCOUNT_ID, currency: 'GBP', amountMinor }],
  })

  it('29 zero-balance weeks then a £100 deposit earns no back-interest', () => {
    const wed = Date.UTC(2026, 8, 23, 12) / 1000 // not a due day
    let state = baseState({ docs: { ...baseState().docs, interest: { v: 1, issuedAt: 1, configs: [cfg] } } })
    state = addEntry(state, deposit('d1', 10_000, wed))
    expect(runSchedulers(state, wed).entries).toEqual([])
    // And on the next due day only that one period earns: 1% of £100.
    const fri = Date.UTC(2026, 8, 25, 12) / 1000
    const { entries } = runSchedulers(state, fri)
    expect(entries.map((e) => e.legs[0]!.amountMinor)).toEqual([100])
    const after = entries.reduce(addEntry, state)
    expect(balances(after.entries).get(ACCOUNT_ID)).toBe(10_100)
  })

  it('catch-up compounds in due-day order, interleaved with allowance', () => {
    const start = '2026-09-01'
    const weekly: InterestConfig = { ...cfg, startDay: start }
    const pocket: AllowanceConfig = { child: CHILD, account: ACCOUNT_ID, amountMinor: 500, cadence: 'weekly', day: 5, tz: 'UTC', startDay: start }
    let state = baseState({
      docs: {
        ...baseState().docs,
        interest: { v: 1, issuedAt: 1, configs: [weekly] },
        allowance: { v: 1, issuedAt: 1, configs: [pocket] },
      },
    })
    state = addEntry(state, deposit('d0', 10_000, Date.UTC(2026, 7, 30) / 1000))
    // Phone off for three Fridays (4, 11, 18 Sep); catch-up on the 19th,
    // after a £1,000 gift that day which must not earn for any of them.
    const sat = Date.UTC(2026, 8, 19, 12) / 1000
    state = addEntry(state, deposit('gift', 100_000, sat))
    const interest = runSchedulers(state, sat).entries.filter((e) => e.kind === 'interest')
    // 4 Sep: 1% of 105.00 = 1.05; 11 Sep: 1% of 111.05 = 1.11; 18 Sep: 1% of 117.16 = 1.17
    expect(interest.map((e) => e.legs[0]!.amountMinor)).toEqual([105, 111, 117])
  })
})

describe('runSchedulers: revoked children (audit D6)', () => {
  it('accrues nothing — allowance, interest or claims — for a revoked child', () => {
    const base = baseState()
    const state = baseState({
      docs: {
        ...base.docs,
        accounts: { ...base.docs.accounts, revoked: { [CHILD]: 1 } },
        allowance: { v: 1, issuedAt: 1, configs: [allowanceCfg, { ...allowanceCfg, choresGate: true }] },
        interest: { v: 1, issuedAt: 1, configs: [interestCfg] },
      },
      entries: [{ v: 1, id: 'seed', child: CHILD, kind: 'credit', createdAt: 1, author: 'guardian', legs: [{ account: ACCOUNT_ID, currency: 'GBP', amountMinor: 10_000 }] }],
    })
    expect(runSchedulers(state, NOW)).toEqual({ entries: [], claims: [] })
  })
})

describe('R1: an interest rate moved off 0 never back-pays past periods', () => {
  const account = { id: ACCOUNT_ID, child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger' as const }
  const t = (y: number, m: number, d: number, h = 8) => Date.UTC(y, m - 1, d, h) / 1000
  it('£100 at 0 % from 07-31, edited to 5 %/week on 08-22: nothing is paid for past Fridays', () => {
    let s = baseState()
    s = addEntry(s, creditEntry({ id: 'dep', child: CHILD, createdAt: t(2026, 8, 1), author: 'guardian' }, account, 10_000))
    const cfg0: InterestConfig = { child: CHILD, account: ACCOUNT_ID, rateBps: 0, cadence: 'weekly', day: 5, tz: 'Europe/London', startDay: '2026-07-31' }
    s = { ...s, docs: { ...s.docs, interest: { v: 1, issuedAt: 2, configs: [cfg0] } } }
    expect(runSchedulers(s, t(2026, 8, 21)).entries).toHaveLength(0)
    const edited = reanchorConfigs([cfg0], [{ ...cfg0, rateBps: 500 }], t(2026, 8, 22))
    s = { ...s, docs: { ...s.docs, interest: { v: 1, issuedAt: 3, configs: edited } } }
    expect(runSchedulers(s, t(2026, 8, 22)).entries).toEqual([])
    // The next Friday pays once, at the new rate.
    expect(runSchedulers(s, t(2026, 8, 28)).entries.map((e) => e.legs[0]!.amountMinor)).toEqual([500])
  })
})

describe('runSchedulers: deposit match (audit S1)', () => {
  const account = { id: ACCOUNT_ID, child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger' as const }
  const box = { id: 'a-box', child: CHILD, name: 'Money box', currency: 'GBP', custody: 'physical' as const }
  const t = (y: number, m: number, d: number, h = 8) => Date.UTC(y, m - 1, d, h) / 1000
  const cfg: InterestConfig = {
    child: CHILD, account: ACCOUNT_ID, rateBps: 100, cadence: 'weekly', day: 5, tz: 'Europe/London', startDay: '2026-08-07',
    matchBps: 5000, matchCapMinor: 1000,
  }
  function withDocs(s: AppState, allowance: AllowanceConfig[] = []): AppState {
    return {
      ...s,
      docs: {
        ...s.docs,
        accounts: { v: 1, issuedAt: 1, accounts: [account, box] },
        allowance: { v: 1, issuedAt: 1, configs: allowance },
        interest: { v: 1, issuedAt: 1, configs: [cfg] },
      },
    }
  }

  it('matches a gift in its window, capped, before the same day\'s interest', () => {
    let s = withDocs(baseState())
    s = addEntry(s, creditEntry({ id: 'gift', child: CHILD, createdAt: t(2026, 8, 10), author: 'guardian' }, account, 4000, 'gift'))
    const { entries } = runSchedulers(s, t(2026, 8, 14))
    expect(entries.map((e) => [e.id, e.legs[0]!.amountMinor])).toEqual([
      ['sched:match:sam:a-ledger:2026-08-14', 1000], // 50% of £40 = £20, capped at £10
      ['sched:interest:sam:a-ledger:2026-08-14', 50], // 1% of £50 (gift + match)
    ])
    expect(entries[0]!.category).toBe('match')
    expect(entries[0]!.periodKey).toBe('2026-W33')
  })

  it('is idempotent: a second run after folding the first pays no second match', () => {
    let s = withDocs(baseState())
    s = addEntry(s, creditEntry({ id: 'gift', child: CHILD, createdAt: t(2026, 8, 10), author: 'guardian' }, account, 400))
    for (const e of runSchedulers(s, t(2026, 8, 14)).entries) s = addEntry(s, e)
    expect(runSchedulers(s, t(2026, 8, 14)).entries).toEqual([])
    // The next week's window starts after 08-14: the same gift is never matched twice.
    expect(runSchedulers(s, t(2026, 8, 21)).entries.filter((e) => e.category === 'match')).toEqual([])
  })

  it('does not match pocket money, transfers between own pots, or deposits before the schedule started', () => {
    let s = withDocs(baseState(), [{ ...allowanceCfg, startDay: '2026-08-07' }])
    s = addEntry(s, creditEntry({ id: 'early', child: CHILD, createdAt: t(2026, 8, 6), author: 'guardian' }, account, 1000))
    s = addEntry(s, creditEntry({ id: 'boxcash', child: CHILD, createdAt: t(2026, 8, 9), author: 'guardian' }, box, 1000))
    s = addEntry(s, transferEntry({ id: 'tx', child: CHILD, createdAt: t(2026, 8, 10), author: 'guardian' }, box, account, 1000))
    const { entries } = runSchedulers(s, t(2026, 8, 14))
    expect(entries.filter((e) => e.category === 'match')).toEqual([])
    expect(entries.some((e) => e.category === 'allowance')).toBe(true)
  })

  it('catch-up pays each missed week\'s match on that week\'s own deposits', () => {
    let s = withDocs(baseState())
    s = addEntry(s, creditEntry({ id: 'w1', child: CHILD, createdAt: t(2026, 8, 12), author: 'guardian' }, account, 200))
    s = addEntry(s, creditEntry({ id: 'w2', child: CHILD, createdAt: t(2026, 8, 19), author: 'guardian' }, account, 600))
    const matches = runSchedulers(s, t(2026, 8, 28)).entries.filter((e) => e.category === 'match')
    expect(matches.map((e) => [e.periodKey, e.legs[0]!.amountMinor])).toEqual([
      ['2026-W33', 100],
      ['2026-W34', 300],
    ])
  })

  it('a match-terms edit re-anchors, so deposits before the edit are never matched at the new terms', () => {
    let s = withDocs(baseState())
    s = { ...s, docs: { ...s.docs, interest: { v: 1, issuedAt: 1, configs: [{ ...cfg, matchBps: undefined, matchCapMinor: undefined }] } } }
    s = addEntry(s, creditEntry({ id: 'gift', child: CHILD, createdAt: t(2026, 8, 10), author: 'guardian' }, account, 1000))
    const prev = s.docs.interest.configs
    const edited = reanchorConfigs(prev, [{ ...prev[0]!, matchBps: 5000 }], t(2026, 8, 12))
    s = { ...s, docs: { ...s.docs, interest: { v: 1, issuedAt: 2, configs: edited } } }
    expect(runSchedulers(s, t(2026, 8, 14)).entries.filter((e) => e.category === 'match')).toEqual([])
  })
})
