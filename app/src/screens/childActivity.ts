// Pure "what has this child actually been doing" transform behind the
// ChildActivity section of screens/ChildDetail.tsx (v0.2 spec §4.1).
//
// Deliberately separate from screens/feed.ts: that feed is the MONEY view
// (entries and their legs), and a chore tick or a coin count moves no money
// at all — a tick is a claim on a chore, an audit is a reconciliation whose
// only ledger trace is the adjustment entry it may have produced. Before
// this module the guardian had nowhere to see either, which is what made
// screens/Audit.tsx's "Sent to your parent." a half-truth.
//
// Matching rules (spec §4.1):
//  - a ChoreTick carries no child of its own, so it is matched through its
//    chore's `child`; a tick whose chore is unknown is dropped;
//  - an AuditResult carries `audit.child` and is matched on that directly.

import type { AppState } from '../state/types'

export type ActivityRow =
  | { kind: 'tick'; at: number; id: string; choreName: string; day: string }
  | {
      kind: 'audit'
      at: number
      id: string
      accountName: string
      countedMinor: number
      expectedMinor: number
      deltaMinor: number
      currency: string
    }

/** Default row cap — a guardian glancing at a child's page wants the recent
 *  past, not the whole corpus (ticks arrive daily and are unbounded). */
export const DEFAULT_ACTIVITY_LIMIT = 50

/**
 * Newest first by `at` (unix SECONDS), `id` ascending as a stable tiebreak —
 * ticks minted on the same day share a timestamp, so without the tiebreak two
 * devices given the same corpus would render it in different orders.
 *
 * Pure: the input arrays are copied before sorting, never sorted in place.
 */
export function childActivityRows(
  app: AppState,
  childPubkey: string,
  limit: number = DEFAULT_ACTIVITY_LIMIT,
): ActivityRow[] {
  const chores = new Map(app.docs.chores.chores.map((c) => [c.id, c]))
  // Archived accounts included on purpose: an audit of a pot the family has
  // since retired is still a real thing that happened, and its name and
  // currency are still the right ones to show it under.
  const accounts = new Map(app.docs.accounts.accounts.map((a) => [a.id, a]))

  const rows: ActivityRow[] = []

  for (const tick of app.ticks) {
    const chore = chores.get(tick.chore)
    if (chore === undefined || chore.child !== childPubkey) continue
    rows.push({ kind: 'tick', at: tick.at, id: tick.id, choreName: chore.name, day: tick.day })
  }

  for (const audit of app.audits) {
    if (audit.child !== childPubkey) continue
    const account = accounts.get(audit.account)
    // An audit whose account has vanished from the doc entirely has neither a
    // name nor a currency to render, so there is no honest row to show.
    if (account === undefined) continue
    rows.push({
      kind: 'audit',
      at: audit.at,
      id: audit.id,
      accountName: account.name,
      countedMinor: audit.countedMinor,
      expectedMinor: audit.expectedMinor,
      deltaMinor: audit.deltaMinor,
      currency: account.currency,
    })
  }

  rows.sort((a, b) => (a.at !== b.at ? b.at - a.at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows.slice(0, Math.max(0, limit))
}

/** The guardian-facing outcome copy for one audit row (spec §4.1). `money` is
 *  the already-formatted absolute difference — the caller renders it, because
 *  formatting is a component's job and this module stays pure of it. */
export function auditOutcome(deltaMinor: number): 'matched' | 'over' | 'short' {
  if (deltaMinor === 0) return 'matched'
  return deltaMinor > 0 ? 'over' : 'short'
}
