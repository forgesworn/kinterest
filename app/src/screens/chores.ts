// Pure logic behind the child's Chores screen: today's dailies + the weekly
// list, a "N of M days to pocket money" gate-progress readout, and the
// decision to auto-raise an allowance.claim once a chores-gated period is
// actually complete. See internal plan 2026-08-11-child-mode,
// Task 4.
//
// `periodDaysEndingAt` is the one thing every other function here is built
// on: the DENSE list of calendar days a chores-gated allowance PERIOD
// actually spans, for one specific due day. `domain/allowance.ts#periodKeyOf`
// only tells you WHICH calendar week/month a due day belongs to (a dedupe
// token, e.g. '2026-W33'); it doesn't hand back the day-by-day range
// `domain/chores.ts#periodComplete` needs to check every daily chore against.
// Derived from `domain/period.ts#dueDays`, run over `cfg`'s own cadence from
// `cfg.startDay` through `dueDay`: the SECOND-TO-LAST element of that
// (sparse — e.g. every Friday) list is the PREVIOUS due day, i.e. the
// period's own start boundary (or `cfg.startDay` itself, for the very first
// period this config has ever had); the dense day-by-day range from the day
// after that boundary through `dueDay` inclusive is the period.

import { addDays, dueDays } from '../domain/period'
import { periodComplete, tickedDays, type Chore, type ChoreTick } from '../domain/chores'
import { allowanceDue, periodKeyOf, type AllowanceConfig } from '../domain/allowance'
import type { Entry } from '../domain/types'
import type { AppState, StoredRequest } from '../state/types'
import { upsertRequest } from '../state/state'
import { buildRequestPayload, type RequestPayload } from '../wire/payloads'
import { nextDueDay } from './Home'
import { childOwnRequests, freshNonce, freshReqId } from './ask'

type CadenceCfg = Pick<AllowanceConfig, 'cadence' | 'day' | 'startDay'>

/** The due day strictly BEFORE `dueDay` under `cfg`'s own cadence — or
 *  `cfg.startDay` itself when `dueDay` is the very first occurrence this
 *  config has ever had (nothing earlier to bound the period against). */
export function previousPeriodBoundary(cfg: CadenceCfg, dueDay: string): string {
  const occurrences = dueDays({ cadence: cfg.cadence, day: cfg.day, fromExclusive: cfg.startDay, toInclusive: dueDay })
  return occurrences.length >= 2 ? occurrences[occurrences.length - 2]! : cfg.startDay
}

/** See this module's header — the dense day-by-day range one chores-gated
 *  allowance period actually spans, ending at (and including) `dueDay`. */
export function periodDaysEndingAt(cfg: CadenceCfg, dueDay: string): string[] {
  const days: string[] = []
  let cursor = addDays(previousPeriodBoundary(cfg, dueDay), 1)
  while (cursor <= dueDay) {
    days.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return days
}

// ============================================================================
// choreTickId — deterministic per (chore, day), so a SECOND tap on a day
// already ticked is a genuine no-op (state/state.ts#recordTick's own
// dedupe-by-id) rather than a duplicate tick/duplicate wire send — "tick =
// ... idempotent per day" per the plan.
// ============================================================================

export function choreTickId(choreId: string, day: string): string {
  return `tick:${choreId}:${day}`
}

// ============================================================================
// Gate progress — "3 of 5 days to pocket money".
// ============================================================================

// Review fix (Task 4 follow-up): the ORIGINAL version of this readout always
// counted elapsed days as "done" via `dailies.every(...)`, which is
// VACUOUSLY true over an empty list — a family with only weekly chores
// configured (no dailies at all) saw a full "7 of 7 days" bar with ZERO
// ticks, while the real gate (`choreGateReadyClaims`, via `periodComplete`)
// correctly stayed unmet. `complete` below is now derived from
// `periodComplete` itself — the SAME single source of truth
// `choreGateReadyClaims` uses — so the readout can never claim "complete"
// when the real gate disagrees, in either shape:
//   - 'days': at least one active DAILY chore exists — the familiar "N of M
//     days" count, unchanged for a mixed/daily-only list. `doneDays` alone is
//     still just an approximate progress bar (it doesn't know about any
//     WEEKLY chore also required); `complete` is what actually gates whether
//     the bar may ever read "done".
//   - 'chores': daily-only would be vacuous (see above) — for a weekly-only
//     (or otherwise dailies-free) active chore list, this counts weekly
//     chores with at least one tick somewhere in the current period instead,
//     e.g. "1 of 2 chores this week".
export type ChoreGateProgress =
  | { kind: 'days'; dueDay: string; doneDays: number; totalDays: number; complete: boolean }
  | { kind: 'chores'; dueDay: string; doneCount: number; totalCount: number; complete: boolean }

/** `null` when there's nothing to show progress towards at all: no allowance
 *  config for this child, a paused one (same "nothing to show" reasoning as
 *  Home.tsx's own `nextDates`, which checks `!paused` before ever calling
 *  `nextDueDay`), or no active chores configured yet. */
export function choreGateProgress(
  cfg: Pick<AllowanceConfig, 'cadence' | 'day' | 'startDay' | 'tz' | 'paused'>,
  chores: Chore[],
  ticks: ChoreTick[],
  todayDayKey: string,
  nowSec: number,
): ChoreGateProgress | null {
  if (cfg.paused) return null
  const dueDay = nextDueDay(cfg, nowSec)
  if (dueDay === null) return null
  const active = chores.filter((c) => !c.archived)
  if (active.length === 0) return null

  const periodDays = periodDaysEndingAt(cfg, dueDay)
  // Ground truth — the exact same check choreGateReadyClaims uses to decide
  // whether to actually raise the claim; neither branch below computes its
  // own notion of "complete".
  const complete = periodComplete(chores, ticks, periodDays)

  const dailies = active.filter((c) => c.cadence === 'daily')
  if (dailies.length > 0) {
    const elapsed = periodDays.filter((d) => d <= todayDayKey)
    const doneDays = elapsed.filter((d) => dailies.every((c) => tickedDays(c, ticks).has(d))).length
    return { kind: 'days', dueDay, doneDays, totalDays: periodDays.length, complete }
  }

  const weeklies = active.filter((c) => c.cadence === 'weekly')
  const periodDaySet = new Set(periodDays)
  const doneCount = weeklies.filter((c) => [...tickedDays(c, ticks)].some((d) => periodDaySet.has(d))).length
  return { kind: 'chores', dueDay, doneCount, totalCount: weeklies.length, complete }
}

/** The gate-progress bar's own fill percentage — a presentation helper kept
 *  here (rather than inline in Chores.tsx) so the review's "the bar must
 *  never read complete when periodComplete is false" rule has a single,
 *  tested home. Capped at 95% whenever `complete` is false, however close
 *  the raw ratio gets to 1 (e.g. every daily day ticked but a weekly chore
 *  in the SAME period still outstanding — `periodComplete` requires every
 *  active chore, not just the dailies this ratio counts) — only an ACTUAL
 *  `complete: true` ever shows a full bar. */
export function progressFillPercent(progress: ChoreGateProgress): number {
  if (progress.complete) return 100
  const ratio = progress.kind === 'days' ? progress.doneDays / Math.max(1, progress.totalDays) : progress.doneCount / Math.max(1, progress.totalCount)
  return Math.min(95, Math.max(0, Math.round(ratio * 100)))
}

// ============================================================================
// Auto-raise — "when choresGate on and period complete -> auto-raise
// allowance.claim ONCE per period".
// ============================================================================

export interface ChoreGateClaim {
  dueDay: string
  periodKey: string
}

/** True once `existingRequests` (this device's OWN `state.requests` — the
 *  same registry Ask.tsx renders, per ask.ts#childOwnRequests) already
 *  carries an allowance.claim for `periodKey`, regardless of its status —
 *  'pending' (already sent, awaiting the guardian) or already
 *  'approved'/'denied': either way, a SECOND claim for the same period must
 *  never be raised. Unlike a spend.request (deduped by reqId alone — every
 *  tap is its own distinct ask), the gate's own idempotence has to be about
 *  the PERIOD specifically, since `buildGateClaim` below mints a fresh
 *  reqId every time it's called — periodKey is the only thing stable across
 *  repeated calls (this screen re-rendering/re-running its effect after
 *  every tick). */
function alreadyClaimed(existingRequests: StoredRequest[], periodKey: string): boolean {
  return existingRequests.some(
    (r) => r.request.op === 'allowance.claim' && (r.request.params as { periodKey?: unknown }).periodKey === periodKey,
  )
}

/** Pure decision: which chores-gated, currently-due periods — per
 *  `domain/allowance.ts#allowanceDue`, the SAME "due but not yet paid" scan
 *  the guardian's own scheduler (store/scheduler.ts) runs — are BOTH
 *  complete (`domain/chores.ts#periodComplete`, over `periodDaysEndingAt`'s
 *  dense day range) and not already claimed. `cfg.choresGate` must be set —
 *  an ungated config has nothing for this screen to auto-raise (the
 *  guardian's own scheduler pays it directly, no claim ever surfaces here).
 *
 *  Returns one entry per ready period (in principle more than one, for a
 *  device that's been offline across several due periods); the caller
 *  (Chores.tsx) builds+sends a `RequestPayload` via `buildGateClaim` below
 *  for each. */
export function choreGateReadyClaims(
  cfg: AllowanceConfig,
  chores: Chore[],
  ticks: ChoreTick[],
  entries: Entry[],
  existingRequests: StoredRequest[],
  nowSec: number,
): ChoreGateClaim[] {
  if (!cfg.choresGate) return []
  const due = allowanceDue(cfg, entries, nowSec)
  const out: ChoreGateClaim[] = []
  for (const dueDay of due) {
    const periodKey = periodKeyOf(cfg, dueDay)
    if (alreadyClaimed(existingRequests, periodKey)) continue
    if (periodComplete(chores, ticks, periodDaysEndingAt(cfg, dueDay))) out.push({ dueDay, periodKey })
  }
  return out
}

/** Builds the actual `allowance.claim` REQUEST for one `ChoreGateClaim` —
 *  the same op/shape a child's own MANUAL claim would carry (there is no
 *  separate wire concept for "the gate raised this automatically"; the
 *  guardian's `store.tsx#buildGrantDecision` answers it identically either
 *  way). Fresh reqId/nonce via `ask.ts`'s own helpers (the other place a
 *  device mints a brand-new REQUEST from scratch) — `claim.periodKey` is
 *  computed the exact same way the guardian validates it
 *  (`domain/allowance.ts#periodKeyOf`, already applied by
 *  `choreGateReadyClaims` above), so this claim can never name a period
 *  outside what `buildGrantDecision`'s own `legitimatePeriodKeys` check
 *  would accept. */
export function buildGateClaim(child: string, claim: ChoreGateClaim, nowSec: number): RequestPayload {
  return buildRequestPayload({
    op: 'allowance.claim',
    reqId: freshReqId(nowSec),
    nonce: freshNonce(),
    child,
    ts: nowSec,
    params: { periodKey: claim.periodKey },
  })
}

/** The whole child-side auto-raise, as one pure `AppState -> AppState` step
 *  (store.tsx runs it inside a dispatched updater, so it always sees the
 *  CURRENT app, never a stale snapshot). Finds this device's own
 *  chores-gated config, asks `choreGateReadyClaims` which periods are ready,
 *  builds one claim per period and folds each into `app.requests`.
 *
 *  Idempotent: `choreGateReadyClaims` skips any period that already has an
 *  `allowance.claim` on record (by periodKey), and `upsertRequest` refuses a
 *  reqId it already holds — so running this twice over its own output
 *  raises nothing new and hands back the SAME `app` reference. Returns the
 *  payloads it raised so the caller can send them. */
export function raiseChoreGateClaims(app: AppState, nowSec: number): { app: AppState; raised: RequestPayload[] } {
  const selfPk = app.self.pubkey
  if (app.role !== 'child' || selfPk === null) return { app, raised: [] }
  const cfg = app.docs.allowance.configs.find((c) => c.child === selfPk)
  if (cfg === undefined) return { app, raised: [] }
  const chores = app.docs.chores.chores.filter((c) => c.child === selfPk && !c.archived)
  const ready = choreGateReadyClaims(cfg, chores, app.ticks, app.entries, childOwnRequests(app), nowSec)
  let next = app
  const raised: RequestPayload[] = []
  for (const claim of ready) {
    const payload = buildGateClaim(selfPk, claim, nowSec)
    const after = upsertRequest(next, payload, selfPk, nowSec)
    if (after !== next) raised.push(payload)
    next = after
  }
  return { app: next, raised }
}
