import { assertMinor, assertPositiveMinor } from './money'
import { dayKey, dueDays, isoWeekKey, monthKeyOf, periodDaysFor } from './period'
import type { EntryMeta } from './ledger'
import type { Account, Entry } from './types'

export interface InterestConfig {
  child: string
  account: string
  rateBps: number
  cadence: 'weekly' | 'monthly'
  day: number // weekly: ISO weekday 1-7; monthly: day of month 1-31 (clamped to short months by dueDays)
  tz: string
  startDay: string
  matchBps?: number
  matchCapMinor?: number
  paused?: boolean
}

function periodKeyOf(cfg: Pick<InterestConfig, 'cadence'>, dueDay: string): string {
  return cfg.cadence === 'weekly' ? isoWeekKey(dueDay) : monthKeyOf(dueDay)
}

export function interestMinor(balanceMinor: number, rateBps: number): number {
  assertMinor(balanceMinor)
  if (balanceMinor <= 0 || rateBps <= 0) return 0
  const raw = balanceMinor * rateBps
  if (!Number.isSafeInteger(raw)) throw new RangeError(`interest arithmetic overflow: ${balanceMinor} × ${rateBps}`)
  const rounded = Math.floor((raw + 5000) / 10000) // half-up in the child's favour
  return Math.max(rounded, 1)
}

// matchMinor is a helper only: the app layer computes the match and posts it
// as its own separate credit entry (so it shows on the ledger distinctly
// from the interest payment itself). It is not wired into interestEntry.
export function matchMinor(depositedMinor: number, matchBps: number, capMinor?: number): number {
  assertMinor(depositedMinor)
  if (capMinor !== undefined) {
    assertMinor(capMinor)
    if (capMinor < 0) throw new RangeError('match cap must not be negative')
  }
  if (depositedMinor <= 0 || matchBps <= 0) return 0
  const product = depositedMinor * matchBps
  if (!Number.isSafeInteger(product)) throw new RangeError(`match arithmetic overflow: ${depositedMinor} × ${matchBps}`)
  const raw = Math.floor((product + 5000) / 10000)
  return capMinor === undefined ? raw : Math.min(raw, capMinor)
}

export function project(
  balanceMinor: number,
  rateBps: number,
  periods: number,
  depositPerPeriodMinor = 0,
): number[] {
  assertMinor(balanceMinor)
  if (!Number.isSafeInteger(periods) || periods < 0)
    throw new RangeError(`periods must be a safe integer >= 0, got ${periods}`)
  assertMinor(depositPerPeriodMinor)
  const out: number[] = []
  let balance = balanceMinor
  for (let i = 0; i < periods; i++) {
    balance += depositPerPeriodMinor
    balance += interestMinor(balance, rateBps)
    out.push(balance)
  }
  return out
}

/**
 * The due days `cfg` still owes, oldest first (`nowSec` is unix SECONDS).
 *
 * The scan is bounded (review R1): it starts at the later of `startDay`
 * and the end of the period of the most recent (unreversed) interest
 * payout on `cfg.account` under `cfg`'s cadence. A period that paid 0
 * (a zero rate or a non-positive balance) mints no entry, so without this
 * watermark it would stay open for ever — re-folded on every tick, and
 * payable later at whatever terms applied then. Every period before the
 * latest payout is closed, paid or not.
 */
export function interestDue(cfg: InterestConfig, existing: Entry[], nowSec: number): string[] {
  if (cfg.paused) return []
  const today = dayKey(nowSec, cfg.tz)
  const reversedIds = new Set(existing.map((e) => e.reverses).filter((r): r is string => r !== undefined))
  const payouts = existing.filter(
    (e) =>
      e.kind === 'interest' &&
      e.periodKey &&
      !reversedIds.has(e.id) &&
      e.legs.some((l) => l.account === cfg.account),
  )
  let fromExclusive = cfg.startDay
  for (const e of payouts) {
    const days = periodDaysFor(e.periodKey as string, cfg.cadence)
    if (days === null || days.length === 0) continue
    const lastDay = days[days.length - 1]!
    if (lastDay > fromExclusive) fromExclusive = lastDay
  }
  const due = dueDays({ cadence: cfg.cadence, day: cfg.day, fromExclusive, toInclusive: today })
  const paid = new Set(payouts.map((e) => e.periodKey as string))
  return due.filter((d) => !paid.has(periodKeyOf(cfg, d)))
}

// Scheduler-created payouts carry a deterministic id ending in their own due
// day (store/scheduler.ts#schedulerEntryId: `sched:<kind>:<child>:<account>:
// <YYYY-MM-DD>`). Their `createdAt` is whenever the guardian's app happened
// to run the catch-up, so for "balance as of a due day" they count as of
// the due day they pay for — which is what makes catch-up compound in
// due-day order and interleave allowance and interest correctly.
const SCHEDULED_ID = /^sched:(?:allowance|interest):.+:(\d{4}-\d{2}-\d{2})$/

/** The day an entry counts from for as-of-due-day balances, in `tz`. */
export function effectiveDay(e: Entry, tz: string): string {
  if (e.author === 'guardian') {
    const m = SCHEDULED_ID.exec(e.id)
    if (m) return m[1]!
  }
  return dayKey(e.createdAt, tz)
}

/**
 * The balance of `accountId` as of the END of `day` in `tz` (audit D2):
 * the fold of every leg on that account from entries whose `effectiveDay`
 * is on or before `day`. A deposit made after a due day never counts
 * towards that period's interest, so re-evaluating an old zero-balance
 * period later still gives 0 — no back-interest.
 */
export function balanceAsOf(entries: Iterable<Entry>, accountId: string, day: string, tz: string): number {
  let sum = 0
  for (const e of entries) {
    if (!e.legs.some((l) => l.account === accountId)) continue
    if (effectiveDay(e, tz) > day) continue
    for (const l of e.legs) if (l.account === accountId) sum += l.amountMinor
  }
  assertMinor(sum)
  return sum
}

export function interestEntry(
  cfg: InterestConfig,
  account: Account,
  dueDay: string,
  balanceMinor: number,
  meta: EntryMeta,
): Entry | null {
  if (account.id !== cfg.account)
    throw new RangeError(`interest is configured for account ${cfg.account}, got ${account.id}`)
  if (account.child !== meta.child)
    throw new RangeError(`account ${account.id} belongs to child ${account.child}, not ${meta.child}`)
  const amountMinor = interestMinor(balanceMinor, cfg.rateBps)
  if (amountMinor === 0) return null
  assertPositiveMinor(amountMinor)
  return {
    v: 1,
    kind: 'interest',
    legs: [{ account: account.id, currency: account.currency, amountMinor }],
    category: 'interest',
    periodKey: periodKeyOf(cfg, dueDay),
    ...meta,
    note: meta.note ?? `Interest — ${dueDay}`,
  }
}
