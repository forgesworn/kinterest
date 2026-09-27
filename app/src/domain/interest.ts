import { assertMinor, assertPositiveMinor } from './money'
import { addDays, dayKey, dueDays, isoWeekKey, monthKeyOf, periodDaysFor } from './period'
import { scheduledDueDay, type EntryMeta } from './ledger'
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

// The deposit match (v1 §Interest: "every £1 you deposit, I add 50p",
// capped per period). `matchMinor` is the arithmetic; the scheduler posts
// the result as its own `credit` entry, category `match` (matchEntry below),
// so it shows on the ledger distinctly from the interest payment itself.
// Rounded half-up like interest (§Interest's rounding rule), but with no
// 1-minor-unit minimum: that minimum is specific to the interest payout.
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
    assertMinor(balance) // audit D12: the running balance, not just each input
    balance += interestMinor(balance, rateBps)
    assertMinor(balance)
    out.push(balance)
  }
  return out
}

/**
 * The balance after `periods` interest payments, compounding, with no
 * further deposits (v1 §Interest: "leave it 4 more weeks and it's £X").
 * Integer maths throughout — each period's interest is `interestMinor`
 * (half-up, minimum 1 minor unit on a positive balance), exactly what the
 * scheduler would pay. `periods = 0` returns the balance unchanged. Throws
 * RangeError on a bad `periods` or on overflow.
 */
export function projectBalance(balanceMinor: number, rateBps: number, periods: number): number {
  const path = project(balanceMinor, rateBps, periods)
  const out = path.length === 0 ? balanceMinor : path[path.length - 1]!
  assertMinor(out)
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
// due-day order and interleave allowance, match and interest correctly.
/** The day an entry counts from for as-of-due-day balances, in `tz`. */
export function effectiveDay(e: Entry, tz: string): string {
  return scheduledDueDay(e) ?? dayKey(e.createdAt, tz)
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

// ---------------------------------------------------------------------------
// Deposit match (audit S1)
// ---------------------------------------------------------------------------

export const MATCH_CATEGORY = 'match'

// Credits that are NOT the child adding money: scheduled pocket money,
// interest, a previous match, and a spend coming back (a refund).
const NON_DEPOSIT_CATEGORIES: ReadonlySet<string> = new Set(['allowance', 'interest', MATCH_CATEGORY, 'spend'])

/**
 * What counts as a "deposit" for the match — the conservative reading of
 * v1 §Interest: money the child adds to, or is given into, the matched
 * account. That is a `credit` leg on `accountId` (a gift, birthday money, a
 * guardian's "Add money"), excluding:
 *   - pocket money, interest, an earlier match and spend refunds (by
 *     category — NON_DEPOSIT_CATEGORIES);
 *   - transfers and exchanges between the child's own accounts (moving
 *     money between pots adds nothing new; matching it would pay for
 *     shuttling money back and forth);
 *   - audit adjustments, debits, reversal entries, and any credit that has
 *     itself been reversed (`reversedIds`).
 * Returns the positive amount deposited on `accountId`, or 0.
 */
export function depositMinor(e: Entry, accountId: string, reversedIds: ReadonlySet<string>): number {
  if (e.kind !== 'credit' || e.reverses !== undefined || reversedIds.has(e.id)) return 0
  if (e.category !== undefined && NON_DEPOSIT_CATEGORIES.has(e.category)) return 0
  let sum = 0
  for (const l of e.legs) if (l.account === accountId && l.amountMinor > 0) sum += l.amountMinor
  return sum
}

/** The exclusive lower bound of the deposit window a match on `dueDay`
 *  covers: the schedule's previous due day, or `cfg.startDay` if that is
 *  later (a deposit made before the schedule — or before a re-anchoring
 *  edit — is never matched). Every deposit therefore falls into exactly one
 *  window: the one of the first due day on or after it. */
export function matchWindowStart(cfg: Pick<InterestConfig, 'cadence' | 'day' | 'startDay'>, dueDay: string): string {
  const earlier = dueDays({ cadence: cfg.cadence, day: cfg.day, fromExclusive: addDays(dueDay, -32), toInclusive: addDays(dueDay, -1) })
  const prev = earlier[earlier.length - 1] ?? addDays(dueDay, -32)
  return prev >= cfg.startDay ? prev : cfg.startDay
}

/** Total deposits on `accountId` whose effective day (in `tz`) is in
 *  (`fromExclusive`, `toInclusive`]. Pure; integer sum, overflow-checked. */
export function depositsInWindow(
  entries: readonly Entry[],
  accountId: string,
  fromExclusive: string,
  toInclusive: string,
  tz: string,
): number {
  const reversedIds = new Set(entries.map((e) => e.reverses).filter((r): r is string => r !== undefined))
  let sum = 0
  for (const e of entries) {
    const amount = depositMinor(e, accountId, reversedIds)
    if (amount === 0) continue
    const day = effectiveDay(e, tz)
    if (day > fromExclusive && day <= toInclusive) sum += amount
  }
  assertMinor(sum)
  return sum
}

function isMatchPayout(e: Entry, accountId: string, reversedIds: ReadonlySet<string>): boolean {
  return (
    e.kind === 'credit' &&
    e.category === MATCH_CATEGORY &&
    e.periodKey !== undefined &&
    e.reverses === undefined &&
    !reversedIds.has(e.id) &&
    e.legs.some((l) => l.account === accountId)
  )
}

/**
 * The due days whose deposit match `cfg` still owes, oldest first (`nowSec`
 * is unix SECONDS). Empty when the match is off (`matchBps` unset or ≤ 0) or
 * the config is paused. Idempotent by periodKey, like `interestDue`.
 *
 * Bounded the same way as `interestDue` (review R1): a period is closed
 * once a later match has been paid, or once interest has been paid for a
 * LATER period (the scheduler pays a period's match and interest in the
 * same pass, so an interest payout proves the match for every earlier
 * period was already evaluated). A period whose match came to 0 mints no
 * entry and would otherwise stay open for ever.
 */
export function matchDue(cfg: InterestConfig, existing: Entry[], nowSec: number): string[] {
  if (cfg.paused) return []
  if (cfg.matchBps === undefined || !(cfg.matchBps > 0)) return []
  const today = dayKey(nowSec, cfg.tz)
  const reversedIds = new Set(existing.map((e) => e.reverses).filter((r): r is string => r !== undefined))
  const matches = existing.filter((e) => isMatchPayout(e, cfg.account, reversedIds))
  let fromExclusive = cfg.startDay
  for (const e of matches) {
    const days = periodDaysFor(e.periodKey as string, cfg.cadence)
    if (days === null || days.length === 0) continue
    const lastDay = days[days.length - 1]!
    if (lastDay > fromExclusive) fromExclusive = lastDay
  }
  for (const e of existing) {
    if (e.kind !== 'interest' || !e.periodKey || reversedIds.has(e.id) || !e.legs.some((l) => l.account === cfg.account)) continue
    const days = periodDaysFor(e.periodKey, cfg.cadence)
    if (days === null || days.length === 0) continue
    const beforeFirst = addDays(days[0]!, -1)
    if (beforeFirst > fromExclusive) fromExclusive = beforeFirst
  }
  const due = dueDays({ cadence: cfg.cadence, day: cfg.day, fromExclusive, toInclusive: today })
  const paid = new Set(matches.map((e) => e.periodKey as string))
  return due.filter((d) => !paid.has(periodKeyOf(cfg, d)))
}

/** The match credit for `dueDay`, or null when it comes to 0 (no deposits
 *  in the window, or the match is off). `depositedMinor` is the window's
 *  total from `depositsInWindow`. */
export function matchEntry(
  cfg: InterestConfig,
  account: Account,
  dueDay: string,
  depositedMinor: number,
  meta: EntryMeta,
): Entry | null {
  if (account.id !== cfg.account)
    throw new RangeError(`match is configured for account ${cfg.account}, got ${account.id}`)
  if (account.child !== meta.child)
    throw new RangeError(`account ${account.id} belongs to child ${account.child}, not ${meta.child}`)
  const amountMinor = matchMinor(depositedMinor, cfg.matchBps ?? 0, cfg.matchCapMinor)
  if (amountMinor === 0) return null
  assertPositiveMinor(amountMinor)
  return {
    v: 1,
    kind: 'credit',
    legs: [{ account: account.id, currency: account.currency, amountMinor }],
    category: MATCH_CATEGORY,
    periodKey: periodKeyOf(cfg, dueDay),
    ...meta,
    note: meta.note ?? `Deposit match — ${dueDay}`,
  }
}
