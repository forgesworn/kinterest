// Pure logic behind the child's Ask screen — a spend.request builder, a
// self-scoped view of this child's own request registry, and warm status
// chips for the pending/answered list. See
// internal plan 2026-08-11-child-mode, Task 4, and this plan's
// Global Constraints: "warm, simple, second person... The child never sees
// raw pubkeys, bps, or period keys" and "dismissed asks show 'No reply yet'
// after 48h rather than pending forever".
//
// That last rule needs unpacking against how a guardian's "dismiss" works.
// It USED to be a LOCAL-only, guardian-side status flip that never built or
// sent a GRANT, which made a dismissed ask indistinguishable, on the child's
// own device, from one nobody had looked at yet: the record stayed
// 'pending' forever, and `askChip`'s 48h "No reply yet" was the only honest
// thing to say about it.
//
// Since v0.2 (spec §4.3) a dismissal IS sent: Approvals.tsx routes it
// through the same `submitDecision`/`buildGrantDecision` path as an
// approve/deny, producing a GRANT with `decision: 'dismissed'` and no ledger
// entry, which `state/state.ts#recordGrantResult` folds to
// `status: 'dismissed'` on the child. So a child device now really does hold
// 'dismissed' records, and `askChip` answers them with "Not now" BEFORE it
// ever reaches the age check. The 48h "No reply yet" rule survives for what
// it was always actually about: an ask that genuinely nobody has answered.

import { bytesToHex } from 'nostr-tools/utils'
import { newId } from '../domain/id'
import { buildRequestPayload, type RequestPayload } from '../wire/payloads'
import type { PillTone } from '../components/ui'
import type { AppState, StoredRequest } from '../state/types'

// ============================================================================
// Self-scoping — same doctrine as ChildHome.tsx's childOwnAccounts/
// childOwnEntries (see that module's own header): a child device's
// AppState.requests can, in principle, carry more than this device's own
// asks (nothing about the request registry itself enforces single-child
// scope), so this is the one gate Ask.tsx's render body is built on rather
// than trusting `app.requests` verbatim.
// ============================================================================

export function childOwnRequests(app: AppState): StoredRequest[] {
  if (app.self.pubkey === null) return []
  return app.requests.filter((r) => r.request.child === app.self.pubkey)
}

// ============================================================================
// Fresh reqId/nonce — the same pattern pairing.ts#buildPairClaim already
// uses (the other place a device mints a brand-new REQUEST from scratch).
// Exported so screens/chores.ts's own gate-triggered allowance.claim mints
// one the identical way rather than a second, divergent implementation.
// ============================================================================

export function freshReqId(nowSec: number): string {
  return newId(Math.floor(nowSec * 1000))
}

export function freshNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

// ============================================================================
// buildSpendRequest — the Ask screen's own submit action.
// ============================================================================

export interface BuildSpendRequestOpts {
  /** This device's own pubkey — a spend.request's `child` field. */
  child: string
  accountId: string
  amountMinor: number
  currency: string
  note?: string
  link?: string
  nowSec: number
}

/** Blank/whitespace-only `note`/`link` are omitted from `params` entirely
 *  (rather than sent as `''`) — matches wire/payloads.ts's own
 *  `isSpendRequestParams`, which treats both as genuinely optional, and
 *  keeps a request with nothing typed in either field from round-tripping
 *  through the guardian's Approvals card as an empty, quoted `""`. */
export function buildSpendRequest(opts: BuildSpendRequestOpts): RequestPayload {
  const params: Record<string, unknown> = {
    amountMinor: opts.amountMinor,
    currency: opts.currency,
    account: opts.accountId,
  }
  if (opts.note !== undefined && opts.note.trim() !== '') params.note = opts.note.trim()
  if (opts.link !== undefined && opts.link.trim() !== '') params.link = opts.link.trim()
  return buildRequestPayload({
    op: 'spend.request',
    reqId: freshReqId(opts.nowSec),
    nonce: freshNonce(),
    child: opts.child,
    ts: opts.nowSec,
    params,
  })
}

// ============================================================================
// askChip — "warm status chips" per the plan.
// ============================================================================

/** 48 hours — see this module's header. Applies only to a still-'pending'
 *  record: a 'dismissed' one has been answered, and is chipped as such
 *  before this threshold is ever consulted. */
const NO_REPLY_AFTER_SECS = 48 * 3600

export type AskChipKind = 'pending' | 'no-reply-yet' | 'approved' | 'approved-less' | 'denied' | 'dismissed'

export interface AskChip {
  kind: AskChipKind
  label: string
  tone: PillTone
}

/** Pure. `nowSec` is the caller's own single clock read (Global Constraints:
 *  no `Date.now()` in pure logic) — Ask.tsx passes the same value it used to
 *  build the list this chip is rendered inside.
 *
 *  'approved-less' — a spend.request granted for LESS than asked (Task 5's
 *  guardian-side stepper) — reads the actual granted amount from
 *  `stored.grantedAmountMinor`, falling back to the asked amount for a
 *  malformed/legacy record with none (never letting a `NaN`/`undefined`
 *  comparison silently mis-tag a full grant as partial). `allowance.claim`
 *  has no partial-grant concept at all (state/state.ts#recordGrantResult
 *  only ever sets `grantedAmountMinor` for a `spend.request`) — an approved
 *  claim is always plain 'approved'. */
export function askChip(stored: StoredRequest, nowSec: number): AskChip {
  if (stored.status === 'denied') return { kind: 'denied', label: 'Not this time', tone: 'bad' }

  // BEFORE the pending/no-reply branch (v0.2 spec §4.3). Since the guardian
  // now SENDS a GRANT when they set an ask aside, a child device really does
  // hold 'dismissed' records, and they are answered — "No reply yet" would
  // be a lie about them however old they get.
  if (stored.status === 'dismissed') return { kind: 'dismissed', label: 'Not now', tone: 'neutral' }

  if (stored.status === 'approved') {
    if (stored.request.op === 'spend.request') {
      const asked = (stored.request.params as { amountMinor?: number }).amountMinor ?? 0
      const granted = stored.grantedAmountMinor ?? asked
      if (granted < asked) return { kind: 'approved-less', label: "You got a bit less than you asked for — that's OK!", tone: 'good' }
    }
    return { kind: 'approved', label: 'Approved!', tone: 'good' }
  }

  // 'pending': genuinely unanswered — no GRANT of any decision has arrived.
  const ageSecs = nowSec - stored.createdAt
  if (ageSecs >= NO_REPLY_AFTER_SECS) return { kind: 'no-reply-yet', label: 'No reply yet', tone: 'neutral' }
  return { kind: 'pending', label: 'Waiting to hear back', tone: 'amber' }
}
