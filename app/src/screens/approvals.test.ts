import { describe, expect, it } from 'vitest'
import { buildRequestPayload } from '../wire/payloads'
import type { AppState, StoredRequest } from '../state/types'
import type { Chore, ChoreTick } from '../domain/chores'
import type { AllowanceConfig } from '../domain/allowance'
import { emptyState } from '../state/state'
import { claimPeriodComplete, clampGrant, isKnownCurrency, pendingByChild, truncateLink } from './approvals'

const CHILD_A = 'a'.repeat(64)
const CHILD_B = 'b'.repeat(64)

function spendRequest(reqId: string, child: string, amountMinor = 150) {
  return buildRequestPayload({
    op: 'spend.request',
    reqId,
    nonce: `n-${reqId}`,
    child,
    ts: 1_700_000_000,
    params: { amountMinor, currency: 'GBP', account: 'acc1' },
  })
}

function stored(reqId: string, child: string, overrides: Partial<StoredRequest> = {}): StoredRequest {
  return { request: spendRequest(reqId, child), authorPk: child, status: 'pending', createdAt: 1_700_000_000, ...overrides }
}

describe('clampGrant', () => {
  it('passes through a value within 0..asked', () => {
    expect(clampGrant(150, 50)).toBe(50)
  })

  it('clamps a negative input to 0 (0 = deny)', () => {
    expect(clampGrant(150, -20)).toBe(0)
  })

  it('clamps an input above asked to asked, never grants more', () => {
    expect(clampGrant(150, 9_999)).toBe(150)
  })

  it('a negative asked amount forces the clamp to exactly 0 regardless of input — never reaches a negative ceiling', () => {
    // The wire parser only checks isSafeInt on params.amountMinor, not
    // non-negativity (wire/payloads.ts) — a malformed/hostile request could
    // name a negative "asked" figure. Without flooring the ceiling at 0
    // first, Math.min(Math.max(input, 0), askedMinor) would clamp a
    // positive input down to that negative ceiling, which is neither 0 nor
    // a valid grant — and would reach debitEntry's assertPositiveMinor as
    // an unhandled throw rather than denying gracefully.
    expect(clampGrant(-50, 30)).toBe(0)
    expect(clampGrant(-50, -5)).toBe(0)
  })

  it('exactly 0 asked or 0 input both land on 0', () => {
    expect(clampGrant(0, 0)).toBe(0)
    expect(clampGrant(150, 0)).toBe(0)
  })
})

// A spend.request's `currency` is only wire-checked as a
// non-empty string, so the Approvals inbox must be able to tell a real
// currency from junk before ever handing it to <Money>/formatMinor.
describe('isKnownCurrency', () => {
  it('is true for every currency this app recognises', () => {
    expect(isKnownCurrency('GBP')).toBe(true)
    expect(isKnownCurrency('EUR')).toBe(true)
    expect(isKnownCurrency('USD')).toBe(true)
    expect(isKnownCurrency('BTC')).toBe(true)
  })

  it('is false for an unrecognised code', () => {
    expect(isKnownCurrency('XYZ')).toBe(false)
    expect(isKnownCurrency('')).toBe(false)
  })

  it('is false for a prototype property name rather than reading an inherited member', () => {
    expect(isKnownCurrency('toString')).toBe(false)
    expect(isKnownCurrency('constructor')).toBe(false)
  })
})

describe('pendingByChild', () => {
  it('groups pending requests by child, newest request first within a group', () => {
    const older = stored('r1', CHILD_A, { createdAt: 100 })
    const newer = stored('r2', CHILD_A, { createdAt: 200 })
    const groups = pendingByChild([older, newer])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.childPubkey).toBe(CHILD_A)
    expect(groups[0]!.requests.map((r) => r.request.reqId)).toEqual(['r2', 'r1'])
  })

  it('orders groups by their own most recent request', () => {
    const aOld = stored('a1', CHILD_A, { createdAt: 100 })
    const bNew = stored('b1', CHILD_B, { createdAt: 300 })
    const groups = pendingByChild([aOld, bNew])
    expect(groups.map((g) => g.childPubkey)).toEqual([CHILD_B, CHILD_A])
  })

  it('excludes approved/denied/dismissed requests — only pending shows in the inbox', () => {
    const approved = stored('r1', CHILD_A, { status: 'approved' })
    const denied = stored('r2', CHILD_A, { status: 'denied' })
    const dismissed = stored('r3', CHILD_A, { status: 'dismissed' })
    const pending = stored('r4', CHILD_A, { status: 'pending' })
    const groups = pendingByChild([approved, denied, dismissed, pending])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.requests.map((r) => r.request.reqId)).toEqual(['r4'])
  })

  it('empty input -> no groups', () => {
    expect(pendingByChild([])).toEqual([])
  })
})

describe('truncateLink', () => {
  it('passes a short link through untouched', () => {
    expect(truncateLink('https://example.com/toy')).toBe('https://example.com/toy')
  })

  it('truncates a link over 60 chars, appending an ellipsis', () => {
    const long = 'https://example.com/' + 'a'.repeat(60)
    const out = truncateLink(long)
    expect(out.length).toBe(61) // 60 chars + '…'
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith('https://example.com/')).toBe(true)
  })

  it('a link exactly 60 chars long is left untouched (no ellipsis)', () => {
    const exact = 'a'.repeat(60)
    expect(truncateLink(exact)).toBe(exact)
  })

  it('a link 61 chars long is truncated to 60 + ellipsis', () => {
    const over = 'a'.repeat(61)
    expect(truncateLink(over)).toBe('a'.repeat(60) + '…')
  })
})

// ============================================================================
// claimPeriodComplete (v0.2 spec §4.2)
// ============================================================================

const WEEK = '2026-W36' // Mon 2026-08-31 .. Sun 2026-09-06

function claimRequest(reqId: string, child: string, periodKey = WEEK) {
  return buildRequestPayload({
    op: 'allowance.claim',
    reqId,
    nonce: `n-${reqId}`,
    child,
    ts: 1_700_000_000,
    params: { periodKey },
  })
}

function claimStored(child: string, periodKey = WEEK): StoredRequest {
  return { request: claimRequest('c1', child, periodKey), authorPk: child, status: 'pending', createdAt: 1_700_000_000 }
}

const weeklyCfg: AllowanceConfig = {
  child: CHILD_A,
  account: 'acc1',
  amountMinor: 500,
  cadence: 'weekly',
  day: 1,
  tz: 'UTC',
  startDay: '2026-01-01',
  choresGate: true,
}

function appWith(parts: { configs?: AllowanceConfig[]; chores?: Chore[]; ticks?: ChoreTick[] } = {}): AppState {
  const base = emptyState()
  return {
    ...base,
    ticks: parts.ticks ?? [],
    docs: {
      ...base.docs,
      allowance: { v: 1, issuedAt: 0, configs: parts.configs ?? [weeklyCfg] },
      chores: { v: 1, issuedAt: 0, chores: parts.chores ?? [] },
    },
  }
}

const weeklyChore: Chore = { id: 'ch-1', child: CHILD_A, name: 'Tidy up', cadence: 'weekly' }

function tick(id: string, chore: string, day: string): ChoreTick {
  return { id, chore, day, at: 1_700_000_000 }
}

describe('claimPeriodComplete', () => {
  it('is null for a spend request and boolean for a claim', () => {
    const app = appWith({ chores: [weeklyChore] })
    expect(claimPeriodComplete(app, stored('r1', CHILD_A))).toBeNull()
    expect(claimPeriodComplete(app, claimStored(CHILD_A))).toBe(false)
  })

  // Fix round 1. domain/chores.ts#periodComplete answers `false` for a child
  // with no chores, which is right for a GATE (nothing done means nothing
  // released) but a lie on a CARD: "Some jobs still to do" when there are no
  // jobs at all. Hidden instead.
  it('is null when the child has no chores to be complete', () => {
    expect(claimPeriodComplete(appWith({ chores: [] }), claimStored(CHILD_A))).toBeNull()
  })

  it('is null when every one of the child\'s chores is archived', () => {
    const archived: Chore = { ...weeklyChore, archived: true }
    expect(claimPeriodComplete(appWith({ chores: [archived] }), claimStored(CHILD_A))).toBeNull()
  })

  it('ignores an archived chore when others remain', () => {
    const archived: Chore = { id: 'ch-old', child: CHILD_A, name: 'Old job', cadence: 'weekly', archived: true }
    const app = appWith({ chores: [weeklyChore, archived], ticks: [tick('t1', 'ch-1', '2026-09-02')] })
    // Complete despite the archived chore never having been ticked.
    expect(claimPeriodComplete(app, claimStored(CHILD_A))).toBe(true)
  })

  // The line only means anything on a card the chores gate actually put there.
  it('is null when the allowance config has no chores gate', () => {
    const ungated: AllowanceConfig = { ...weeklyCfg, choresGate: false }
    expect(claimPeriodComplete(appWith({ configs: [ungated], chores: [weeklyChore] }), claimStored(CHILD_A))).toBeNull()
    const noFlag: AllowanceConfig = { ...weeklyCfg }
    delete noFlag.choresGate
    expect(claimPeriodComplete(appWith({ configs: [noFlag], chores: [weeklyChore] }), claimStored(CHILD_A))).toBeNull()
  })

  it('is true once every non-archived chore is done for the period', () => {
    const app = appWith({ chores: [weeklyChore], ticks: [tick('t1', 'ch-1', '2026-09-02')] })
    expect(claimPeriodComplete(app, claimStored(CHILD_A))).toBe(true)
  })

  it('ignores a tick that falls outside the claimed period', () => {
    const app = appWith({ chores: [weeklyChore], ticks: [tick('t1', 'ch-1', '2026-09-14')] })
    expect(claimPeriodComplete(app, claimStored(CHILD_A))).toBe(false)
  })

  it("ignores another child's chores and ticks", () => {
    const theirs: Chore = { id: 'ch-2', child: CHILD_B, name: 'Their job', cadence: 'weekly' }
    const app = appWith({ chores: [weeklyChore, theirs], ticks: [tick('t1', 'ch-2', '2026-09-02')] })
    expect(claimPeriodComplete(app, claimStored(CHILD_A))).toBe(false)
  })

  it('is null when the child has no allowance config of the claimed shape', () => {
    expect(claimPeriodComplete(appWith({ configs: [] }), claimStored(CHILD_A))).toBeNull()
    // A monthly key against a child whose only config is weekly: unresolvable.
    expect(claimPeriodComplete(appWith({ chores: [weeklyChore] }), claimStored(CHILD_A, '2026-09'))).toBeNull()
  })

  it('is null when the period key cannot be parsed at all', () => {
    expect(claimPeriodComplete(appWith({ chores: [weeklyChore] }), claimStored(CHILD_A, 'nonsense'))).toBeNull()
  })
})
