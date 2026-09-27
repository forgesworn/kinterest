// Pure logic behind the child's Audit ceremony (screens/Audit.tsx): the
// per-denomination coin counter, the match/mismatch comparison against the
// ledger's own balance, and the "detective" screen's own "what happened
// since last time" entry selection. See
// internal plan 2026-08-11-child-mode, Task 5.
//
// Three groups, in the order the ceremony itself uses them:
//   - coin counting — `denominationRows`/`emptyCoinCounts`/`setCoinCount`/
//     `coinCountTotal`, all built directly on domain/audit.ts's own
//     `DENOMINATIONS` table and `countTotal` (never re-derived here — the
//     plan's "per-denomination counts -> running total via countTotal" is
//     literally this module handing the same shape countTotal already
//     expects back to it).
//   - `auditOutcome` — the one-word verdict (`'match' | 'mismatch'`) the
//     screen branches its whole second half on.
//   - the detective screen's own entry selection (`lastAuditFor`/
//     `entriesSinceLastAudit`) — "the period's entries" the plan calls for,
//     scoped to ONE account and to whatever's happened since that account's
//     own most recent prior audit (or the dawn of its history, if it has
//     never been audited before).
//
// This is the audit ceremony's ONLY pure module — Audit.tsx itself renders
// + performs the one live wire action (sending the finished AuditResult),
// same "thin screen over a pure sibling" shape as ./chores.ts/./ask.ts.

import { DENOMINATIONS, countTotal, type AuditResult, type Denomination } from '../domain/audit'
import { sortForDisplay } from '../domain/ledger'
import type { Entry } from '../domain/types'

// ============================================================================
// Coin counting
// ============================================================================

/** Denomination minor value -> how many of that coin/note the child has
 *  counted. Keyed by `minor` rather than `label`: every row in a given
 *  currency's `DENOMINATIONS` table has a distinct `minor` (label text is
 *  presentation only), and `minor` is what `countTotal` itself wants back. */
export type CoinCounts = Record<number, number>

/** `DENOMINATIONS[currency]`, or an empty list for a currency this app has
 *  no coin/note table for (BTC — see domain/audit.ts's own `DENOMINATIONS`,
 *  which deliberately has no BTC entry: there's no "coin" to physically
 *  count for a Bitcoin pot). Audit.tsx's own empty-state branch is what
 *  turns an empty list here into calm copy rather than a blank count
 *  screen. */
export function denominationRows(currency: string): Denomination[] {
  return DENOMINATIONS[currency] ?? []
}

/** A fresh count, zeroed across every denomination `currency` has — the
 *  count screen's own starting state. */
export function emptyCoinCounts(currency: string): CoinCounts {
  return Object.fromEntries(denominationRows(currency).map((d) => [d.minor, 0]))
}

/** Sets one denomination's quantity. A negative or non-integer `qty` is
 *  refused (same `counts` reference back) rather than silently clamped or
 *  NaN-propagated — the Stepper component this feeds already refuses to go
 *  below its own `min`, so this is a second, independent guard against a
 *  malformed caller, not the primary one. */
export function setCoinCount(counts: CoinCounts, minor: number, qty: number): CoinCounts {
  if (!Number.isSafeInteger(qty) || qty < 0) return counts
  return { ...counts, [minor]: qty }
}

/** The running total, in minor units, over every denomination currently
 *  counted — the count screen's own big serif number. Delegates entirely to
 *  domain/audit.ts's `countTotal`; an empty `counts` (nothing counted yet,
 *  or a currency with no denomination table at all) totals to 0 without
 *  ever calling it (countTotal's own `assertMinor`/positive-denomination
 *  checks have nothing to validate against an empty list, but there is
 *  nothing to compute either). */
export function coinCountTotal(counts: CoinCounts): number {
  const rows = Object.entries(counts).map(([minor, qty]) => ({ minor: Number(minor), qty }))
  if (rows.length === 0) return 0
  return countTotal(rows)
}

// ============================================================================
// Outcome
// ============================================================================

export type AuditOutcome = 'match' | 'mismatch'

/** The whole ceremony's verdict: does what the child counted equal what the
 *  ledger says this account should hold. Exact equality — a delta of even
 *  1p is a mismatch, same "integer money, no near-enough" spirit as every
 *  other ledger comparison in this app. */
export function auditOutcome(countedMinor: number, expectedMinor: number): AuditOutcome {
  return countedMinor === expectedMinor ? 'match' : 'mismatch'
}

// ============================================================================
// Detective screen — "what's happened to this pot since last time".
// ============================================================================

/** The most recently-recorded audit for `accountId` (by `at`, not
 *  insertion order — `state.audits` is append-only and never re-sorted), or
 *  `null` if this account has never been audited before. Mirrors
 *  store.tsx#buildGrantDecision's own "no separate index, just fold over
 *  the array" style — the audits list is small (one entry per ceremony ever
 *  run, across every account) and never hot-path code. */
export function lastAuditFor(audits: AuditResult[], accountId: string): AuditResult | null {
  let latest: AuditResult | null = null
  for (const audit of audits) {
    if (audit.account !== accountId) continue
    if (latest === null || audit.at > latest.at) latest = audit
  }
  return latest
}

/** Entries touching `accountId`, created strictly after that account's own
 *  last audit (`lastAuditFor` above) — or every entry touching it, if it has
 *  never been audited. Oldest-first (domain/ledger.ts#sortForDisplay's own
 *  convention) — the caller (Audit.tsx, via screens/childFeed.ts#buildChildFeed,
 *  which re-sorts for its own newest-day-first display) doesn't depend on
 *  this function's own ordering, but a deterministic one keeps this
 *  function's own tests simple.
 *
 *  `entries` need not be pre-filtered to `accountId` — legs naming any other
 *  account are simply not enough to include a row (mirrors
 *  ChildHome.tsx#jarHighWaterMinor's own "ids need not be pre-filtered"
 *  convention). Callers are still expected to have already scoped `entries`
 *  to the child's own (screens/ChildHome.tsx#childOwnEntries) — this
 *  function has no such privacy opinion of its own, same as buildChildFeed. */
export function entriesSinceLastAudit(entries: Entry[], audits: AuditResult[], accountId: string): Entry[] {
  const last = lastAuditFor(audits, accountId)
  const sinceSec = last?.at ?? 0
  return sortForDisplay(entries.filter((e) => e.createdAt > sinceSec && e.legs.some((l) => l.account === accountId)))
}
