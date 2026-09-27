import { describe, it, expect } from 'vitest'
import { periodComplete, tickedDays, type Chore, type ChoreTick } from './chores'

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
