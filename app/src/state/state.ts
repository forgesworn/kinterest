import { assertEntry, assertReversalOf } from '../domain/ledger'
import { legitimatePeriodKeys, type AllowanceConfig } from '../domain/allowance'
import type { Entry } from '../domain/types'
import type { ChoreTick } from '../domain/chores'
import type { AuditResult } from '../domain/audit'
import type { GrantPayload, RequestPayload } from '../wire/payloads'
import { KIND_CHILD_SIG, KIND_CONFIG, KIND_ENTRY, KIND_GRANT } from '../wire/kinds'
import type { NostrEvent } from 'nostr-tools/pure'
import type { AppState, ChildProfile, ConfigDocs, StoredRequest } from './types'

// Widely used public relays that accept gift wraps (kind 1059); overridable
// at pairing. Several, so one relay going down doesn't stall the family.
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

export function emptyState(): AppState {
  return {
    v: 1,
    role: 'unset',
    guardianPubkey: null,
    self: { pubkey: null, childIndex: null },
    children: [],
    entries: [],
    acks: {},
    ticks: [],
    audits: [],
    requests: [],
    docs: {
      accounts: { v: 1, issuedAt: 0, accounts: [] },
      allowance: { v: 1, issuedAt: 0, configs: [] },
      interest: { v: 1, issuedAt: 0, configs: [] },
      chores: { v: 1, issuedAt: 0, chores: [] },
    },
    docHighWater: {},
    relays: [...DEFAULT_RELAYS],
    seenEventIds: [],
    root: null,
    innerEvents: {},
  }
}

/** How many CHILD_SIG (chore tick / audit) inner events we keep for resync. */
export const MAX_RETAINED_CHILD_SIG = 500

/**
 * Bounds `AppState.innerEvents` (v0.2 spec §2.3). Pure; the input is never
 * mutated.
 *
 * ENTRY/CONFIG/GRANT are kept in full: they ARE the ledger and its policy,
 * and the ledger is already unbounded in `state.entries` — dropping one here
 * would make this device unable to answer a resync for history it can still
 * display. CHILD_SIG is the one high-frequency, low-value kind (a tick per
 * chore per day), so only the newest {@link MAX_RETAINED_CHILD_SIG} survive,
 * ordered by `created_at` and then by `id` ascending so that two devices
 * given the same corpus keep the same events (a stable tiebreak matters:
 * ticks minted on the same day share a timestamp).
 *
 * Anything of another kind is dropped outright — nothing else is ever
 * replayed by resync, so retaining it would be storage spent on data no
 * consumer reads.
 *
 * Known limitation (deferred to v0.3, deliberately not implemented here):
 * CONFIG events superseded by a later `issuedAt` of the same docKind are
 * still retained, so a very long-lived family can outgrow localStorage.
 */
export function retainInnerEvents(m: Record<string, NostrEvent>): Record<string, NostrEvent> {
  const kept: Record<string, NostrEvent> = {}
  const childSigs: [string, NostrEvent][] = []

  for (const [key, ev] of Object.entries(m)) {
    if (ev.kind === KIND_ENTRY || ev.kind === KIND_CONFIG || ev.kind === KIND_GRANT) kept[key] = ev
    else if (ev.kind === KIND_CHILD_SIG) childSigs.push([key, ev])
  }

  childSigs.sort(([, a], [, b]) => (a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const [key, ev] of childSigs.slice(Math.max(0, childSigs.length - MAX_RETAINED_CHILD_SIG))) kept[key] = ev

  return kept
}

/** The children this guardian still syncs with — every child whose device has
 *  not been revoked (v0.2 spec §4.5) AND who has not been archived (v0.3:
 *  "Remove child"). Pure. A revoked child stays in `state.children` (its
 *  history is still the family's) and stays in the accounts doc's `revoked`
 *  map forever; an archived one stays too, marked on its own `ChildProfile`
 *  — either way it is simply no longer a peer. */
export function activeChildren(app: AppState): ChildProfile[] {
  const revoked = app.docs.accounts.revoked
  return app.children.filter((c) => c.archived === undefined && (revoked === undefined || revoked[c.pubkey] === undefined))
}

/** Archives a child (v0.3's "Remove child" — never a deletion, since money
 *  must always add up): hides them from Home and the other family lists
 *  while keeping their `ChildProfile` and every ledger entry untouched.
 *  Idempotent — an already-archived child, or a `childPubkey` naming no
 *  child at all, is a no-op (same `AppState` reference back). Pure.
 *
 *  Revoking a paired device is a SEPARATE step the caller takes itself
 *  (screens/ChildDetail.tsx, the same `stampConfigDoc`/`applyConfigDoc` path
 *  "Remove this device" already uses) — this function only ever touches
 *  `state.children`. */
export function archiveChild(app: AppState, childPubkey: string, nowSec: number): AppState {
  const child = app.children.find((c) => c.pubkey === childPubkey)
  if (child === undefined || child.archived !== undefined) return app
  return { ...app, children: app.children.map((c) => (c.pubkey === childPubkey ? { ...c, archived: nowSec } : c)) }
}

/** Records that a child's device has completed the pairing ceremony
 *  (v0.3) — set once, right when a `pair.claim` is successfully answered
 *  (store.tsx's `onPairClaimAnswered`). Looked up by `childIndex`, not
 *  pubkey: that is all a `PairingSessionState` knows about which child the
 *  ceremony was opened for. Idempotent — a child already marked paired, or a
 *  `childIndex` naming no child, is a no-op (same `AppState` reference
 *  back). Never cleared by a later revoke: this answers "has a device EVER
 *  paired", which a revocation does not undo. Pure. */
export function markChildPaired(app: AppState, childIndex: number, nowSec: number): AppState {
  const child = app.children.find((c) => c.index === childIndex)
  if (child === undefined || child.pairedAt !== undefined) return app
  return { ...app, children: app.children.map((c) => (c.index === childIndex ? { ...c, pairedAt: nowSec } : c)) }
}

/** The pubkeys a CONFIG doc should be sent to (each gets its own view) — every
 *  child that has not been revoked (v0.2 spec §4.5). Pure.
 *
 *  A separate name from `activeChildren` on purpose: this is the SEND side of
 *  a revocation, and it was the half originally missed. Dropping a revoked
 *  device from the guardian's peer set only stops the guardian LISTENING to
 *  it; without this, every subsequent accounts/allowance/interest/chores doc
 *  was still gift-wrapped to a device the family had removed — indefinitely,
 *  and each one readable by it.
 *
 *  The one deliberate exception is the revocation doc ITSELF, which
 *  `screens/ChildDetail.tsx` sends over the FULL roster: the removed device
 *  is precisely the one that has to receive it. */
export function configRecipients(app: AppState): string[] {
  return activeChildren(app).map((c) => c.pubkey)
}

/** The child-side counterpart to `activeChildren` (v0.2 spec §4.5): the unix
 *  SECONDS at which THIS device was revoked, or `null` if it was not. Pure.
 *
 *  App.tsx gates the Unpaired screen on this rather than on a one-shot
 *  navigation from the store's `revoked` effect handler, because the fact is
 *  durable — it rides the accounts doc, which is persisted — and a removed
 *  device must still be removed after a reload. Guardian devices and a child
 *  with no self pubkey yet are never revoked by definition. */
export function selfRevokedAt(app: AppState): number | null {
  if (app.role !== 'child' || app.self.pubkey === null) return null
  return app.docs.accounts.revoked?.[app.self.pubkey] ?? null
}

// Validates via assertEntry (throws propagate to the caller — the sync layer
// is expected to catch and drop the offending event, per the plan's
// "assertEntry on ingress" rule). Dedupes by id: a repeat returns the exact
// same state reference so callers can cheaply detect a no-op with `===`.
//
// Reversals: a reversal arriving after the entry it names must
// be that entry's exact mirror, or it is refused. One whose original has not
// arrived yet cannot be checked and is accepted — refusing the original
// later instead would let a bad reversal block a genuine entry. Only the
// guardian authors entries today, so this is integrity, not an attack path.
export function addEntry(s: AppState, e: Entry): AppState {
  assertEntry(e)
  if (s.entries.some((existing) => existing.id === e.id)) return s
  if (e.reverses !== undefined) {
    const original = s.entries.find((x) => x.id === e.reverses)
    if (original !== undefined) assertReversalOf(original, e)
    // One reversal per original: a second one, under another id, would fold
    // in too and refund the entry twice.
    if (s.entries.some((x) => x.reverses === e.reverses))
      throw new RangeError(`entry ${e.reverses} has already been reversed`)
  }
  return { ...s, entries: [...s.entries, e] }
}

/** Folds a chore tick the CHILD device itself just produced (tapping "Tick"
 *  in screens/Chores.tsx) into local state, before it has round-tripped to
 *  the guardian and back — see sync/ingress.ts#handleWrap's own KIND_CHILD_SIG
 *  case for the receiving-side counterpart (the guardian folding a tick a
 *  child SENT it), which dedupes by id the same way. Deduping here matters
 *  for the SAME reason: screens/chores.ts#choreTickId is deterministic per
 *  (chore, day), so a second tap on an already-ticked day calls this again
 *  with the identical id — a no-op, same `AppState` reference back, rather
 *  than a duplicate tick (and, since Chores.tsx checks this same dedupe
 *  before ever calling sendTick, a duplicate wire send either). */
export function recordTick(s: AppState, tick: ChoreTick): AppState {
  if (s.ticks.some((t) => t.id === tick.id)) return s
  return { ...s, ticks: [...s.ticks, tick] }
}

/** Folds an audit RESULT the CHILD device itself just produced (finishing
 *  screens/Audit.tsx's coin-counting ceremony) into local state, before it
 *  has round-tripped to the guardian — mirrors `recordTick` above exactly
 *  (same dedupe-by-id reasoning: a repeat call for an already-recorded
 *  `audit.id` is a no-op, same `AppState` reference back). Unlike a tick, an
 *  audit is never re-sent by a retry loop on THIS device — Audit.tsx dispatches
 *  this once, right before its one `sendAudit` call — but the dedupe still
 *  matters for the same reason `addEntry`'s does: sync/ingress.ts#handleWrap's
 *  own KIND_CHILD_SIG case (the GUARDIAN'S receiving side) uses the identical
 *  dedupe-by-id fold against `state.audits`, so this function keeps both
 *  sides of the wire agreeing on what "already recorded" means. */
export function recordAudit(s: AppState, audit: AuditResult): AppState {
  if (s.audits.some((a) => a.id === audit.id)) return s
  return { ...s, audits: [...s.audits, audit] }
}

// LWW by issuedAt with an anti-rollback high-water mark: a doc strictly
// newer than what we've already seen for `kind` replaces it wholesale;
// anything older or equal is dropped (same state reference back).
export function applyConfigDoc<K extends keyof ConfigDocs>(s: AppState, kind: K, doc: ConfigDocs[K]): AppState {
  const highWater = s.docHighWater[kind] ?? 0
  if (doc.issuedAt <= highWater) return s
  return {
    ...s,
    docs: { ...s.docs, [kind]: doc },
    docHighWater: { ...s.docHighWater, [kind]: doc.issuedAt },
  }
}

const ROWS_KEY = { accounts: 'accounts', allowance: 'configs', interest: 'configs', chores: 'chores' } as const

/**
 * The GUARDIAN's fold of one of its own config docs replayed back by a child
 * (resync). Pure.
 *
 * Each child only ever holds its own view of a doc — its own rows, at the
 * doc's `issuedAt` (`sync/snapshot.ts#scopeDoc`) — so a recovering guardian
 * rebuilds the family's docs from several children's views that often share
 * one `issuedAt`. Plain LWW would keep the first view and drop every
 * sibling's. Instead, per child named in `doc`:
 *   - the incoming rows replace that child's rows when `doc.issuedAt` is at
 *     least the high-water, or when the guardian holds no rows for that
 *     child at all (an older view is better than none);
 *   - otherwise they are ignored.
 * Rows for children the doc does not name are kept. `revoked` is a union
 * (a revocation is never undone); the guardian's own value wins a conflict.
 * The high-water becomes the larger `issuedAt`. A fold that changes nothing
 * returns the same state reference, like `applyConfigDoc`.
 */
export function mergeConfigDoc<K extends keyof ConfigDocs>(s: AppState, kind: K, doc: ConfigDocs[K]): AppState {
  const highWater = s.docHighWater[kind] ?? 0
  const key = ROWS_KEY[kind]
  const rowsOf = (d: ConfigDocs[K]): { child: string }[] => (d as unknown as Record<string, { child: string }[]>)[key] ?? []
  const current = s.docs[kind]
  const currentRows = rowsOf(current)
  const incomingRows = rowsOf(doc)
  const incomingRevoked = kind === 'accounts' ? ((doc as ConfigDocs['accounts']).revoked ?? {}) : {}
  const currentRevoked = kind === 'accounts' ? ((current as ConfigDocs['accounts']).revoked ?? {}) : {}

  const named = new Set<string>(incomingRows.map((r) => r.child))
  const held = new Set<string>(currentRows.map((r) => r.child))
  const taken = new Set([...named].filter((c) => doc.issuedAt >= highWater || !held.has(c)))
  const rowsFor = (rows: { child: string }[], c: string) => JSON.stringify(rows.filter((r) => r.child === c))
  const rowsChanged = [...taken].some((c) => rowsFor(currentRows, c) !== rowsFor(incomingRows, c))
  const revokedChanged = Object.keys(incomingRevoked).some((pk) => currentRevoked[pk] === undefined)
  if (!rowsChanged && !revokedChanged && doc.issuedAt <= highWater) return s

  const rows = [...currentRows.filter((r) => !taken.has(r.child)), ...incomingRows.filter((r) => taken.has(r.child))]
  const merged = { ...current, issuedAt: Math.max(current.issuedAt, doc.issuedAt), [key]: rows } as ConfigDocs[K]
  if (kind === 'accounts' && (revokedChanged || Object.keys(currentRevoked).length > 0)) {
    ;(merged as ConfigDocs['accounts']).revoked = { ...incomingRevoked, ...currentRevoked }
  }
  return {
    ...s,
    docs: { ...s.docs, [kind]: merged },
    docHighWater: { ...s.docHighWater, [kind]: Math.max(highWater, doc.issuedAt) },
  }
}

// ============================================================================
// Request registry — AppState.requests. See
// internal plan 2026-08-11-parent-mode, Task 5 ("persist
// requests into state-adjacent store slice") and StoredRequest's own doc
// comment (state/types.ts) for why "dismissed"/"denied" are statuses, never
// deletions. Both functions below key exclusively on `request.reqId` —
// that's the single dedupe point every caller (store.tsx's guardian-engine
// onEffect wiring, the scheduler's gated-claim wiring, and a guardian's own
// Approve/Not-now/Dismiss action) funnels through, so a relay replaying the
// same wrap can never resurrect an already-decided request, and a genuine
// double-answer (a double-tap, or this being invoked twice for the same
// reqId for any other reason) can never mint two ledger entries for one
// request — see store.tsx#buildGrantDecision, which layers its own entry
// creation on top of `recordRequestDecision`'s idempotence rather than
// re-deriving it independently.
// ============================================================================

/** Records a freshly-seen spend.request/allowance.claim as 'pending'. A
 *  reqId already present is left COMPLETELY untouched — same `AppState`
 *  reference back — whether the existing record is still 'pending' or was
 *  already approved/denied/dismissed: this is the replay-resurrection
 *  guard the plan calls out ("relay replay must not resurrect").
 *
 *  `authorPk` must equal `request.child`: `request.child` is self-reported
 *  INSIDE the payload (wire/payloads.ts's `parseRequestPayload` only checks
 *  it's a non-empty string, never cross-checks it against who actually
 *  signed the wrap), while `authorPk` is what sync/multi.ts's membership
 *  check actually authenticated. Without this guard a compromised child
 *  device could claim a SIBLING's pubkey in `params`/`child` and trick the
 *  guardian into granting spend against an account it doesn't own — a
 *  mismatch is dropped, the same shape as handleWrap's own direction
 *  guards. Callers must exclude `pair.claim` themselves (that op is never
 *  answered as a grant — see ingress.ts's module header); this function has
 *  no opinion on `request.op` beyond the provenance check. */
export function upsertRequest(s: AppState, request: RequestPayload, authorPk: string, nowSec: number): AppState {
  if (authorPk !== request.child) return s
  if (s.requests.some((r) => r.request.reqId === request.reqId)) return s
  const record: StoredRequest = { request, authorPk, status: 'pending', createdAt: nowSec }
  if (claimLegitimateNow(s, request, nowSec)) record.periodLegitimateAtReceipt = true
  return { ...s, requests: [...s.requests, record] }
}

function claimedPeriodKey(request: RequestPayload): string | null {
  if (request.op !== 'allowance.claim') return null
  const k = request.params.periodKey
  return typeof k === 'string' && k !== '' ? k : null
}

/** True when `request` is an allowance.claim whose periodKey the child's
 *  CURRENT allowance config could have produced by `nowSec` (unix SECONDS). */
function claimLegitimateNow(s: AppState, request: RequestPayload, nowSec: number): boolean {
  const key = claimedPeriodKey(request)
  if (key === null) return false
  const cfg = s.docs.allowance.configs.find((c) => c.child === request.child)
  if (cfg === undefined) return false
  try {
    return legitimatePeriodKeys(cfg, nowSec).has(key)
  } catch {
    return false // an unusable tz/day: never legitimate
  }
}

/**
 * Whether an allowance.claim for `request.params.periodKey` may be granted
 * under `cfg` at `nowSec` (unix SECONDS).
 *
 * Normally the periodKey must be one `cfg` could have produced
 * (`legitimatePeriodKeys`). A re-anchoring edit moves `cfg.startDay`
 * forward, which would silently strand a gated claim the child had already
 * earned and that was waiting in the inbox. So a claim still 'pending' in
 * `s.requests` that was legitimate when it was received stays grantable.
 * A claim received after the edit, or one already denied or dismissed, gets
 * no such allowance. Paying at most once is still enforced by the caller
 * (`periodAlreadyPaid` and the deterministic grant entry id).
 */
export function claimPeriodGrantable(s: AppState, request: RequestPayload, cfg: AllowanceConfig, nowSec: number): boolean {
  const key = claimedPeriodKey(request)
  if (key === null) return false
  if (legitimatePeriodKeys(cfg, nowSec).has(key)) return true
  const stored = s.requests.find((r) => r.request.reqId === request.reqId)
  return (
    stored !== undefined &&
    stored.status === 'pending' &&
    stored.periodLegitimateAtReceipt === true &&
    stored.request.child === request.child &&
    claimedPeriodKey(stored.request) === key
  )
}

/** True when `reqId` names a request that has ALREADY been decided
 *  (approved/denied/dismissed) — i.e. anything other than "unseen" or still
 *  'pending'. store.tsx#buildGrantDecision uses this to refuse building a
 *  fresh entry/GRANT for a reqId that was already answered. */
export function requestAlreadyDecided(s: AppState, reqId: string): boolean {
  const existing = s.requests.find((r) => r.request.reqId === reqId)
  return existing !== undefined && existing.status !== 'pending'
}

/** Records a guardian's decision (approve/deny/dismiss) for
 *  `request.reqId`: flips an existing 'pending' record to `status`, or —
 *  for a caller that never routed the request through `upsertRequest`
 *  first (a direct function-level call, e.g. store.test.ts's unit tests, or
 *  a locally-synthesised scheduler claim answered before it was ever
 *  upserted) — creates one already in that decided state. Idempotent
 *  either way: a reqId ALREADY in a non-'pending' status is left completely
 *  untouched (same `AppState` reference back) — the fix for the carried
 *  defect "no idempotency check against request.reqId... answering the
 *  same request twice... creates two ledger entries" (SDD ledger, Task 3 ->
 *  Task 5 MUST-CARRY).
 *
 *  This function only protects its OWN `requests` slice. A caller that also
 *  folds a ledger entry into state for an 'approved' decision
 *  (store.tsx#buildGrantDecision) must check `requestAlreadyDecided` itself
 *  BEFORE calling `addEntry` — this function has no way to retract an entry
 *  already folded in earlier in the same updater. */
export function recordRequestDecision(
  s: AppState,
  request: RequestPayload,
  authorPk: string,
  status: Exclude<StoredRequest['status'], 'pending'>,
  nowSec: number,
  grantedAmountMinor?: number,
): AppState {
  if (authorPk !== request.child) return s
  const idx = s.requests.findIndex((r) => r.request.reqId === request.reqId)
  if (idx !== -1 && s.requests[idx]!.status !== 'pending') return s // already decided — idempotent no-op
  const decided: StoredRequest = {
    request,
    authorPk,
    status,
    createdAt: idx === -1 ? nowSec : s.requests[idx]!.createdAt,
    decidedAt: nowSec,
    ...(grantedAmountMinor !== undefined ? { grantedAmountMinor } : {}),
  }
  const requests = idx === -1 ? [...s.requests, decided] : s.requests.map((r, i) => (i === idx ? decided : r))
  return { ...s, requests }
}

/** Child-side counterpart to the pair above — see
 *  internal plan 2026-08-11-child-mode, Task 1 ("GRANT ingress
 *  on the child records grant results against state.requests"). Folds an
 *  inbound GRANT (`sync/ingress.ts`'s 'grant' effect, already
 *  direction-guarded to the pinned guardian there) into `state.requests` by
 *  `grant.reqId`, upserting exactly like `recordRequestDecision` for a reqId
 *  this device already knows about — and, when it doesn't, SYNTHESISING an
 *  already-decided row rather than dropping the GRANT.
 *
 *  A reqId can be unknown here for exactly one reason today: a guardian's
 *  scheduler-gated allowance claim (store/scheduler.ts's own
 *  `scheduler:${child}:${account}:${periodKey}` reqId convention) is
 *  synthesised LOCALLY on the guardian device and never crosses the wire as
 *  a REQUEST — see store.tsx's scheduler effect and `runSchedulers`'s own
 *  module header ("these never cross the wire"). The child that GRANT is
 *  addressed to therefore never had anything to `upsertRequest` for that
 *  reqId in the first place; the GRANT is its first and only sight of it.
 *  Silently dropping a GRANT whose reqId isn't already in `state.requests`
 *  would make every gated-allowance payout invisible to the child's own
 *  pending/history list, so a synthetic row is built instead — `op:
 *  'allowance.claim'` (the only real source), `params.periodKey` lifted from
 *  the GRANT's own `params` when present (an 'allow' decision's params — see
 *  `buildGrantPayload`'s allowance.claim branch in store.tsx), `child: selfPk`
 *  (this device, since a GRANT is only ever addressed to the child it
 *  concerns). This is a display record, never re-parsed as a real
 *  `RequestPayload` off the wire, so it does not need to satisfy
 *  `parseRequestPayload`'s own shape checks (e.g. an empty `params` for a
 *  deny, which carries no periodKey at all).
 *
 *  Idempotent via the same `recordRequestDecision` this delegates to either
 *  way: a reqId already in a DECIDED state (whether upserted for real or
 *  synthesised by an earlier call to this function) is left untouched, so a
 *  redelivered/duplicate GRANT is always a safe no-op. */
export function recordGrantResult(s: AppState, grant: GrantPayload, selfPk: string, nowSec: number): AppState {
  // 'dismissed' is a THIRD outcome, not a flavour of denial (v0.2 spec §4.3):
  // folding it as 'denied' would make the child's Ask screen read "Not this
  // time" for an ask the guardian merely set aside.
  const status: 'approved' | 'denied' | 'dismissed' =
    grant.decision === 'allow' ? 'approved' : grant.decision === 'dismissed' ? 'dismissed' : 'denied'
  const existing = s.requests.find((r) => r.request.reqId === grant.reqId)

  if (existing !== undefined) {
    const amountMinor = grant.params.amountMinor
    const grantedAmountMinor =
      existing.request.op === 'spend.request' && status === 'approved' && typeof amountMinor === 'number' && Number.isSafeInteger(amountMinor)
        ? amountMinor
        : undefined
    return recordRequestDecision(s, existing.request, existing.authorPk, status, nowSec, grantedAmountMinor)
  }

  // periodKey is copied here unconditionally — for an 'allow' AND a 'deny'
  // alike, `status` plays no part in this extraction. The bug a review once
  // found here was never in this function: it was `store.tsx#buildGrantDecision`'s
  // `denyOnly()` sending an EMPTY params object for a denied allowance.claim,
  // so `grant.params.periodKey` had nothing to copy in the first place. See
  // that function's own doc comment for the fix — this line has always
  // faithfully copied whatever periodKey the GRANT actually carried.
  const periodKey = typeof grant.params.periodKey === 'string' && grant.params.periodKey.length > 0 ? grant.params.periodKey : undefined
  const amountMinor = grant.params.amountMinor
  // The op comes from the GRANT itself: a periodKey, or the
  // scheduler's own reqId convention, marks a pocket-money claim; anything
  // else is a spend (e.g. this device lost its state and a spend's GRANT
  // arrived afterwards), carrying the granted amount when there is one.
  const isClaim = periodKey !== undefined || grant.reqId.startsWith('scheduler:')
  const grantedAmount =
    !isClaim && status === 'approved' && typeof amountMinor === 'number' && Number.isSafeInteger(amountMinor) ? amountMinor : undefined
  const synthetic: RequestPayload = {
    v: 1,
    op: isClaim ? 'allowance.claim' : 'spend.request',
    reqId: grant.reqId,
    nonce: grant.nonce,
    child: selfPk,
    ts: nowSec,
    params: periodKey !== undefined ? { periodKey } : grantedAmount !== undefined ? { amountMinor: grantedAmount } : {},
  }
  const next = recordRequestDecision(s, synthetic, selfPk, status, nowSec, grantedAmount)
  // Marked so persistence keeps it even though it may not satisfy
  // parseRequestPayload (see StoredRequest.synthetic).
  return {
    ...next,
    requests: next.requests.map((r) => (r.request === synthetic ? { ...r, synthetic: true as const } : r)),
  }
}
