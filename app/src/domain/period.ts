// Day keys ('YYYY-MM-DD') are the working unit. Only dayKey() consults a
// timezone; every other function is pure calendar arithmetic, immune to DST.

// Constructing an Intl.DateTimeFormat is costly and dayKey is now called
// once per entry per interest period (domain/interest.ts#balanceAsOf), so
// one formatter per timezone is memoised. Referentially transparent.
const formatters = new Map<string, Intl.DateTimeFormat>()

export function dayKey(unixSec: number, tz: string): string {
  let f = formatters.get(tz)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(tz, f)
  }
  // Assembled from formatToParts rather than trusting a locale's pattern
  // (audit O2): `en-CA` happening to format as YYYY-MM-DD is an ICU detail
  // that has changed before, and every day-key consumer would throw if it
  // did. The Gregorian calendar and Latin digits are pinned explicitly.
  let y = ''
  let m = ''
  let d = ''
  for (const part of f.formatToParts(new Date(unixSec * 1000))) {
    if (part.type === 'year') y = part.value
    else if (part.type === 'month') m = part.value
    else if (part.type === 'day') d = part.value
  }
  const key = `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new RangeError(`cannot form a day key for ${unixSec} in ${tz}`)
  return key
}

function parse(day: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) throw new RangeError(`bad day key: ${day}`)
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function addDays(day: string, n: number): string {
  const { y, m, d } = parse(day)
  const date = new Date(Date.UTC(y, m - 1, d + n))
  return fmt(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

export function weekdayOf(day: string): number {
  const { y, m, d } = parse(day)
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  return js === 0 ? 7 : js
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function dueDays(opts: {
  cadence: 'weekly' | 'monthly'
  day: number
  fromExclusive: string
  toInclusive: string
}): string[] {
  parse(opts.toInclusive) // fail fast on a malformed bound; fromExclusive is parsed by addDays below
  if (!Number.isSafeInteger(opts.day)) throw new RangeError(`day must be a safe integer, got ${opts.day}`)
  if (opts.cadence === 'weekly') {
    if (opts.day < 1 || opts.day > 7) throw new RangeError(`weekly day must be 1..7 (ISO weekday), got ${opts.day}`)
  } else {
    if (opts.day < 1 || opts.day > 31) throw new RangeError(`monthly day must be 1..31, got ${opts.day}`)
  }
  const out: string[] = []
  let cursor = addDays(opts.fromExclusive, 1)
  while (cursor <= opts.toInclusive) {
    if (opts.cadence === 'weekly') {
      if (weekdayOf(cursor) === opts.day) out.push(cursor)
    } else {
      const { y, m, d } = parse(cursor)
      if (d === Math.min(opts.day, daysInMonth(y, m))) out.push(cursor)
    }
    cursor = addDays(cursor, 1)
  }
  return out
}

// Period keys group due days into the calendar period they belong to (e.g.
// '2026-W33', '2026-08'), so idempotence can be checked by period rather
// than by exact due-day — see allowance.ts / interest.ts for why that
// matters when a due weekday or day-of-month changes mid-schedule.

export function monthKeyOf(day: string): string {
  parse(day) // validates the shape
  return day.slice(0, 7)
}

export function isoWeekKey(day: string): string {
  const { y, m, d } = parse(day)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dayNum = (date.getUTCDay() + 6) % 7 // 0 = Monday
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // the week's Thursday
  const isoYear = date.getUTCFullYear()
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7
  const week1Thu = new Date(Date.UTC(isoYear, 0, 4 - jan4DayNum + 3))
  const week = 1 + Math.round((date.getTime() - week1Thu.getTime()) / (7 * 86400000))
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

/**
 * Every day key in the period a `periodKey` names (v0.2 spec §4.2).
 * `YYYY-MM` under the monthly cadence -> that whole month;
 * `YYYY-Www` under the weekly cadence -> Monday..Sunday of that ISO week.
 *
 * TOTAL: an unparseable key, a key whose shape does not match `cadence`, or
 * an ISO week the named year does not actually have (there is no 2025-W53)
 * yields `null` — never a throw. Pure calendar arithmetic; no timezone.
 *
 * The ISO derivation is the inverse of `isoWeekKey` above: 4 January is by
 * definition in ISO week 1, so week 1's Monday is `jan4` walked back to its
 * own Monday, and week `ww`'s Monday is that plus `(ww - 1)` whole weeks.
 * Round-tripping the result back through `isoWeekKey` is what rejects a
 * week number the year does not reach.
 */
export function periodDaysFor(periodKey: string, cadence: 'weekly' | 'monthly'): string[] | null {
  if (cadence === 'monthly') {
    const m = /^(\d{4})-(\d{2})$/.exec(periodKey)
    if (!m) return null
    const y = Number(m[1])
    const month = Number(m[2])
    if (month < 1 || month > 12) return null
    const last = daysInMonth(y, month)
    return Array.from({ length: last }, (_, i) => fmt(y, month, i + 1))
  }

  const m = /^(\d{4})-W(\d{2})$/.exec(periodKey)
  if (!m) return null
  const y = Number(m[1])
  const ww = Number(m[2])
  if (ww < 1 || ww > 53) return null
  const jan4 = fmt(y, 1, 4)
  const week1Monday = addDays(jan4, -(weekdayOf(jan4) - 1))
  const monday = addDays(week1Monday, (ww - 1) * 7)
  if (isoWeekKey(monday) !== periodKey) return null
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}
