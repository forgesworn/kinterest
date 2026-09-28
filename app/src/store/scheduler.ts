import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
// The allowance/interest scheduler — see
// internal plan 2026-08-11-parent-mode, Task 2 ("the scheduler
// execution... executed by the guardian app when due; catch-up on launch",
// spec §Allowance/§Interest).
//
// Pure by design (Global Constraints: "No `Date.now()` in pure logic —
// screens obtain time once per action and pass it down"): `runSchedulers`
// takes the guardian's whole `AppState` plus a single `nowSec`, and returns
// what SHOULD be paid, never mutating anything or touching the wire itself.
// `store.tsx` is what actually applies the returned entries locally and
// sends them — this module only decides WHAT is due.
//
// Idempotence is entirely inherited from the domain layer: `allowanceDue`/
// `interestDue` (domain/allowance.ts, domain/interest.ts) key "already paid"
// by `periodKey`, not by due-day, so calling `runSchedulers` again against a
// state that already contains the entries this call just proposed returns
// an empty list for that config — see scheduler.test.ts's "second run is
// empty" case, which is exactly this: the caller (store.tsx) is expected to
// fold each returned entry into state (`addEntry`) before the next
// scheduler tick, at which point it's no longer "due".
//
// Gates (choresGate/auditGate on AllowanceConfig — domain/allowance.ts):
// when either is set, a due period is NOT auto-paid. Per the plan ("gates →
// no auto-entry, surfaces an expected `allowance.claim`"), the scheduler
// instead surfaces a `RequestPayload` of op `allowance.claim` for that
// period — the SAME wire shape a child would send to ask for that period's
// pay — so the guardian's approvals inbox (Plan 3 Task 5) can show "chores
// gate: allowance ready to release" without the scheduler silently paying
// past an explicit gate. This is a LOCAL, guardian-side construction (never
// actually sent over the wire — nothing signs or wraps it here): it only
// carries the shape the approvals inbox already knows how to render/act on.

import { allowanceDue, allowanceEntry, periodKeyOf, type AllowanceConfig } from '../domain/allowance'
import { balanceAsOf, depositsInWindow, interestDue, interestEntry, matchDue, matchEntry, matchWindowStart } from '../domain/interest'
import type { Account, Entry } from '../domain/types'
import type { RequestPayload } from '../wire/payloads'
import type { AppState } from '../state/types'

export interface SchedulerResult {
  /** Entries the caller should fold into state and send — never wraps or
   *  signs anything itself. */
  entries: Entry[]
  /** Gated allowance periods, surfaced as the same `RequestPayload` shape a
   *  child's own `allowance.claim` would carry — see module header. Never
   *  produced for interest (interest has no gate concept). */
  claims: RequestPayload[]
  matchEvaluations?: AppState['matchEvaluations']
}

function accountFor(state: AppState, id: string): Account | undefined {
  return state.docs.accounts.accounts.find((a) => a.id === id && !a.archived)
}

/** A locally-synthesised `allowance.claim` for a gated, due period — never
 *  sent over the wire (no reqId/nonce that round-trips anywhere); it exists
 *  purely so the approvals inbox has the same shape to render whether the
 *  claim came from a child or from the scheduler noticing a gate. */
/** The reqId a gated period's scheduler claim carries — shared by
 *  `gatedClaim` and the refused-period check below. */
function schedulerClaimId(cfg: AllowanceConfig, periodKey: string): string {
  return `scheduler:${cfg.child}:${cfg.account}:${periodKey}`
}

/** Periods the guardian explicitly refused: a scheduler claim
 *  for that (child, account, period) that was denied or dismissed. Such a
 *  period is never paid by the scheduler, even after the gate is switched
 *  off — belt-and-braces behind the re-anchor on the config save path. */
function refusedPeriods(state: AppState, cfg: AllowanceConfig): Set<string> {
  const out = new Set<string>()
  const prefix = `scheduler:${cfg.child}:${cfg.account}:`
  for (const r of state.requests) {
    if ((r.status === 'denied' || r.status === 'dismissed') && r.request.reqId.startsWith(prefix))
      out.add(r.request.reqId.slice(prefix.length))
  }
  return out
}

function gatedClaim(cfg: AllowanceConfig, dueDay: string, periodKey: string, nowSec: number): RequestPayload {
  return {
    v: 1,
    op: 'allowance.claim',
    reqId: schedulerClaimId(cfg, periodKey),
    nonce: `scheduler:${dueDay}`,
    child: cfg.child,
    ts: nowSec,
    params: { periodKey },
  }
}

// periodKeyOf is domain/allowance.ts's own exported helper — `allowanceDue`
// already applies it internally to decide what's paid, but doesn't hand the
// mapping back, so the gated-claim path below (which needs a periodKey to
// put in the claim's params, not just a due day) calls it directly rather
// than maintaining a second copy (this used to be a verbatim duplicate,
// flagged as a drift risk by Task 3's review).

/**
 * Computes every allowance/interest/deposit-match entry currently due across every child
 * and account, plus any gated allowance periods as claims. `entries` is
 * ready to fold via `state/state.ts#addEntry` and send as-is; `claims` are
 * informational only (see module header) — Task 2 does not itself persist
 * them into `AppState` (no `requests` field exists yet; that lands in Task
 * 5's approvals inbox).
 *
 * Idempotent by periodKey: entries this call proposes are NOT yet in
 * `state.entries` when it runs (the caller adds them afterwards), so a
 * second call against the SAME state returns the same result again — but a
 * second call against a state that already contains the first call's
 * entries returns an empty list for every config that was just paid. See
 * scheduler.test.ts.
 */
export function runSchedulers(state: AppState, nowSec: number): SchedulerResult {
  const entries: Entry[] = []
  const claims: RequestPayload[] = []
  const matchEvaluations = { ...state.matchEvaluations }
  const evaluatedAccounts = new Set<string>()
  const ledgerSignature = (entries: Entry[]) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(entries.map(e => e.id)))))
  const ledger = ledgerSignature(state.entries)

  // Each config's own body runs inside its own try/catch — deliberately
  // PER-CONFIG rather than one try/catch around the whole loop. Found by
  // review: a single poisoned config (a corrupt/hostile `rateBps` or
  // `amountMinor` large enough to overflow `domain/allowance.ts`'s or
  // `domain/interest.ts`'s own arithmetic — e.g. `interestMinor`'s
  // `balanceMinor * rateBps` exceeding `Number.MAX_SAFE_INTEGER`) throws a
  // RangeError; `runSchedulers` runs inside `AppProvider`'s own
  // `updateApp` reducer updater on EVERY app launch (store.tsx's scheduler
  // effect), so an uncaught throw here doesn't just skip one child's
  // pocket money — with no error boundary anywhere below main.tsx's new
  // one, it unmounts the WHOLE React tree on every subsequent launch too,
  // bricking the guardian app for every other child as well. Skipping just
  // the offending config keeps every OTHER child's allowance/interest
  // working normally; the bad one is retried (and can succeed once fixed,
  // or keep failing harmlessly) on the next tick.
  // Revoked children (v0.2 §4.5) accrue nothing and are sent
  // nothing: their device was removed, and a re-paired device is a new key.
  const revoked = state.docs.accounts.revoked ?? {}
  // Archived children (v0.3's "Remove child") accrue nothing either — an
  // archived child is off Home and the family lists, and must never keep
  // earning pocket money/interest silently in the background. Looked up
  // against `state.children` rather than a doc map (archived lives on
  // `ChildProfile` — the smallest correct place, see state/types.ts); a
  // `cfg.child` naming no `ChildProfile` at all is simply never archived,
  // which several fixtures in this module's own tests rely on.
  const archived = new Set(state.children.filter((c) => c.archived !== undefined).map((c) => c.pubkey))

  for (const cfg of state.docs.allowance.configs) {
    if (revoked[cfg.child] !== undefined || archived.has(cfg.child)) continue
    try {
      const account = accountFor(state, cfg.account)
      if (account === undefined) continue
      const refused = refusedPeriods(state, cfg)
      const dueDays = allowanceDue(cfg, [...state.entries, ...entries], nowSec).filter((d) => !refused.has(periodKeyOf(cfg, d)))
      if (dueDays.length === 0) continue

      if (cfg.choresGate || cfg.auditGate) {
        for (const dueDay of dueDays) {
          claims.push(gatedClaim(cfg, dueDay, periodKeyOf(cfg, dueDay), nowSec))
        }
        continue
      }

      for (const dueDay of dueDays) {
        const meta = { id: schedulerEntryId(cfg.child, cfg.account, dueDay, 'allowance'), child: cfg.child, createdAt: nowSec, author: 'guardian' as const }
        entries.push(allowanceEntry(cfg, account, dueDay, meta))
      }
    } catch {
      continue
    }
  }

  for (const cfg of state.docs.interest.configs) {
    if (revoked[cfg.child] !== undefined || archived.has(cfg.child)) continue
    try {
      const account = accountFor(state, cfg.account)
      if (account === undefined) continue
      const config = JSON.stringify(cfg)
      const previous = matchEvaluations[cfg.account]
      const evaluatedThrough = previous?.config === config && previous.ledger === ledger ? previous.throughDay : undefined
      const interestDays = new Set(cfg.rateBps > 0 ? interestDue(cfg, [...state.entries, ...entries], nowSec) : [])
      const matchDays = new Set(matchDue(cfg, [...state.entries, ...entries], nowSec, evaluatedThrough))
      const dueDays = [...new Set([...interestDays, ...matchDays])].sort()
      if (dueDays.length === 0) continue

      for (const dueDay of dueDays) {
        // The deposit match for a due day is queued BEFORE that day's
        // interest, so it counts towards the balance the interest is
        // computed on — the same as an allowance paid on the same day. It
        // covers deposits from the last matched due day up to, not including,
        // this one (domain/interest.ts#matchWindowStart), capped per period.
        if (matchDays.has(dueDay)) {
          const all = [...state.entries, ...entries]
          const deposited = depositsInWindow(all, account.id, matchWindowStart(cfg, all), dueDay, cfg.tz)
          const meta = { id: schedulerEntryId(cfg.child, cfg.account, dueDay, 'match'), child: cfg.child, createdAt: nowSec, author: 'guardian' as const }
          const match = matchEntry(cfg, account, dueDay, deposited, meta)
          if (match !== null) entries.push(match)
          matchEvaluations[cfg.account] = { config, ledger, throughDay: dueDay }
          evaluatedAccounts.add(cfg.account)
        }
        if (!interestDays.has(dueDay)) continue
        // Interest is computed on the balance AS OF this period's due day,
        // not today's: a deposit made later never earns
        // back-interest, and a missed-weeks catch-up compounds in due-day
        // order. `entries` includes everything this pass already queued —
        // allowance payouts, matches and earlier interest periods — each
        // counted as of its own due day (domain/interest.ts#effectiveDay).
        const balanceMinor = balanceAsOf([...state.entries, ...entries], account.id, dueDay, cfg.tz)
        const meta = { id: schedulerEntryId(cfg.child, cfg.account, dueDay, 'interest'), child: cfg.child, createdAt: nowSec, author: 'guardian' as const }
        const entry = interestEntry(cfg, account, dueDay, balanceMinor, meta)
        if (entry !== null) entries.push(entry)
      }
    } catch {
      continue
    }
  }

  if (evaluatedAccounts.size > 0) {
    // Include payouts proposed in this same tick. Any later ledger change
    // (including an older deposit healed during recovery) invalidates the
    // cache, so its own due period and cap are evaluated again.
    const finalLedger = ledgerSignature([...state.entries, ...entries])
    for (const account of evaluatedAccounts) matchEvaluations[account]!.ledger = finalLedger
  }
  return { entries, claims, ...(evaluatedAccounts.size > 0 ? { matchEvaluations } : {}) }
}

/** Deterministic id: same (child, account, due day, kind) always produces
 *  the same entry id, so re-running the scheduler against a state that
 *  already folded a previous run's entries can never mint a fresh id for
 *  what `allowanceDue`/`interestDue` would otherwise have already excluded
 *  by periodKey — belt-and-braces against a periodKey collision slipping an
 *  exact duplicate through `addEntry`'s id-dedupe too. Deliberately NOT
 *  `newId()` (domain/id.ts): that mints fresh randomness every call, which
 *  is correct for anything a human action originates but wrong for a
 *  scheduler expected to be idempotent by construction. This is why these
 *  ids are not ULIDs, as v1 otherwise asks — see Entry.id in
 *  domain/types.ts. */
function schedulerEntryId(child: string, account: string, dueDay: string, kind: 'allowance' | 'interest' | 'match'): string {
  return `sched:${kind}:${child}:${account}:${dueDay}`
}
