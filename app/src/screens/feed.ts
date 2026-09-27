// Pure entries -> display-rows transform behind ChildDetail.tsx's unified
// feed. See internal plan 2026-08-11-parent-mode, Task 4:
// "unified feed (icons by category, ✓/○ acks)" plus "day grouping".
// Deliberately knows nothing about React or AppState — ChildDetail.tsx
// filters `state.entries`/`state.acks` down to one child before calling
// this, and renders whatever `buildFeed` returns.
//
// `lastExchangeRate` lives here rather than in domain/ or QuickActions.tsx
// because it is a second pure "look at prior entries" transform that BOTH
// Home.tsx's `approxTotal` and QuickActions.tsx's `suggestRate` need
// identically (the plan's "last-used rates", inferred from a child's own
// exchange history — there is no separate rates store). Screens under
// screens/ are this task's natural shared home for "pure logic more than
// one screen needs" (feed.ts is Task 4's one non-screen-specific module,
// per its file list) — duplicating this scan in two screens would risk
// them silently disagreeing about which prior exchange is "the" rate.

import { currencyOrThrow } from '../domain/money'
import { sortForDisplay } from '../domain/ledger'
import { dayKey } from '../domain/period'
import type { Account, Entry } from '../domain/types'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** 'YYYY-MM-DD' -> '11 August 2026'. Pure string arithmetic on the day key
 *  itself (no `Date` object involved beyond what `dayKey` already produced),
 *  so it carries no timezone of its own. Exported for screens/childFeed.ts
 *  (Plan 4, Task 3) — day-grouping labels ("Today"/"Yesterday"/a full date)
 *  are the same regardless of which feed's language is being shown. */
export function formatDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`
}

// ============================================================================
// Category/kind icon glyphs — plain text glyphs only (Global Constraints:
// "No shields, eyes, locks, or magnifying-glass iconography anywhere"; no
// emoji either, matching the kit's existing vocabulary — Stepper's −/+,
// Screen's ‹/›). Category (a free-form string on Entry) takes priority over
// kind where both apply (e.g. an 'interest' KIND entry always has category
// 'interest' too, so either lookup would agree there; a manual credit has no
// category, so it falls through to the kind glyph).
// ============================================================================

const CATEGORY_ICONS: Record<string, string> = {
  allowance: '↻',
  interest: '%',
  spend: '−',
}

const KIND_ICONS: Record<Entry['kind'], string> = {
  credit: '+',
  debit: '−',
  transfer: '⇄',
  exchange: '⇄',
  interest: '%',
  adjustment: '±',
}

/** hasOwnProperty-guarded the same way domain/money.ts's `currencyOrThrow`
 *  guards `CURRENCIES` lookups — `category` is a free-form string on
 *  `Entry`, so a literal 'toString'/'constructor' category (unlikely, but
 *  never impossible once entries can arrive over the wire) must not read a
 *  glyph off `Object.prototype` instead of falling through to the kind
 *  glyph. */
function categoryIcon(category: string): string | null {
  return Object.prototype.hasOwnProperty.call(CATEGORY_ICONS, category) ? CATEGORY_ICONS[category]! : null
}

export function feedIcon(entry: Pick<Entry, 'kind' | 'category'>): string {
  if (entry.category !== undefined) {
    const icon = categoryIcon(entry.category)
    if (icon !== null) return icon
  }
  return KIND_ICONS[entry.kind]
}

// ============================================================================
// Last-used exchange rate
// ============================================================================

/** The implied major-unit rate of one exchange entry's two legs: how many
 *  major units of `toCurrency` one major unit of `fromCurrency` bought. */
function impliedRate(fromCurrency: string, fromAmountMinor: number, toCurrency: string, toAmountMinor: number): number {
  const fromMajor = fromAmountMinor / 10 ** currencyOrThrow(fromCurrency).decimals
  const toMajor = toAmountMinor / 10 ** currencyOrThrow(toCurrency).decimals
  return toMajor / fromMajor
}

/** The rate implied by the MOST RECENT `exchange` entry (by `createdAt`) in
 *  `entries` that moved money between `fromCurrency` and `toCurrency`, in
 *  EITHER direction (a prior GBP→BTC exchange still suggests a rate for a
 *  new BTC→GBP one, inverted). `null` when no prior exchange between the two
 *  currencies exists yet — callers must never guess a rate out of thin air
 *  (see Home.tsx's `approxTotal`: a currency with no known rate is excluded
 *  from the total rather than assumed at some made-up figure). Same
 *  currency on both sides -> rate 1, trivially and without scanning anything
 *  (defensive; callers should never actually ask this for a no-op
 *  "exchange"). */
export function lastExchangeRate(entries: Entry[], fromCurrency: string, toCurrency: string): number | null {
  if (fromCurrency === toCurrency) return 1

  const exchanges = [...entries].filter((e) => e.kind === 'exchange').sort((a, b) => b.createdAt - a.createdAt)
  for (const e of exchanges) {
    const from = e.legs.find((l) => l.currency === fromCurrency && l.amountMinor < 0)
    const to = e.legs.find((l) => l.currency === toCurrency && l.amountMinor > 0)
    if (from !== undefined && to !== undefined) return impliedRate(fromCurrency, -from.amountMinor, toCurrency, to.amountMinor)

    const revFrom = e.legs.find((l) => l.currency === toCurrency && l.amountMinor < 0)
    const revTo = e.legs.find((l) => l.currency === fromCurrency && l.amountMinor > 0)
    if (revFrom !== undefined && revTo !== undefined) {
      const inverse = impliedRate(toCurrency, -revFrom.amountMinor, fromCurrency, revTo.amountMinor)
      if (inverse === 0) continue // degenerate/corrupt entry — keep scanning rather than divide by zero
      return 1 / inverse
    }
  }
  return null
}

// ============================================================================
// Feed rows
// ============================================================================

export interface FeedRow {
  id: string
  createdAt: number
  icon: string
  title: string
  /** Account context: the single account's name for a one-leg entry, or
   *  "From → To" account names for a transfer/exchange. */
  sub: string
  /** The entry's "headline" signed amount for display — the positive
   *  (incoming) leg for a two-leg transfer/exchange, or the entry's one leg
   *  otherwise. A two-leg entry's OTHER leg is not lost, just not this row's
   *  headline figure (see `sub`, which names both accounts involved). */
  amountMinor: number
  currency: string
  /** True once `state.acks` records this entry's id — the child's device
   *  has confirmed receipt (✓); false is "sent, not yet acked" (○), not
   *  "failed" (a failed send stays queued in the outbox, which this module
   *  has no visibility into — see store.tsx's `AppContextValue`). */
  acked: boolean
}

export interface FeedGroup {
  dayKey: string
  label: string
  rows: FeedRow[]
}

function accountName(accounts: Account[], id: string): string {
  return accounts.find((a) => a.id === id)?.name ?? 'Account'
}

const CATEGORY_TITLES: Record<string, string> = {
  allowance: 'Pocket money',
  interest: 'Interest',
  spend: 'Spend',
}

const KIND_TITLES: Record<Entry['kind'], string> = {
  credit: 'Money in',
  debit: 'Money out',
  transfer: 'Transfer',
  exchange: 'Exchange',
  interest: 'Interest',
  adjustment: 'Settled up',
}

/** A logged note (Add/Take money's optional note, an allowance/interest
 *  entry's auto-generated one) makes the best title when present — it is
 *  the most specific thing a human wrote or the scheduler generated for
 *  this exact entry. Falling back to category, then kind, mirrors
 *  `feedIcon`'s own precedence. */
function titleFor(entry: Entry): string {
  if (entry.note !== undefined && entry.note !== '') return entry.note
  if (entry.category !== undefined && Object.prototype.hasOwnProperty.call(CATEGORY_TITLES, entry.category)) {
    return CATEGORY_TITLES[entry.category]!
  }
  return KIND_TITLES[entry.kind]
}

function subFor(entry: Entry, accounts: Account[]): string {
  if (entry.legs.length === 2) {
    const from = entry.legs.find((l) => l.amountMinor < 0)
    const to = entry.legs.find((l) => l.amountMinor > 0)
    if (from !== undefined && to !== undefined) {
      return `${accountName(accounts, from.account)} → ${accountName(accounts, to.account)}`
    }
  }
  return accountName(accounts, entry.legs[0]!.account)
}

/** The leg this row headlines with: the positive (incoming) leg for a
 *  two-leg transfer/exchange, else the entry's single leg. Exported so
 *  screens/childFeed.ts (Plan 4, Task 3) can build its own child-language
 *  row shape from the SAME headline-leg choice, rather than re-deriving it —
 *  the two feeds must always agree on which leg/currency a row's amount
 *  reflects, even though their row TEXT differs completely. */
export function headlineLeg(entry: Entry): { amountMinor: number; currency: string } {
  const positive = entry.legs.find((l) => l.amountMinor > 0)
  const chosen = positive ?? entry.legs[0]!
  return { amountMinor: chosen.amountMinor, currency: chosen.currency }
}

function toFeedRow(entry: Entry, accounts: Account[], acks: Record<string, number>): FeedRow {
  const { amountMinor, currency } = headlineLeg(entry)
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    icon: feedIcon(entry),
    title: titleFor(entry),
    sub: subFor(entry, accounts),
    amountMinor,
    currency,
    acked: acks[entry.id] !== undefined,
  }
}

/** Groups `entries` into day buckets, newest day first and newest entry
 *  first within a day — a banking-app feed reads top-down as "most recent".
 *  `tz` decides day-boundary attribution (a 23:50 and a 00:10 entry are
 *  different days in most timezones); `nowSec` is used only to label which
 *  day key counts as "Today"/"Yesterday" — both supplied by the caller
 *  (Global Constraints: no `Date.now()` in pure logic). Entries the caller
 *  passes in should already belong to one child — this module has no
 *  child-filtering opinion of its own. */
export function buildFeed(
  entries: Entry[],
  accounts: Account[],
  acks: Record<string, number>,
  tz: string,
  nowSec: number,
): FeedGroup[] {
  const todayKey = dayKey(nowSec, tz)
  const yesterdayKey = dayKey(nowSec - 86400, tz)

  const order: string[] = []
  const rowsByDay = new Map<string, FeedRow[]>()
  for (const entry of [...sortForDisplay(entries)].reverse()) {
    const dk = dayKey(entry.createdAt, tz)
    if (!rowsByDay.has(dk)) {
      rowsByDay.set(dk, [])
      order.push(dk)
    }
    rowsByDay.get(dk)!.push(toFeedRow(entry, accounts, acks))
  }

  return order.map((dk) => ({
    dayKey: dk,
    label: dk === todayKey ? 'Today' : dk === yesterdayKey ? 'Yesterday' : formatDayLabel(dk),
    rows: rowsByDay.get(dk)!,
  }))
}
