// Schedule re-anchoring — an edit to an allowance/interest config never
// reopens history (audit D1/D3/D4).
//
// `allowanceDue`/`interestDue` rescan from `startDay` and treat a period as
// paid only when an entry carries that period's key AND a leg on the
// config's account. Changing `account` or `cadence` therefore makes every
// past period look unpaid; un-pausing or switching a gate off exposes every
// period that was deliberately never paid; changing an interest config's
// rate would pay every still-open past period at the new rate (review R1).
// Re-anchoring moves `startDay`
// forward at the moment of such an edit so none of those periods can come
// back.
//
// Invariant (for a triggering edit made on `today`):
//   - no period whose due day is before `today` is ever paid by the new
//     config;
//   - the old config's current period (the one containing `today`) is paid
//     at most once in total across old and new configs: if its due day has
//     already arrived (so the old config paid it, or deliberately did not),
//     the new schedule starts only after that whole period ends.
//
// Pure: `today` is a day key in the config's own timezone, supplied by the
// caller.

import { addDays, dayKey, dueDays, isoWeekKey, monthKeyOf, periodDaysFor } from './period'

export interface SchedulableConfig {
  child: string
  account: string
  cadence: 'weekly' | 'monthly'
  day: number
  tz: string
  startDay: string
  paused?: boolean
  choresGate?: boolean
  auditGate?: boolean
}

function laterOf(a: string, b: string): string {
  return a >= b ? a : b
}

function earlierOf(a: string, b: string): string {
  return a <= b ? a : b
}

// Fields that set how much a period pays (interest configs only; an
// allowance config has none of them). Changing any of them re-anchors, so a
// period before the edit is never paid at the new terms (review R1: a rate
// moved off 0 used to back-pay every zero-paid period since `startDay`).
const AMOUNT_TERMS = ['rateBps', 'matchBps', 'matchCapMinor'] as const

function amountTermsChanged(prev: SchedulableConfig, next: SchedulableConfig): boolean {
  const p = prev as unknown as Record<string, unknown>
  const n = next as unknown as Record<string, unknown>
  return AMOUNT_TERMS.some((f) => p[f] !== n[f])
}

/** True when moving from `prev` to `next` could expose periods that were
 *  never meant to be paid under `next`'s schedule or terms. */
export function needsReanchor<C extends SchedulableConfig>(prev: C, next: C): boolean {
  return (
    amountTermsChanged(prev, next) ||
    prev.account !== next.account ||
    prev.cadence !== next.cadence ||
    Boolean(prev.paused) !== Boolean(next.paused) ||
    (Boolean(prev.choresGate) && !next.choresGate) ||
    (Boolean(prev.auditGate) && !next.auditGate)
  )
}

/** The old config's due day inside the period containing `today`, or null
 *  if that period has no due day under the old schedule (e.g. it starts
 *  after `prev.startDay` is still in the future). */
function currentPeriodOf(prev: SchedulableConfig, today: string): { dueDay: string | null; lastDay: string } {
  const key = prev.cadence === 'weekly' ? isoWeekKey(today) : monthKeyOf(today)
  const days = periodDaysFor(key, prev.cadence)
  // periodDaysFor is total over keys produced by isoWeekKey/monthKeyOf, so
  // this is never null in practice; fall back to `today` defensively.
  if (days === null || days.length === 0) return { dueDay: null, lastDay: today }
  const first = days[0]!
  const lastDay = days[days.length - 1]!
  const due = dueDays({ cadence: prev.cadence, day: prev.day, fromExclusive: laterOf(addDays(first, -1), prev.startDay), toInclusive: lastDay })
  return { dueDay: due[0] ?? null, lastDay }
}

/**
 * Returns `next` with `startDay` moved forward so the edit from `prev`
 * cannot reopen history. `today` is the edit day ('YYYY-MM-DD') in the
 * config's timezone.
 *
 * - No previous config: `next` is returned unchanged (a brand-new schedule).
 * - A triggering edit (`needsReanchor`): `startDay` becomes the later of
 *   `next.startDay` and a floor. The floor is the last day of the old
 *   config's current period when that period's due day is on or before
 *   `today`; otherwise it is the day before `today` (so a due day falling
 *   on the edit day itself can still be paid once by the new config).
 * - Any other edit: `startDay` may not move to before the earlier of
 *   `prev.startDay` and the day before `today`, so hand-editing `startDay`
 *   backwards cannot reopen history either.
 */
export function reanchorConfig<C extends SchedulableConfig>(prev: C | undefined, next: C, today: string): C {
  if (prev === undefined) return next
  let floor: string
  if (needsReanchor(prev, next)) {
    const { dueDay, lastDay } = currentPeriodOf(prev, today)
    floor = dueDay !== null && dueDay <= today ? lastDay : addDays(today, -1)
  } else {
    floor = earlierOf(prev.startDay, addDays(today, -1))
  }
  const startDay = laterOf(next.startDay, floor)
  return startDay === next.startDay ? next : { ...next, startDay }
}

/** For a config with no exact (child, account) predecessor: the first
 *  unclaimed config for the same child whose account no longer appears for
 *  that child in `next` (an account switch). */
function switchedFrom<C extends SchedulableConfig>(prev: readonly C[], next: readonly C[], cfg: C, used: Set<number>): number {
  return prev.findIndex(
    (p, i) =>
      !used.has(i) &&
      p.child === cfg.child &&
      !next.some((n) => n.child === p.child && n.account === p.account),
  )
}

/** Re-anchors every config in `next` against its predecessor in `prev`,
 *  each on the edit day in its own timezone. Pure (`nowSec` is unix
 *  SECONDS). */
export function reanchorConfigs<C extends SchedulableConfig>(prev: readonly C[], next: readonly C[], nowSec: number): C[] {
  const used = new Set<number>()
  // First pass claims exact matches so an account-switch pairing can never
  // steal a config that is still present unchanged.
  const exactIdx = next.map((cfg) => {
    const i = prev.findIndex((p, j) => !used.has(j) && p.child === cfg.child && p.account === cfg.account)
    if (i !== -1) used.add(i)
    return i
  })
  return next.map((cfg, k) => {
    let i = exactIdx[k]!
    if (i === -1) {
      i = switchedFrom(prev, next, cfg, used)
      if (i !== -1) used.add(i)
    }
    const before = i === -1 ? undefined : prev[i]
    let today: string
    try {
      today = dayKey(nowSec, cfg.tz)
    } catch {
      return cfg // an unusable tz: dueDays would reject this config anyway
    }
    return reanchorConfig(before, cfg, today)
  })
}
