import { reopenedEntryIds } from './corrections'
import { dayKey, dueDays, isoWeekKey, monthKeyOf } from './period'
import { creditEntry, type EntryMeta } from './ledger'
import type { Account, Entry } from './types'

export interface AllowanceConfig {
  child: string
  account: string
  amountMinor: number
  cadence: 'weekly' | 'monthly'
  day: number // weekly: ISO weekday 1-7; monthly: day of month 1-31 (clamped to short months by dueDays)
  tz: string
  startDay: string
  paused?: boolean
  choresGate?: boolean
  auditGate?: boolean
}

// Exported — scheduler.ts and store.tsx both need the SAME mapping from a
// due day to its period key (idempotence-by-period and, for store.tsx,
// validating a claimed periodKey is even achievable under this config's
// schedule); this used to be duplicated verbatim in scheduler.ts (flagged
// as a drift risk by Task 3's review) — a single exported source now.
export function periodKeyOf(cfg: Pick<AllowanceConfig, 'cadence'>, dueDay: string): string {
  return cfg.cadence === 'weekly' ? isoWeekKey(dueDay) : monthKeyOf(dueDay)
}

export function allowanceDue(cfg: AllowanceConfig, existing: Entry[], nowSec: number): string[] {
  if (cfg.paused) return []
  const today = dayKey(nowSec, cfg.tz)
  const due = dueDays({
    cadence: cfg.cadence,
    day: cfg.day,
    fromExclusive: cfg.startDay,
    toInclusive: today,
  })
  const reversedIds = reopenedEntryIds(existing)
  const paid = new Set(
    existing
      .filter(
        (e) =>
          e.category === 'allowance' &&
          e.periodKey &&
          !reversedIds.has(e.id) &&
          e.legs.some((l) => l.account === cfg.account),
      )
      .map((e) => e.periodKey as string),
  )
  return due.filter((d) => !paid.has(periodKeyOf(cfg, d)))
}

/** The full set of periodKeys `cfg`'s cadence could ever legitimately have
 *  produced, from `cfg.startDay` (exclusive) through `nowSec`'s "today"
 *  (inclusive) — irrespective of whether that period has already been paid
 *  (`allowanceDue` above additionally filters by "not yet paid"; this
 *  answers a different question: "is this periodKey even ACHIEVABLE under
 *  this schedule at all"). store.tsx#buildGrantDecision uses this to reject
 *  a claimed periodKey that was never actually due — a hostile or malformed
 *  `allowance.claim` naming an arbitrary string (or a legitimate-LOOKING
 *  but far-future period) must never be payable just because it parses as a
 *  non-empty string (wire/payloads.ts's `isAllowanceClaimParams` only
 *  checks that).
 *
 *  Deliberately does NOT gate on `cfg.paused` the way `allowanceDue` does:
 *  a period that was genuinely due before the config was paused stays a
 *  legitimate thing to claim/approve after the fact — "paused" stops NEW
 *  auto-pay going forward, it doesn't retroactively un-earn an already-due
 *  period. (Whether to actually approve it is still the guardian's call,
 *  and `periodAlreadyPaid` in store.tsx separately guards against paying
 *  the same period twice.) */
export function legitimatePeriodKeys(cfg: AllowanceConfig, nowSec: number): Set<string> {
  const today = dayKey(nowSec, cfg.tz)
  const due = dueDays({ cadence: cfg.cadence, day: cfg.day, fromExclusive: cfg.startDay, toInclusive: today })
  return new Set(due.map((d) => periodKeyOf(cfg, d)))
}

export function allowanceEntry(cfg: AllowanceConfig, account: Account, dueDay: string, meta: EntryMeta): Entry {
  if (account.id !== cfg.account)
    throw new RangeError(`allowance is configured for account ${cfg.account}, got ${account.id}`)
  const entry = creditEntry({ ...meta, note: meta.note ?? `Pocket money — ${dueDay}` }, account, cfg.amountMinor, 'allowance')
  return { ...entry, periodKey: periodKeyOf(cfg, dueDay) }
}
