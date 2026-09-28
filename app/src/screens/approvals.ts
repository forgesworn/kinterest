// Pure logic behind the Approvals inbox screen. See
// internal plan 2026-08-11-parent-mode, Task 5, and the charter
// reference this UX is lifted from (apps/charter-app/src/screens/Approvals.tsx).
// The actual request REGISTRY (upsert/decide, dedupe-by-reqId,
// dismissed/denied-are-statuses) lives in state/state.ts alongside
// addEntry/applyConfigDoc — this module is deliberately the screen-shaped
// half only: how the Approvals screen groups what it reads out of
// AppState.requests, and the stepper's own clamp rule.

import { periodComplete } from '../domain/chores'
import { CURRENCIES } from '../domain/money'
import { periodDaysFor } from '../domain/period'
import type { AppState, StoredRequest } from '../state/types'

// ============================================================================
// isKnownCurrency — U6 (UI audit): a spend.request's `currency` is only
// checked by the wire parser for `isNonEmptyString` (wire/payloads.ts), never
// against the app's own currency table, so a modified/buggy child client can
// send anything. `Money`/`formatMinor` both resolve a currency code via
// `domain/money.ts#currencyOrThrow`, which THROWS for anything unrecognised —
// rendering that straight into the Approvals inbox crashed the whole screen
// to the app-level ErrorBoundary with no way to dismiss the request that
// caused it. This lets a screen check first and degrade instead of crash.
// ============================================================================

/** True when `code` is one of the app's own recognised currencies.
 *  `hasOwnProperty`, not a bare index — same prototype-pollution guard as
 *  `domain/money.ts#currencyOrThrow` itself (a code of 'toString' or
 *  'constructor' must not resolve to an inherited member). Pure. */
export function isKnownCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code)
}

// ============================================================================
// clampGrant — Task 5's "stepper to grant less than asked"
// ============================================================================

/** Clamps a spend.request grant to `0..askedMinor`, 0 meaning deny.
 *  `askedMinor` is itself floored at 0 FIRST: `params.amountMinor` on a
 *  REQUEST is only checked by the wire parser for `isSafeInt`
 *  (wire/payloads.ts), never for non-negativity, so a malformed or hostile
 *  request naming a negative "asked" amount must not let this function's
 *  own upper bound go negative and slip a positive `inputMinor` through as
 *  a grantable amount. Flooring the ceiling at 0 forces every negative-asked
 *  request onto the SAME "clamp lands on exactly 0 -> deny" path as any
 *  other 0-clamp, rather than reaching `debitEntry`'s `assertPositiveMinor`
 *  as an unhandled throw — the carried defect this closes (SDD ledger,
 *  Task 3 -> Task 5 MUST-CARRY). */
export function clampGrant(askedMinor: number, inputMinor: number): number {
  const ceiling = Math.max(askedMinor, 0)
  return Math.min(Math.max(inputMinor, 0), ceiling)
}

// ============================================================================
// truncateLink — a child's pasted spend.request `link` is rendered on the
// guardian's request card as PLAIN TEXT, never a clickable anchor (a
// hostile-URL surface a child could paste anything into) — see
// Approvals.tsx's own RequestCard. Kept ~60 chars long so an unusually long
// paste can't blow out the card's layout.
// ============================================================================

const LINK_MAX_CHARS = 60

export function truncateLink(link: string): string {
  if (link.length <= LINK_MAX_CHARS) return link
  return link.slice(0, LINK_MAX_CHARS) + '…'
}

// ============================================================================
// Grouping — "grouped by child"
// ============================================================================

export interface ApprovalGroup {
  childPubkey: string
  /** Pending requests for this child only, newest first. */
  requests: StoredRequest[]
}

/** Filters to 'pending' only (an approved/denied/dismissed request has
 *  already been answered — it has no further business in the inbox, but
 *  stays in `AppState.requests` as a status, never a deletion), then groups
 *  by `request.child`, each group newest-request-first; groups themselves
 *  ordered by their own most recent request — mirrors the charter
 *  reference's own grouping precisely. */
export function pendingByChild(requests: StoredRequest[]): ApprovalGroup[] {
  const pending = [...requests].filter((r) => r.status === 'pending').sort((a, b) => b.createdAt - a.createdAt)

  const order: string[] = []
  const byChild = new Map<string, StoredRequest[]>()
  for (const r of pending) {
    const child = r.request.child
    if (!byChild.has(child)) {
      byChild.set(child, [])
      order.push(child)
    }
    byChild.get(child)!.push(r)
  }

  return order.map((childPubkey) => ({ childPubkey, requests: byChild.get(childPubkey)! }))
}

// ============================================================================
// claimPeriodComplete — v0.2 spec §4.2. A gated allowance.claim reaches the
// guardian precisely BECAUSE the scheduler would not pay it automatically
// (scheduler.ts's choresGate/auditGate branch), so the one thing the parent
// actually needs on that card is the answer to "has the child done the jobs?"
// — which, before this, the card did not show at all.
// ============================================================================

/** `null` — show no completeness line at all — whenever the answer would not
 *  be meaningful:
 *
 *   - the request is not an `allowance.claim`;
 *   - the child has no CHORES-GATED allowance config whose cadence the claimed
 *     periodKey's shape can belong to (an unknown child, an unparseable key, a
 *     `'YYYY-Www'` key against a monthly schedule, or a claim gated only by
 *     `auditGate` — a coin count is not a job, and "Some jobs still to do"
 *     would be about the wrong thing entirely);
 *   - the child has no non-archived chores at all. `domain/chores.ts#
 *     periodComplete` answers `false` there, which is right for a GATE
 *     (nothing done means nothing released) but a lie on a CARD: it would read
 *     "Some jobs still to do" to a parent who has set no jobs.
 *
 *  Otherwise `periodComplete` over that child's non-archived chores and their
 *  ticks for the claim's period. Pure. */
export function claimPeriodComplete(app: AppState, stored: StoredRequest): boolean | null {
  const { request } = stored
  if (request.op !== 'allowance.claim') return null
  const periodKey = (request.params as { periodKey?: unknown }).periodKey
  if (typeof periodKey !== 'string' || periodKey === '') return null

  // Mirrors store.tsx#buildGrantDecision's own config lookup (by child), but
  // additionally requires the cadence to be one the claimed key's SHAPE can
  // belong to — a 'YYYY-Www' key means nothing under a monthly schedule.
  let periodDays: string[] | null = null
  let tz: string | undefined
  for (const cfg of app.docs.allowance.configs) {
    if (cfg.child !== request.child || cfg.choresGate !== true) continue
    const days = periodDaysFor(periodKey, cfg.cadence)
    if (days !== null) {
      periodDays = days
      tz = cfg.tz
      break
    }
  }
  if (periodDays === null) return null

  // `periodComplete` filters archived chores itself; this filter is here so
  // "are there any jobs at all?" asks the same question the answer will.
  const chores = app.docs.chores.chores.filter((c) => c.child === request.child && c.archived !== true)
  if (chores.length === 0) return null
  const choreIds = new Set(chores.map((c) => c.id))
  const ticks = app.ticks.filter((t) => choreIds.has(t.chore))
  return periodComplete(chores, ticks, periodDays, tz)
}
