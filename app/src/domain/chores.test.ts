import { describe, it, expect } from 'vitest'
import { choreRequiredFrom, periodComplete, tickedDays, type Chore, type ChoreTick } from './chores'
import { newId } from './id'

const teeth: Chore = { id: 'c1', child: 'sam', name: 'Brush teeth', cadence: 'daily' }
const bins: Chore = { id: 'c2', child: 'sam', name: 'Take the bins out', cadence: 'weekly' }
const week = ['2026-08-10', '2026-08-11', '2026-08-12']

const tick = (chore: string, day: string, n: number): ChoreTick => ({ id: `t${n}`, chore, day, at: n })

describe('periodComplete', () => {
  it('daily chores need every day ticked', () => {
    const ticks = [tick('c1', '2026-08-10', 1), tick('c1', '2026-08-11', 2), tick('c1', '2026-08-12', 3)]
    expect(periodComplete([teeth], ticks, week)).toBe(true)
    expect(periodComplete([teeth], ticks.slice(0, 2), week)).toBe(false)
  })
  it('weekly chores need at least one tick in the period', () => {
    expect(periodComplete([bins], [tick('c2', '2026-08-11', 1)], week)).toBe(true)
    expect(periodComplete([bins], [tick('c2', '2026-08-01', 1)], week)).toBe(false)
  })
  it('archived chores do not count against completion', () => {
    const old: Chore = { ...bins, id: 'c3', archived: true }
    expect(periodComplete([bins, old], [tick('c2', '2026-08-11', 1)], week)).toBe(true)
  })
  it('no active chores → not complete (an empty list earns nothing)', () => {
    expect(periodComplete([], [], week)).toBe(false)
  })
  it('duplicate ticks on one day count once', () => {
    const ticks = [tick('c1', '2026-08-10', 1), tick('c1', '2026-08-10', 2)]
    expect(tickedDays(teeth, ticks).size).toBe(1)
  })
  it('an empty period can never be complete', () => {
    expect(periodComplete([teeth], [], [])).toBe(false)
    expect(periodComplete([teeth, bins], [tick('c1', '2026-08-10', 1)], [])).toBe(false)
  })
})

describe('a chore added mid-period', () => {
  // Added Wednesday 2026-08-12 10:00 London = 09:00 UTC.
  const addedMs = Date.UTC(2026, 7, 12, 9)
  const dishes: Chore = { id: newId(addedMs), child: 'sam', name: 'Dishes', cadence: 'daily' }
  const period = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']

  it('is only required from the day it was added (in tz)', () => {
    expect(choreRequiredFrom(dishes, 'Europe/London')).toBe('2026-08-12')
    const ticks = [tick(dishes.id, '2026-08-12', 1), tick(dishes.id, '2026-08-13', 2)]
    expect(periodComplete([dishes], ticks, period, 'Europe/London')).toBe(true)
    expect(periodComplete([dishes], ticks.slice(1), period, 'Europe/London')).toBe(false)
  })
  it('without a tz, is required from the day after its UTC day (never stricter than the local day)', () => {
    expect(choreRequiredFrom(dishes)).toBe('2026-08-13')
    expect(periodComplete([dishes], [tick(dishes.id, '2026-08-13', 1)], period)).toBe(true)
  })
  it('a chore added after the period is not part of it; a period with no required chore is not complete', () => {
    const later: Chore = { ...dishes, id: newId(Date.UTC(2026, 7, 20, 9)) }
    expect(periodComplete([later], [], period, 'Europe/London')).toBe(false)
    expect(periodComplete([teeth, later], [tick('c1', '2026-08-10', 1), tick('c1', '2026-08-11', 2), tick('c1', '2026-08-12', 3), tick('c1', '2026-08-13', 4)], period, 'Europe/London')).toBe(true)
  })
  it('a chore with a non-ULID id counts as always having existed', () => {
    expect(choreRequiredFrom(teeth)).toBeNull()
  })
})
