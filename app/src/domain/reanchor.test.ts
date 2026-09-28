import { describe, it, expect } from 'vitest'
import type { Account, Entry } from './types'
import { allowanceDue, allowanceEntry, type AllowanceConfig } from './allowance'
import { interestDue, type InterestConfig } from './interest'
import { reanchorConfig, reanchorConfigs, needsReanchor } from './reanchor'
import { dueDays } from './period'

const A: Account = { id: 'A', child: 'sam', name: 'Spending', currency: 'GBP', custody: 'ledger' }
const B: Account = { id: 'B', child: 'sam', name: 'Savings', currency: 'GBP', custody: 'ledger' }

// Weekly £5 on Tuesdays from 2026-06-30 (a Tuesday).
const base: AllowanceConfig = {
  child: 'sam', account: 'A', amountMinor: 500, cadence: 'weekly', day: 2, tz: 'UTC', startDay: '2026-06-30',
}
// Wednesday 2026-09-23 12:00 UTC.
const now = Date.UTC(2026, 8, 23, 12) / 1000
const today = '2026-09-23'

/** Every period due so far, paid into A — the old config is fully up to date. */
function paidHistory(cfg: AllowanceConfig): Entry[] {
  return dueDays({ cadence: cfg.cadence, day: cfg.day, fromExclusive: cfg.startDay, toInclusive: today }).map((d, i) =>
    allowanceEntry(cfg, A, d, { id: `p${i}`, child: 'sam', createdAt: 1, author: 'guardian' }),
  )
}

describe('reanchorConfig (an edit never reopens history)', () => {
  const history = paidHistory(base)

  it('without re-anchoring, switching account re-pays every period', () => {
    expect(allowanceDue({ ...base, account: 'B' }, history, now).length).toBe(history.length)
  })

  it('switching account pays no past period and not the current one twice', () => {
    const next = reanchorConfig(base, { ...base, account: 'B' }, today)
    // Tuesday 22 Sep (W39) was already paid into A, so B starts after that week.
    expect(allowanceDue(next, history, now)).toEqual([])
    const nextTue = Date.UTC(2026, 8, 29, 12) / 1000
    expect(allowanceDue(next, history, nextTue)).toEqual(['2026-09-29'])
  })

  it('switching account then moving the due day into the rest of this week still pays W39 only once', () => {
    const next = reanchorConfig(base, { ...base, account: 'B', day: 5 }, today)
    const fri = Date.UTC(2026, 8, 25, 12) / 1000
    expect(allowanceDue(next, history, fri)).toEqual([])
  })

  it('switching cadence weekly -> monthly pays no past month', () => {
    const next = reanchorConfig(base, { ...base, cadence: 'monthly', day: 1 }, today)
    expect(allowanceDue(next, history, now)).toEqual([])
    expect(allowanceDue(next, history, Date.UTC(2026, 9, 1, 12) / 1000)).toEqual(['2026-10-01'])
  })

  it('un-pausing pays none of the paused periods', () => {
    const paused = { ...base, paused: true }
    const onlyEarly = history.slice(0, 2) // paid twice, then paused
    expect(allowanceDue({ ...base }, onlyEarly, now).length).toBe(history.length - 2) // the bug
    const next = reanchorConfig(paused, { ...base, paused: false }, today)
    expect(allowanceDue(next, onlyEarly, now)).toEqual([])
  })

  it('un-pausing before this period is due still pays this period once', () => {
    const friCfg = { ...base, day: 5 } // Fridays; this week's is 25 Sep, still ahead
    const next = reanchorConfig({ ...friCfg, paused: true }, friCfg, today)
    expect(allowanceDue(next, [], Date.UTC(2026, 8, 25, 12) / 1000)).toEqual(['2026-09-25'])
  })

  it('a due day that falls on the edit day itself is still payable once', () => {
    const wedCfg = { ...base, day: 3 }
    const next = reanchorConfig({ ...wedCfg, paused: true }, wedCfg, '2026-09-22')
    expect(allowanceDue(next, [], now)).toEqual(['2026-09-23'])
  })

  it('turning a gate off pays none of the refused periods', () => {
    const gated = { ...base, choresGate: true }
    const next = reanchorConfig(gated, { ...base, choresGate: false }, today)
    expect(allowanceDue(next, [], now)).toEqual([])
  })

  it('an amount-only edit keeps startDay', () => {
    const next = reanchorConfig(base, { ...base, amountMinor: 700 }, today)
    expect(next.startDay).toBe(base.startDay)
    expect(needsReanchor(base, { ...base, amountMinor: 700 })).toBe(false)
  })

  it('moving startDay backwards by hand cannot reopen history', () => {
    const next = reanchorConfig(base, { ...base, amountMinor: 700, startDay: '2026-01-01' }, today)
    expect(next.startDay).toBe(base.startDay)
  })

  it('a future startDay is kept (never pulled earlier)', () => {
    const future = { ...base, startDay: '2026-12-01' }
    expect(reanchorConfig(future, { ...future, account: 'B' }, today).startDay).toBe('2026-12-01')
  })

  it('a brand-new config is returned unchanged', () => {
    expect(reanchorConfig(undefined, base, today)).toBe(base)
  })

  it('works for interest configs too', () => {
    const icfg = { child: 'sam', account: 'A', rateBps: 100, cadence: 'weekly' as const, day: 2, tz: 'UTC', startDay: '2026-06-30' }
    const next = reanchorConfig(icfg, { ...icfg, account: 'B' }, today)
    expect(interestDue(next, [], now)).toEqual([])
  })
})

describe('reanchorConfigs', () => {
  it('pairs an account switch with its predecessor for the same child', () => {
    const [next] = reanchorConfigs([base], [{ ...base, account: B.id }], now)
    expect(next!.startDay).toBe('2026-09-27')
  })
  it('leaves an unrelated child untouched', () => {
    const other = { ...base, child: 'ella', account: 'E', startDay: '2026-01-01' }
    const out = reanchorConfigs([base], [base, other], now)
    expect(out[1]).toBe(other)
  })
})

describe('an interest amount-term edit re-anchors', () => {
  const i0: InterestConfig = { child: 'sam', account: 'A', rateBps: 0, cadence: 'weekly', day: 2, tz: 'UTC', startDay: '2026-06-30' }
  it('needsReanchor is true for a rate change, and for a match change', () => {
    expect(needsReanchor(i0, { ...i0, rateBps: 500 })).toBe(true)
    expect(needsReanchor(i0, { ...i0, matchBps: 100 })).toBe(true)
    expect(needsReanchor(i0, { ...i0, matchCapMinor: 1000 })).toBe(true)
    expect(needsReanchor(i0, { ...i0 })).toBe(false)
  })
  it('needsReanchor is true for any change to which days are due', () => {
    expect(needsReanchor(i0, { ...i0, day: 5 })).toBe(true)
    expect(needsReanchor(i0, { ...i0, tz: 'Europe/London' })).toBe(true)
    expect(needsReanchor(i0, { ...i0, cadence: 'monthly' })).toBe(true)
    expect(needsReanchor(base, { ...base, day: 5 })).toBe(true)
  })
  it('0 % -> 5 %: no period before the edit is due at the new rate', () => {
    // Wednesday edit; this week's Tuesday has already passed, so nothing is due now.
    const [edited] = reanchorConfigs([i0], [{ ...i0, rateBps: 500 }], now)
    expect(edited!.startDay > i0.startDay).toBe(true)
    expect(interestDue(edited!, [], now)).toEqual([])
  })
  it('an allowance config (no amount terms) is not re-anchored by an unrelated edit', () => {
    expect(needsReanchor(base, { ...base, amountMinor: 700 })).toBe(false)
  })
})

describe('documented edge cases', () => {
  const weekly: AllowanceConfig = { child: 'sam', account: 'A', amountMinor: 500, cadence: 'weekly', day: 5, tz: 'Europe/London', startDay: '2026-08-01' }
  it('an account switch ON the due day, before the tick, forfeits that period (no double pay)', () => {
    const next = reanchorConfig(weekly, { ...weekly, account: 'B' }, '2026-08-21')
    expect(next.startDay).toBe('2026-08-23') // end of ISO week W34: its Friday is paid by neither config
  })
  it('weekly -> monthly after the week is paid still pays the month\'s later due day', () => {
    const next = reanchorConfig(weekly, { ...weekly, cadence: 'monthly', day: 28 }, '2026-08-22')
    expect(next.startDay).toBe('2026-08-23')
    expect(dueDays({ cadence: 'monthly', day: 28, fromExclusive: next.startDay, toInclusive: '2026-08-31' })).toEqual(['2026-08-28'])
  })
})
