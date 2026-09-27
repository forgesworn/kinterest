import { ulidTimeMs } from './id'
import { addDays, dayKey } from './period'

export interface Chore {
  id: string
  child: string
  name: string
  cadence: 'daily' | 'weekly'
  archived?: boolean
}

export interface ChoreTick {
  id: string
  chore: string
  day: string // day key the tick applies to
  at: number // unix seconds
}

export function tickedDays(chore: Chore, ticks: ChoreTick[]): Set<string> {
  return new Set(ticks.filter((t) => t.chore === chore.id).map((t) => t.day))
}

/**
 * The first day a chore can be expected to be done (audit S6): the day it
 * was added, read from its ULID id (chores are created with `newId`). With
 * `tz`, that is the local day in `tz`; without one, the day after its UTC
 * day, which can only ever be lenient (never earlier than the true local
 * day anywhere). Null for a chore whose id carries no time (an older or
 * hand-written id) — such a chore counts as always having existed.
 */
export function choreRequiredFrom(chore: Pick<Chore, 'id'>, tz?: string): string | null {
  const ms = ulidTimeMs(chore.id)
  if (ms === null) return null
  const sec = Math.floor(ms / 1000)
  return tz !== undefined ? dayKey(sec, tz) : addDays(dayKey(sec, 'UTC'), 1)
}

/**
 * True when every active chore was done in `periodDays`: each daily chore on
 * every day of the period since it was added, each weekly chore at least
 * once in the period. A chore added mid-period is only required from the
 * day it was added (audit S6) — before, a daily chore added on a Thursday
 * could never complete that week, so the chores gate never opened. A chore
 * added after the period ended is not part of it. False when no chore is
 * required at all. `tz` is the timezone tick days are kept in; see
 * `choreRequiredFrom` for the fallback without it.
 */
export function periodComplete(chores: Chore[], ticks: ChoreTick[], periodDays: string[], tz?: string): boolean {
  if (periodDays.length === 0) return false
  const required = chores
    .filter((c) => !c.archived)
    .map((chore) => {
      const from = choreRequiredFrom(chore, tz)
      return { chore, days: from === null ? periodDays : periodDays.filter((d) => d >= from) }
    })
    .filter((r) => r.days.length > 0)
  if (required.length === 0) return false
  const days = new Set(periodDays)
  return required.every(({ chore, days: requiredDays }) => {
    const done = tickedDays(chore, ticks)
    if (chore.cadence === 'daily') return requiredDays.every((d) => done.has(d))
    return [...done].some((d) => days.has(d))
  })
}
