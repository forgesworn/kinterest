import { describe, expect, it } from 'vitest'
import { emptyState } from '../state/state'
import type { AppState } from '../state/types'
import type { Chore, ChoreTick } from '../domain/chores'
import type { AuditResult } from '../domain/audit'
import type { Account } from '../domain/types'
import { auditOutcome, childActivityRows } from './childActivity'

const CHILD = 'child-pk'
const OTHER = 'other-pk'

const jar: Account = { id: 'acc-jar', child: CHILD, name: 'Coin jar', currency: 'GBP', custody: 'physical' }
const otherJar: Account = { id: 'acc-other', child: OTHER, name: 'Their jar', currency: 'GBP', custody: 'physical' }

const beds: Chore = { id: 'ch-beds', child: CHILD, name: 'Make the bed', cadence: 'daily' }
const bins: Chore = { id: 'ch-bins', child: OTHER, name: 'Take the bins out', cadence: 'weekly' }

function tick(id: string, chore: string, day: string, at: number): ChoreTick {
  return { id, chore, day, at }
}

function audit(id: string, child: string, account: string, deltaMinor: number, at: number): AuditResult {
  return {
    id,
    account,
    child,
    countedMinor: 1000 + deltaMinor,
    expectedMinor: 1000,
    deltaMinor,
    at,
    author: 'child',
  }
}

function stateWith(
  parts: { ticks?: ChoreTick[]; audits?: AuditResult[]; chores?: Chore[]; accounts?: Account[] } = {},
): AppState {
  const base = emptyState()
  return {
    ...base,
    ticks: parts.ticks ?? [],
    audits: parts.audits ?? [],
    docs: {
      ...base.docs,
      accounts: { v: 1, issuedAt: 0, accounts: parts.accounts ?? [jar, otherJar] },
      chores: { v: 1, issuedAt: 0, chores: parts.chores ?? [beds, bins] },
    },
  }
}

describe('childActivityRows', () => {
  it('orders newest first, tie-broken by id ascending', () => {
    const app = stateWith({
      ticks: [
        tick('t-b', beds.id, '2026-09-01', 1000),
        tick('t-a', beds.id, '2026-09-02', 1000),
        tick('t-c', beds.id, '2026-08-30', 900),
      ],
    })
    expect(childActivityRows(app, CHILD).map((r) => r.id)).toEqual(['t-a', 't-b', 't-c'])
  })

  it('drops a tick whose chore is unknown', () => {
    expect(childActivityRows(stateWith({ ticks: [tick('t-1', 'ch-gone', '2026-09-01', 1000)] }), CHILD)).toEqual([])
  })

  it("excludes a tick belonging to another child's chore", () => {
    expect(childActivityRows(stateWith({ ticks: [tick('t-1', bins.id, '2026-09-01', 1000)] }), CHILD)).toEqual([])
  })

  it('names the chore on a tick row', () => {
    const app = stateWith({ ticks: [tick('t-1', beds.id, '2026-09-01', 1000)] })
    expect(childActivityRows(app, CHILD)).toEqual([
      { kind: 'tick', at: 1000, id: 't-1', choreName: 'Make the bed', day: '2026-09-01' },
    ])
  })

  it('excludes an audit whose child is not the target', () => {
    expect(childActivityRows(stateWith({ audits: [audit('a-1', OTHER, otherJar.id, 0, 1000)] }), CHILD)).toEqual([])
  })

  it('carries the account name, amounts and currency on an audit row', () => {
    const app = stateWith({ audits: [audit('a-1', CHILD, jar.id, -25, 1000)] })
    expect(childActivityRows(app, CHILD)).toEqual([
      {
        kind: 'audit',
        at: 1000,
        id: 'a-1',
        accountName: 'Coin jar',
        countedMinor: 975,
        expectedMinor: 1000,
        deltaMinor: -25,
        currency: 'GBP',
      },
    ])
  })

  it('still shows an audit for an archived account', () => {
    const archived: Account = { ...jar, archived: true }
    const app = stateWith({ audits: [audit('a-1', CHILD, jar.id, 0, 1000)], accounts: [archived] })
    expect(childActivityRows(app, CHILD).map((r) => r.id)).toEqual(['a-1'])
  })

  it('drops an audit whose account is unknown (no name or currency to show)', () => {
    const app = stateWith({ audits: [audit('a-1', CHILD, 'acc-gone', 0, 1000)] })
    expect(childActivityRows(app, CHILD)).toEqual([])
  })

  it('interleaves ticks and audits by time', () => {
    const app = stateWith({
      ticks: [tick('t-1', beds.id, '2026-09-01', 1000)],
      audits: [audit('a-1', CHILD, jar.id, 0, 2000), audit('a-2', CHILD, jar.id, 0, 500)],
    })
    expect(childActivityRows(app, CHILD).map((r) => r.id)).toEqual(['a-1', 't-1', 'a-2'])
  })

  it('respects limit, defaulting to 50', () => {
    const ticks = Array.from({ length: 60 }, (_, i) =>
      tick(`t-${String(i).padStart(2, '0')}`, beds.id, '2026-09-01', 1000 + i),
    )
    const app = stateWith({ ticks })
    expect(childActivityRows(app, CHILD)).toHaveLength(50)
    expect(childActivityRows(app, CHILD, 3).map((r) => r.id)).toEqual(['t-59', 't-58', 't-57'])
  })

  it('classifies an audit outcome', () => {
    expect(auditOutcome(0)).toBe('matched')
    expect(auditOutcome(25)).toBe('over')
    expect(auditOutcome(-25)).toBe('short')
  })

  it('is pure — it does not mutate the arrays it reads', () => {
    const app = stateWith({
      ticks: [tick('t-2', beds.id, '2026-09-01', 2000), tick('t-1', beds.id, '2026-09-01', 1000)],
    })
    const before = app.ticks.map((t) => t.id)
    childActivityRows(app, CHILD)
    expect(app.ticks.map((t) => t.id)).toEqual(before)
  })
})
