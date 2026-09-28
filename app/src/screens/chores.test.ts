import { describe, expect, it } from 'vitest'
import { addDays, dayKey } from '../domain/period'
import { newId } from '../domain/id'
import type { Chore, ChoreTick } from '../domain/chores'
import type { AllowanceConfig } from '../domain/allowance'
import type { Entry } from '../domain/types'
import { creditEntry } from '../domain/ledger'
import type { Account } from '../domain/types'
import type { StoredRequest } from '../state/types'
import type { RequestPayload } from '../wire/payloads'
import {
  buildGateClaim,
  choreGateProgress,
  choreGateReadyClaims,
  choreTickId,
  periodDaysEndingAt,
  previousPeriodBoundary,
  progressFillPercent,
  raiseChoreGateClaims,
  type ChoreGateProgress,
} from './chores'
import { emptyState } from '../state/state'
import type { AppState } from '../state/types'

// Narrowing helpers — `choreGateProgress` returns a discriminated union (or
// null); every test below that needs one shape's own fields asserts it got
// that shape first, via these, rather than a bare `!` that leaves `progress`
// itself still nullable to the type checker afterwards.
function expectDaysShape(p: ChoreGateProgress | null): Extract<ChoreGateProgress, { kind: 'days' }> {
  if (p === null || p.kind !== 'days') throw new Error(`expected a 'days' shape progress, got ${JSON.stringify(p)}`)
  return p
}
function expectChoresShape(p: ChoreGateProgress | null): Extract<ChoreGateProgress, { kind: 'chores' }> {
  if (p === null || p.kind !== 'chores') throw new Error(`expected a 'chores' shape progress, got ${JSON.stringify(p)}`)
  return p
}

const CHILD = 'sam-pk'

// Weekly config: due every Friday (ISO weekday 5), started the Friday before
// any due day this file tests against.
const weeklyCfg: AllowanceConfig = {
  child: CHILD,
  account: 'acc-1',
  amountMinor: 500,
  cadence: 'weekly',
  day: 5,
  tz: 'UTC',
  startDay: '2026-07-24', // a Friday
}

const teeth: Chore = { id: 'c1', child: CHILD, name: 'Brush teeth', cadence: 'daily' }
const bins: Chore = { id: 'c2', child: CHILD, name: 'Take the bins out', cadence: 'weekly' }

function tick(choreId: string, day: string): ChoreTick {
  return { id: choreTickId(choreId, day), chore: choreId, day, at: 1000 }
}

function nowAt(day: string): number {
  // noon UTC on `day` — safely inside the day regardless of DST edge cases.
  return Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000)
}

// ============================================================================
// previousPeriodBoundary / periodDaysEndingAt
// ============================================================================

describe('previousPeriodBoundary', () => {
  it('the FIRST due day after startDay -> startDay itself is the boundary', () => {
    expect(previousPeriodBoundary(weeklyCfg, '2026-07-31')).toBe('2026-07-24')
  })

  it('a LATER due day -> the PREVIOUS due day is the boundary, not startDay', () => {
    expect(previousPeriodBoundary(weeklyCfg, '2026-08-07')).toBe('2026-07-31')
  })
})

describe('periodDaysEndingAt', () => {
  it('spans every calendar day from the day after the previous boundary through dueDay inclusive', () => {
    const days = periodDaysEndingAt(weeklyCfg, '2026-07-31')
    expect(days[0]).toBe('2026-07-25')
    expect(days[days.length - 1]).toBe('2026-07-31')
    // Dense — every day accounted for, none skipped.
    let cursor = '2026-07-25'
    for (const d of days) {
      expect(d).toBe(cursor)
      cursor = addDays(cursor, 1)
    }
  })
})

// ============================================================================
// choreGateProgress
// ============================================================================

describe('choreGateProgress', () => {
  it('null when the config is paused', () => {
    const progress = choreGateProgress({ ...weeklyCfg, paused: true }, [teeth], [], '2026-07-28', nowAt('2026-07-28'))
    expect(progress).toBeNull()
  })

  it('null when there are no active chores at all', () => {
    const archivedOnly = { ...teeth, archived: true }
    expect(choreGateProgress(weeklyCfg, [archivedOnly], [], '2026-07-28', nowAt('2026-07-28'))).toBeNull()
    expect(choreGateProgress(weeklyCfg, [], [], '2026-07-28', nowAt('2026-07-28'))).toBeNull()
  })

  it('daily (or mixed) chore list: "days" shape, counting elapsed days with every active daily chore ticked — future days never counted, unchanged from before this fix', () => {
    const today = '2026-07-28' // Tuesday, mid-period (period 2026-07-25..2026-07-31)
    const ticks = [tick('c1', '2026-07-25'), tick('c1', '2026-07-26'), tick('c1', '2026-07-27')] // not today yet
    const progress = expectDaysShape(choreGateProgress(weeklyCfg, [teeth], ticks, today, nowAt(today)))
    expect(progress.dueDay).toBe('2026-07-31')
    expect(progress.doneDays).toBe(3) // 25/26/27 done; 28 (today) not yet ticked; 29-31 not elapsed
    expect(progress.totalDays).toBe(7)
    expect(progress.complete).toBe(false) // teeth not ticked every day of the period yet
  })

  it('a mixed list (daily + weekly): `complete` reflects periodComplete over BOTH — every daily day ticked is not enough on its own while the weekly chore is outstanding', () => {
    // One day short of the due day, so every day that CAN have elapsed has
    // (nextDueDay itself always excludes "today" from what's elapsed —
    // see this function's own `laterDay`/`fromExclusive` reasoning).
    const today = '2026-07-30'
    const days = periodDaysEndingAt(weeklyCfg, '2026-07-31')
    const ticks = days.filter((d) => d <= today).map((d) => tick('c1', d)) // every elapsed daily day ticked...
    const progress = expectDaysShape(choreGateProgress(weeklyCfg, [teeth, bins], ticks, today, nowAt(today))) // ...but `bins` (weekly) never ticked
    expect(progress.doneDays).toBe(progress.totalDays - 1) // every ELAPSED daily day (all but the due day itself)
    expect(progress.complete).toBe(false) // bins (weekly) still outstanding — periodComplete requires every active chore
  })

  // Review fix: a weekly-only active chore list must NOT read as vacuously
  // "complete" via Array.every over an empty daily list — see this
  // function's own header for the bug this replaces.
  it('a weekly-only chore list uses the "chores" shape, and reports NOT complete with zero ticks (not a vacuous full bar)', () => {
    const today = '2026-07-27'
    const progress = expectChoresShape(choreGateProgress(weeklyCfg, [bins], [], today, nowAt(today)))
    expect(progress.doneCount).toBe(0)
    expect(progress.totalCount).toBe(1)
    expect(progress.complete).toBe(false)
  })

  it('a weekly-only chore list reports complete once its one weekly chore has any tick inside the current period', () => {
    const today = '2026-07-27'
    const progress = expectChoresShape(choreGateProgress(weeklyCfg, [bins], [tick('c2', '2026-07-26')], today, nowAt(today)))
    expect(progress.doneCount).toBe(1)
    expect(progress.totalCount).toBe(1)
    expect(progress.complete).toBe(true)
  })

  it('two weekly chores, one ticked: "1 of 2 chores this week", still not complete', () => {
    const secondWeekly: Chore = { ...bins, id: 'c3', name: 'Feed the cat' }
    const today = '2026-07-27'
    const progress = expectChoresShape(
      choreGateProgress(weeklyCfg, [bins, secondWeekly], [tick('c2', '2026-07-26')], today, nowAt(today)),
    )
    expect(progress.doneCount).toBe(1)
    expect(progress.totalCount).toBe(2)
    expect(progress.complete).toBe(false)
  })
})

// ============================================================================
// progressFillPercent
// ============================================================================

describe('progressFillPercent', () => {
  it('complete: true always reads 100%, regardless of the raw ratio', () => {
    expect(progressFillPercent({ kind: 'days', dueDay: '2026-07-31', doneDays: 0, totalDays: 7, complete: true })).toBe(100)
  })

  it('complete: false is capped below 100% even when the raw ratio would round to it — the bar must never read "done" early', () => {
    const pct = progressFillPercent({ kind: 'days', dueDay: '2026-07-31', doneDays: 7, totalDays: 7, complete: false })
    expect(pct).toBeLessThan(100)
    expect(pct).toBe(95)
  })

  it('a "chores" shape with zero done reads 0%', () => {
    expect(progressFillPercent({ kind: 'chores', dueDay: '2026-07-31', doneCount: 0, totalCount: 2, complete: false })).toBe(0)
  })
})

// ============================================================================
// choreGateReadyClaims / buildGateClaim
// ============================================================================

function claimStored(periodKey: string, overrides: Partial<StoredRequest> = {}): StoredRequest {
  const request: RequestPayload = {
    v: 1,
    op: 'allowance.claim',
    reqId: `req-${periodKey}`,
    nonce: 'n',
    child: CHILD,
    ts: 1000,
    params: { periodKey },
  }
  return { request, authorPk: CHILD, status: 'pending', createdAt: 1000, ...overrides }
}

const account: Account = { id: 'acc-1', child: CHILD, name: 'Spending', currency: 'GBP', custody: 'ledger' }

describe('choreGateReadyClaims', () => {
  it('not gated (choresGate unset) -> nothing to raise, even if the period is complete', () => {
    const dueDay = '2026-07-31'
    const days = periodDaysEndingAt(weeklyCfg, dueDay)
    const ticks = days.map((d) => tick('c1', d))
    const claims = choreGateReadyClaims(weeklyCfg, [teeth], ticks, [], [], nowAt('2026-08-01'))
    expect(claims).toEqual([])
  })

  it('gated + due + complete -> raises exactly one ready claim, with the SAME periodKey the guardian would validate', () => {
    const gated: AllowanceConfig = { ...weeklyCfg, choresGate: true }
    const dueDay = '2026-07-31'
    const days = periodDaysEndingAt(gated, dueDay)
    const ticks = days.map((d) => tick('c1', d))
    const claims = choreGateReadyClaims(gated, [teeth], ticks, [], [], nowAt('2026-08-01'))
    expect(claims).toHaveLength(1)
    expect(claims[0]!.dueDay).toBe(dueDay)
    expect(claims[0]!.periodKey).toBe('2026-W31')
  })

  it('a chore added on the period s last day is required from that local day, in the config s timezone', () => {
    const gated: AllowanceConfig = { ...weeklyCfg, choresGate: true }
    const lateChore: Chore = { ...teeth, id: newId(Date.UTC(2026, 6, 31, 10), (n) => new Uint8Array(n)) }
    const claims = choreGateReadyClaims(gated, [lateChore], [tick(lateChore.id, '2026-07-31')], [], [], nowAt('2026-08-01'))
    expect(claims.map((c) => c.periodKey)).toEqual(['2026-W31'])
  })

  it('gated + due but NOT complete -> nothing raised', () => {
    const gated: AllowanceConfig = { ...weeklyCfg, choresGate: true }
    const claims = choreGateReadyClaims(gated, [teeth], [], [], [], nowAt('2026-08-01'))
    expect(claims).toEqual([])
  })

  it('gated + due + complete BUT already claimed for that periodKey -> not raised again', () => {
    const gated: AllowanceConfig = { ...weeklyCfg, choresGate: true }
    const dueDay = '2026-07-31'
    const days = periodDaysEndingAt(gated, dueDay)
    const ticks = days.map((d) => tick('c1', d))
    const existing = [claimStored('2026-W31')]
    const claims = choreGateReadyClaims(gated, [teeth], ticks, [], existing, nowAt('2026-08-01'))
    expect(claims).toEqual([])
  })

  it('already-paid period (an entry with that periodKey already exists) -> allowanceDue excludes it, nothing raised', () => {
    const gated: AllowanceConfig = { ...weeklyCfg, choresGate: true }
    const dueDay = '2026-07-31'
    const days = periodDaysEndingAt(gated, dueDay)
    const ticks = days.map((d) => tick('c1', d))
    const paidEntry: Entry = {
      ...creditEntry({ id: 'e1', child: CHILD, createdAt: 1000, author: 'guardian' }, account, 500, 'allowance'),
      periodKey: '2026-W31',
    }
    const claims = choreGateReadyClaims(gated, [teeth], ticks, [paidEntry], [], nowAt('2026-08-01'))
    expect(claims).toEqual([])
  })
})

describe('buildGateClaim', () => {
  it('builds an allowance.claim carrying exactly the given periodKey, with a fresh reqId/nonce', () => {
    const payload = buildGateClaim(CHILD, { dueDay: '2026-07-31', periodKey: '2026-W31' }, nowAt('2026-08-01'))
    expect(payload.op).toBe('allowance.claim')
    expect(payload.child).toBe(CHILD)
    expect(payload.params).toEqual({ periodKey: '2026-W31' })
    expect(payload.reqId.length).toBeGreaterThan(0)
    expect(payload.nonce.length).toBeGreaterThan(0)
  })
})

// Sanity: dayKey/nowAt agree with the fixture's own day boundaries used above.
describe('fixture sanity', () => {
  it('nowAt(day) resolves back to the same UTC day key', () => {
    expect(dayKey(nowAt('2026-07-28'), 'UTC')).toBe('2026-07-28')
  })
})

describe('raiseChoreGateClaims', () => {
  const gated: AllowanceConfig = { ...weeklyCfg, choresGate: true }
  const days = periodDaysEndingAt(gated, '2026-07-31')
  function childApp(over: Partial<AppState> = {}): AppState {
    const base = emptyState()
    return {
      ...base,
      role: 'child',
      self: { pubkey: CHILD, childIndex: 0 },
      docs: {
        ...base.docs,
        allowance: { ...base.docs.allowance, configs: [gated] },
        chores: { ...base.docs.chores, chores: [teeth] },
      },
      ticks: days.map((d) => tick('c1', d)),
      ...over,
    }
  }

  it('raises one claim for a ready period and folds it into requests', () => {
    const { app, raised } = raiseChoreGateClaims(childApp(), nowAt('2026-08-01'))
    expect(raised).toHaveLength(1)
    expect(raised[0]!.op).toBe('allowance.claim')
    expect((raised[0]!.params as { periodKey: string }).periodKey).toBe('2026-W31')
    expect(app.requests.map((r) => r.request.reqId)).toEqual([raised[0]!.reqId])
  })

  it('is idempotent: a second run over its own output raises nothing and returns the same app', () => {
    const first = raiseChoreGateClaims(childApp(), nowAt('2026-08-01'))
    const second = raiseChoreGateClaims(first.app, nowAt('2026-08-01') + 60)
    expect(second.raised).toEqual([])
    expect(second.app).toBe(first.app)
  })

  it('does nothing on a guardian device, or before this device knows its own pubkey', () => {
    const g = childApp({ role: 'guardian' })
    expect(raiseChoreGateClaims(g, nowAt('2026-08-01')).app).toBe(g)
    const unpaired = childApp({ self: { pubkey: null, childIndex: null } } as Partial<AppState>)
    expect(raiseChoreGateClaims(unpaired, nowAt('2026-08-01')).raised).toEqual([])
  })
})
