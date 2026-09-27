// Pure entries -> child-language display-rows transform behind
// ChildHome.tsx's feed. See
// internal plan 2026-08-11-child-mode, Task 3, and this plan's
// Global Constraints: "warm, simple, second person... The child never sees
// raw pubkeys, bps, or period keys — only friendly forms".
//
// Deliberately a SEPARATE module from screens/feed.ts (the guardian's own
// unified feed), not a themed variant of it — feed.ts's `titleFor` shows an
// entry's own `note` verbatim whenever one is set (a guardian's free-text
// caption, or an auto-generated default like "Pocket money — 2026-08-07"),
// which is exactly right for the guardian's own ledger view but WRONG here:
// a raw ISO day key or a guardian's private phrasing is not "warm, second
// person" child copy. Every row's TITLE below is therefore always
// synthesised from the entry's kind/category — never `entry.note` verbatim —
// while a genuinely useful free-text note (e.g. an Ask flow's "what for"
// caption on a spend) still surfaces, as `sub`, alongside it.
//
// Reuses feed.ts's `feedIcon` (the glyph vocabulary is audience-independent),
// `headlineLeg` (which leg/currency a row's amount reflects must never
// disagree between the two feeds) and `formatDayLabel`/day-grouping
// convention (Today/Yesterday/a full date reads the same either way) —
// everything ELSE (the row text) is this module's own.

import { sortForDisplay } from '../domain/ledger'
import { dayKey } from '../domain/period'
import type { Account, Entry } from '../domain/types'
import { feedIcon, formatDayLabel, headlineLeg } from './feed'

export interface ChildFeedRow {
  id: string
  createdAt: number
  icon: string
  /** Warm, second-person, no raw pubkeys/bps/period keys — see this
   *  module's header. Never `entry.note` verbatim. */
  title: string
  /** Optional supporting context: a spend's own "what for" note when one was
   *  given, or the account name otherwise. `undefined` when neither adds
   *  anything a child needs (e.g. a single-account family with one obvious
   *  pot). */
  sub?: string
  amountMinor: number
  currency: string
}

export interface ChildFeedGroup {
  dayKey: string
  label: string
  rows: ChildFeedRow[]
}

// ============================================================================
// Title copy — one function per precedence tier, mirroring feed.ts's own
// category-then-kind fallback shape (categoryIcon/feedIcon), but every leaf
// here returns child-safe prose instead of a label.
// ============================================================================

/** `spend` is always phrased from the CHILD's own point of view ("You
 *  spent...") regardless of `entry.author` — a spend.request's resulting
 *  entry is authored by the approving guardian (store.tsx#buildGrantDecision
 *  signs it as `author: 'guardian'`), but the money leaving is always the
 *  CHILD's own spend, never the guardian's, so author is not the deciding
 *  signal for this one category the way it is for a manual credit/debit
 *  below. */
function spendTitle(entry: Entry): string {
  const { amountMinor } = headlineLeg(entry)
  return amountMinor < 0 ? 'You spent some money' : 'Some money came back to you'
}

function allowanceTitle(entry: Entry): string {
  return entry.author === 'child' ? 'Your pocket money arrived' : 'Your parent added your pocket money'
}

const CATEGORY_CHILD_TITLES: Record<string, (entry: Entry) => string> = {
  allowance: allowanceTitle,
  interest: () => 'Interest day!',
  spend: spendTitle,
}

/** hasOwnProperty-guarded the same way feed.ts's own `categoryIcon` guards
 *  `CATEGORY_ICONS` — `category` is a free-form string on `Entry`, so a
 *  literal 'toString'/'constructor' category must fall through to the kind
 *  title below, not read a function off `Object.prototype`. */
function categoryChildTitle(entry: Entry): string | null {
  const category = entry.category
  if (category === undefined) return null
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_CHILD_TITLES, category)) return null
  return CATEGORY_CHILD_TITLES[category]!(entry)
}

// TRACKING NOTE — currently unreachable, nothing wired through Task 3 ever
// produces one: domain/ledger.ts#reverseEntry keeps the ORIGINAL entry's
// `kind` but negates every leg's sign (a reversed 'credit' entry is a
// negative-amount 'credit', i.e. money actually leaving), so a reversal
// reaching this feed (e.g. a future audit-adjustment correction, Task 5)
// would have `kindChildTitle` say "added some money"/"took some money out"
// backwards for the `credit`/`debit` cases below — they trust `entry.kind`
// blindly rather than the headline leg's actual sign. `spendTitle` above
// already gets this right (it branches on `headlineLeg(entry).amountMinor <
// 0`, not on kind/category alone); when a reversal-producing flow lands,
// `credit`/`debit` here should adopt the same sign-check pattern instead of
// (or in addition to) the kind switch.
function kindChildTitle(entry: Entry): string {
  const byGuardian = entry.author === 'guardian'
  switch (entry.kind) {
    case 'credit':
      return byGuardian ? 'Your parent added some money' : 'You added some money'
    case 'debit':
      return byGuardian ? 'Your parent took some money out' : 'You took some money out'
    case 'transfer':
      return 'You moved money between your pots'
    case 'exchange':
      return 'You changed some money'
    case 'interest':
      return 'Interest day!'
    case 'adjustment':
      return 'Things got tidied up'
  }
}

/** Category wins over kind (mirrors feed.ts's own `titleFor` precedence),
 *  but — unlike feed.ts — `entry.note` is never consulted at all. See this
 *  module's header for why. */
function childTitleFor(entry: Entry): string {
  return categoryChildTitle(entry) ?? kindChildTitle(entry)
}

/** A note is worth showing as supporting context only for a `spend` (the
 *  Ask flow's own "what for" caption, e.g. "Lego set" — genuinely written
 *  BY or FOR the child, about a specific thing) — an allowance/interest
 *  entry's own note is an auto-generated default ("Pocket money —
 *  2026-08-07", carrying a raw day key) that this module's header already
 *  ruled out as title text, and is no more useful as a subtitle. Falls back
 *  to the account name otherwise, same as feed.ts's own `subFor`. */
function childSubFor(entry: Entry, accounts: Account[]): string | undefined {
  if (entry.category === 'spend' && entry.note !== undefined && entry.note !== '') return entry.note
  if (entry.legs.length === 2) {
    const from = entry.legs.find((l) => l.amountMinor < 0)
    const to = entry.legs.find((l) => l.amountMinor > 0)
    if (from !== undefined && to !== undefined) {
      return `${accountName(accounts, from.account)} → ${accountName(accounts, to.account)}`
    }
  }
  return accountName(accounts, entry.legs[0]!.account)
}

function accountName(accounts: Account[], id: string): string {
  return accounts.find((a) => a.id === id)?.name ?? 'your pot'
}

function toChildFeedRow(entry: Entry, accounts: Account[]): ChildFeedRow {
  const { amountMinor, currency } = headlineLeg(entry)
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    icon: feedIcon(entry),
    title: childTitleFor(entry),
    sub: childSubFor(entry, accounts),
    amountMinor,
    currency,
  }
}

/** Groups `entries` into day buckets, newest day first and newest entry
 *  first within a day — identical grouping/labelling convention to
 *  feed.ts's own `buildFeed` (see that function's own doc comment for the
 *  "no Date.now() in pure logic" reasoning behind the explicit `tz`/
 *  `nowSec` parameters). `entries` must already belong to ONE child — per
 *  the plan's "child sees ONLY their own data" rule, the CALLER (ChildHome)
 *  is responsible for filtering `state.entries` down to `state.self.pubkey`
 *  before ever reaching this module; this function has no such filtering
 *  opinion of its own, same as `buildFeed`. */
export function buildChildFeed(entries: Entry[], accounts: Account[], tz: string, nowSec: number): ChildFeedGroup[] {
  const todayKey = dayKey(nowSec, tz)
  const yesterdayKey = dayKey(nowSec - 86400, tz)

  const order: string[] = []
  const rowsByDay = new Map<string, ChildFeedRow[]>()
  for (const entry of [...sortForDisplay(entries)].reverse()) {
    const dk = dayKey(entry.createdAt, tz)
    if (!rowsByDay.has(dk)) {
      rowsByDay.set(dk, [])
      order.push(dk)
    }
    rowsByDay.get(dk)!.push(toChildFeedRow(entry, accounts))
  }

  return order.map((dk) => ({
    dayKey: dk,
    label: dk === todayKey ? 'Today' : dk === yesterdayKey ? 'Yesterday' : formatDayLabel(dk),
    rows: rowsByDay.get(dk)!,
  }))
}
