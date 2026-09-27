import { describe, it, expect } from 'vitest'
import { dayKey, addDays, weekdayOf, daysInMonth, dueDays, isoWeekKey, monthKeyOf, periodDaysFor } from './period'

describe('dayKey', () => {
  // 2026-08-10T23:30:00Z
  const lateEveningUtc = Date.UTC(2026, 7, 10, 23, 30) / 1000
  it('respects the timezone', () => {
    expect(dayKey(lateEveningUtc, 'Europe/London')).toBe('2026-08-11') // BST = UTC+1
    expect(dayKey(lateEveningUtc, 'UTC')).toBe('2026-08-10')
  })
})

describe('calendar arithmetic', () => {
  it('addDays crosses months and years', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('weekdayOf is ISO numbered', () => {
    expect(weekdayOf('2026-08-10')).toBe(1) // a Monday
    expect(weekdayOf('2026-08-16')).toBe(7) // a Sunday
  })
  it('daysInMonth handles leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2026, 9)).toBe(30)
  })
})

describe('dueDays', () => {
  it('weekly: every matching weekday in the window', () => {
    // Fridays between Mon 2026-08-10 (excl) and Sun 2026-08-30 (incl)
    expect(dueDays({ cadence: 'weekly', day: 5, fromExclusive: '2026-08-10', toInclusive: '2026-08-30' }))
      .toEqual(['2026-08-14', '2026-08-21', '2026-08-28'])
  })
  it('monthly: the configured day, clamped to short months', () => {
    expect(dueDays({ cadence: 'monthly', day: 31, fromExclusive: '2026-01-15', toInclusive: '2026-04-30' }))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })
  it('empty window → no due days', () => {
    expect(dueDays({ cadence: 'weekly', day: 5, fromExclusive: '2026-08-14', toInclusive: '2026-08-14' }))
      .toEqual([])
  })
  it('rejects a malformed toInclusive instead of looping forever', () => {
    expect(() => dueDays({ cadence: 'weekly', day: 5, fromExclusive: '2026-08-10', toInclusive: 'zzz' }))
      .toThrow(RangeError)
  })
  it('rejects an out-of-range weekly day', () => {
    expect(() => dueDays({ cadence: 'weekly', day: 0, fromExclusive: '2026-08-10', toInclusive: '2026-08-30' }))
      .toThrow(RangeError)
    expect(() => dueDays({ cadence: 'weekly', day: 8, fromExclusive: '2026-08-10', toInclusive: '2026-08-30' }))
      .toThrow(RangeError)
  })
  it('rejects an out-of-range monthly day', () => {
    expect(() => dueDays({ cadence: 'monthly', day: 0, fromExclusive: '2026-08-10', toInclusive: '2026-08-30' }))
      .toThrow(RangeError)
    expect(() => dueDays({ cadence: 'monthly', day: 32, fromExclusive: '2026-08-10', toInclusive: '2026-08-30' }))
      .toThrow(RangeError)
  })
  it('rejects a non-integer day', () => {
    expect(() => dueDays({ cadence: 'weekly', day: 1.5, fromExclusive: '2026-08-10', toInclusive: '2026-08-30' }))
      .toThrow(RangeError)
    expect(() => dueDays({ cadence: 'monthly', day: 1.5, fromExclusive: '2026-08-10', toInclusive: '2026-08-30' }))
      .toThrow(RangeError)
  })
})

describe('isoWeekKey', () => {
  it('gives the ISO year-week of a day', () => {
    expect(isoWeekKey('2026-08-14')).toBe('2026-W33')
  })
  it('handles the first ISO week of a year', () => {
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01')
  })
  it('attributes a January date to the prior ISO year when it belongs to that week', () => {
    // 2026 has 53 ISO weeks; New Year's Day 2027 is a Friday belonging to the previous ISO year
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53')
  })
})

describe('monthKeyOf', () => {
  it('gives the YYYY-MM prefix of a day', () => {
    expect(monthKeyOf('2026-02-28')).toBe('2026-02')
  })
  it('rejects a malformed day', () => {
    expect(() => monthKeyOf('zzz')).toThrow(RangeError)
  })
})

describe('periodDaysFor', () => {
  it('covers a month and an ISO week', () => {
    const sep = periodDaysFor('2026-09', 'monthly')
    expect(sep).toHaveLength(30)
    expect(sep![0]).toBe('2026-09-01')
    expect(sep![29]).toBe('2026-09-30')
    const wk = periodDaysFor('2026-W36', 'weekly')
    expect(wk).toHaveLength(7)
    expect(weekdayOf(wk![0]!)).toBe(1)
    expect(weekdayOf(wk![6]!)).toBe(7)
    expect(wk!.every((d) => isoWeekKey(d) === '2026-W36')).toBe(true)
    expect(periodDaysFor('nonsense', 'weekly')).toBeNull()
  })

  it('handles February in a leap year and in a common year', () => {
    expect(periodDaysFor('2028-02', 'monthly')).toHaveLength(29)
    expect(periodDaysFor('2026-02', 'monthly')).toHaveLength(28)
  })

  it('handles 2026-W01, whose Monday falls in the previous calendar year', () => {
    const wk = periodDaysFor('2026-W01', 'weekly')
    expect(wk).toHaveLength(7)
    expect(wk![0]).toBe('2025-12-29')
    expect(weekdayOf(wk![0]!)).toBe(1)
    expect(wk!.every((d) => isoWeekKey(d) === '2026-W01')).toBe(true)
  })

  it('handles an ISO week that spans a year boundary', () => {
    const wk = periodDaysFor('2026-W53', 'weekly')
    expect(wk).toHaveLength(7)
    expect(wk![0]).toBe('2026-12-28')
    expect(wk!.every((d) => isoWeekKey(d) === '2026-W53')).toBe(true)
  })

  it('is total — a key of the wrong shape for the cadence yields null, never a throw', () => {
    expect(periodDaysFor('2026-09', 'weekly')).toBeNull()
    expect(periodDaysFor('2026-W36', 'monthly')).toBeNull()
    expect(periodDaysFor('', 'monthly')).toBeNull()
    expect(periodDaysFor('2026-13', 'monthly')).toBeNull()
    expect(periodDaysFor('2026-00', 'monthly')).toBeNull()
    expect(periodDaysFor('2026-W00', 'weekly')).toBeNull()
    expect(periodDaysFor('2026-W54', 'weekly')).toBeNull()
    expect(periodDaysFor('2026-W53x', 'weekly')).toBeNull()
  })

  it('rejects a week 53 in a year that has only 52 ISO weeks', () => {
    expect(periodDaysFor('2025-W53', 'weekly')).toBeNull()
  })
})
