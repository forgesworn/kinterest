// Inbound wire dispatch — every gift-wrapped event this app receives is
// unwrapped and folded into `AppState` here. See
// internal plan 2026-08-10-wire-identity-pairing, Task 7.
//
// `handleWrap` is the general, PINNED-peer dispatcher: it always unwraps
// with `expectedAuthorPk = pinnedPeerPk`, so it is only ever safe to use
// once two parties are already paired (an established guardian<->child
// conversation, in either direction). It is total in the sense that a
// malformed/unverifiable wrap, an unrecognised inner kind, or a payload that
// fails its total parser all silently drop the event and return the state
// unchanged — never a throw.
//
// `pair.claim` intake and `PAIR_OFFER` intake are the TWO exceptions the plan
// calls out and are deliberately NOT routed through `handleWrap` at all,
// because neither has a `pinnedPeerPk` to unwrap against yet — pairing is
// exactly what they're establishing:
//   - `pair.claim` (guardian side, "no pin yet, author captured from seal"):
//     the guardian has no peer to pin, so it needs an unwrap with no
//     `expectedAuthorPk`, and — per the carried obligation from Task 6's
//     review (progress.md) — a hard, atomic `consumeToken` gate strictly
//     before `pairing.ts#answerPairClaim` is ever invoked. That is
//     `handlePairClaimWrap`, below: a separate, guardian-only entry point.
//   - `PAIR_OFFER` (child side): the claiming device has no established
//     guardian pin yet either, but it DOES have something to check the offer
//     against — the guardian pubkey read out of the QR it just scanned
//     (`pairing.ts#parsePairQr`). That's `handlePairOfferWrap`, below: a
//     separate, child-only entry point that unwraps with
//     `expectedAuthorPk = expectedGuardianPk` (the QR's `g=`, not anything
//     read out of the wrap itself).

import type { NostrEvent } from 'nostr-tools/pure'
import { unwrapFrom } from '../wire/giftwrap'
import {
  KIND_ACK,
  KIND_CHILD_SIG,
  KIND_CONFIG,
  KIND_ENTRY,
  KIND_GRANT,
  KIND_PAIR_OFFER,
  KIND_REQUEST,
  KIND_SNAPSHOT,
  KIND_STATUS,
} from '../wire/kinds'
import {
  parseAckPayload,
  parseChildSigPayload,
  parseConfigPayload,
  parseEntryPayload,
  parseGrantPayload,
  parsePairOfferPayload,
  parseRequestPayload,
  parseSnapshotOrCheckpointPayload,
  parseStatusKindPayload,
  type ConfigDocKind,
  type GrantPayload,
  type PairOfferPayload,
  type RequestPayload,
  type ResyncReplyPayload,
  type RootAttestation,
  type StatusPayload,
} from '../wire/payloads'
import { addEntry, applyConfigDoc, retainInnerEvents } from '../state/state'
import { verifyRootAttestation } from '../identity/signetRoot'
import type { AppState, ChildProfile, ConfigDocs } from '../state/types'
import type { Entry } from '../domain/types'
import type { ChoreTick } from '../domain/chores'
import type { AuditResult } from '../domain/audit'
import { assertEntryAgainst } from '../domain/ledger'
import { consumeToken, type MintedToken } from '../pairing/tokens'
import { answerPairClaim, type AnsweredPairClaim } from '../pairing/pairing'
import type { SnapshotPayload as PairingSnapshotPayload } from '../wire/payloads'

/** Bounded LRU (approximated as a bounded FIFO of insertion order) — see the
 *  plan's "event-id dedupe via state.seenEventIds (bounded LRU 2000)". */
export const MAX_SEEN_EVENT_IDS = 2000

function markSeen(state: AppState, id: string): AppState {
  if (state.seenEventIds.includes(id)) return state
  const next = [...state.seenEventIds, id]
  const trimmed = next.length > MAX_SEEN_EVENT_IDS ? next.slice(next.length - MAX_SEEN_EVENT_IDS) : next
  return { ...state, seenEventIds: trimmed }
}

/** Union by pubkey, additive only — a SNAPSHOT never removes a locally known
 *  child, so applying an out-of-order/stale snapshot can't roll the child
 *  list backwards (unlike entries/docs, ChildProfile carries no ordering
 *  field to test "newer than what we already merged in"). */
function mergeChildren(existing: ChildProfile[], incoming: ChildProfile[]): ChildProfile[] {
  const known = new Set(existing.map((c) => c.pubkey))
  const additions = incoming.filter((c) => !known.has(c.pubkey))
  return additions.length === 0 ? existing : [...existing, ...additions]
}

const DOC_KINDS = ['accounts', 'allowance', 'interest', 'chores'] as const

/** 24 hours — see `handleWrap`'s CONFIG/SNAPSHOT/GRANT direction + issuedAt
 *  clamp below. A doc claiming to be issued more than this far into the
 *  future (relative to the receiver's own clock) is refused outright rather
 *  than trusted into `docHighWater`, which is monotonic and never resets: a
 *  single `issuedAt: Number.MAX_SAFE_INTEGER` doc would otherwise poison
 *  that doc kind forever, silently discarding every legitimate update after
 *  it (`applyConfigDoc`'s anti-rollback check is `doc.issuedAt <= highWater`,
 *  so nothing "newer" than MAX_SAFE_INTEGER can ever pass again).
 *
 *  Why a day and not five minutes (audit P3): the clamp exists to BOUND that
 *  poisoning, not to judge freshness, and a bound of a day caps the damage of
 *  a bad guardian clock at a day of frozen policy. Five minutes, meanwhile,
 *  refused every config doc on a child whose clock ran more than five minutes
 *  slow — common on a child's tablet (a wrong time zone set by hand is hours
 *  out) — including the pairing snapshot's docs. A doc beyond the clamp is
 *  deferred, not dropped: see `dispatchInner`'s `deferred`. */
export const MAX_ISSUED_AT_SKEW_SECS = 24 * 60 * 60

/** The inner kinds kept verbatim in `AppState.innerEvents` (v0.2 spec §2.3):
 *  everything a peer might have to replay to a device that missed it. ACK,
 *  REQUEST, SNAPSHOT and PAIR_OFFER are deliberately absent — none of them is
 *  ever replayed (an ack is re-derivable, a request is answered or stale, a
 *  snapshot is regenerated from current state). */
export const RETAINED_INNER_KINDS: readonly number[] = [KIND_ENTRY, KIND_CONFIG, KIND_GRANT, KIND_CHILD_SIG]

/** The guardian -> child only inner kinds — the same set `dispatchInner`'s
 *  direction guard refuses from any other author (see `handleWrap`'s header).
 *  ENTRY joined it with audit P1: no child flow authors one. */
const GUARDIAN_ONLY_INNER_KINDS: readonly number[] = [KIND_CONFIG, KIND_SNAPSHOT, KIND_GRANT, KIND_ENTRY]

/**
 * Whether a verified inner event belongs in `AppState.innerEvents`. Pure.
 *
 * Retention is `RETAINED_INNER_KINDS` MINUS whatever the direction guard
 * refuses: a CONFIG or GRANT that did not come from `state.guardianPubkey` is
 * never applied, so retaining it would keep a child-authored document in the
 * corpus forever — and hand it on to a third device the next time that device
 * asks for a replay (spec §2.4). A refused event is treated exactly like an
 * unrecognised kind: not ours to keep.
 *
 * Parse failure is deliberately NOT a reason to drop: an event minted by a
 * newer build, correctly authored, must survive this build's older parser
 * (spec §2.3).
 */
export function retainsInnerEvent(state: AppState, innerKind: number, authorPk: string): boolean {
  if (!RETAINED_INNER_KINDS.includes(innerKind)) return false
  if (GUARDIAN_ONLY_INNER_KINDS.includes(innerKind) && authorPk !== state.guardianPubkey) return false
  return true
}

/**
 * A JSON-plain copy of a signed inner event, for storing in
 * `AppState.innerEvents`. Every NIP-01 field is carried verbatim (the event
 * must still verify byte-for-byte on whatever device we later replay it to),
 * and nothing else is: `nostr-tools#verifyEvent` stamps a `Symbol(verified)`
 * cache onto every event it has checked, and an object spread WOULD copy that
 * symbol through. A symbol does not survive `JSON.stringify`, so a state
 * carrying one is a state that stops comparing equal to itself the moment it
 * round-trips through `state/persist.ts` — the sort of difference that shows
 * up much later as an idempotence failure. Pure.
 */
export function toStoredEvent(ev: NostrEvent): NostrEvent {
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  }
}

/** Folds a SNAPSHOT's entries/docs/children into `state` using each field's
 *  own existing merge semantics (append-dedupe for entries, anti-rollback
 *  LWW for docs, additive union for children) — every one of those is
 *  independently idempotent and order-insensitive, so applying the same or
 *  an older snapshot twice is always a safe no-op rather than a rollback.
 *
 *  `nowSec` clamps each doc the same way `handleWrap`'s live CONFIG case
 *  does: a doc whose `issuedAt` is more than `MAX_ISSUED_AT_SKEW_SECS` in
 *  `nowSec`'s future is skipped (that one doc kind only — entries/children/
 *  the snapshot's other docs still merge normally). Defaults to `Infinity`
 *  (no clamp) for callers outside live wire delivery, e.g. onboarding's
 *  initial pair-offer snapshot accept, which has no live-attack surface of
 *  its own (the offer is already pinned to the QR-scanned guardian). */
export function applySnapshot(state: AppState, snapshot: PairingSnapshotPayload, nowSec: number = Infinity): AppState {
  let next = state
  for (const entry of snapshot.state.entries) next = addEntry(next, entry)
  for (const kind of DOC_KINDS) {
    const doc = snapshot.state.docs[kind]
    if (doc.issuedAt > nowSec + MAX_ISSUED_AT_SKEW_SECS) continue
    next = applyConfigDoc(next, kind, doc)
  }
  next = { ...next, children: mergeChildren(next.children, snapshot.state.children) }
  return next
}

/**
 * Folds a family root carried on a SNAPSHOT into state (v0.2 spec §1.5).
 *
 * This is the ONLY way a child that paired BEFORE its guardian connected My
 * Signet ever learns the root: there is no second pairing ceremony coming, and
 * the offer it did accept had no root on it.
 *
 * `authorPk` is the AUTHENTICATED seal author, and the SNAPSHOT direction
 * guard has already established that it is `state.guardianPubkey` — so this
 * verifies the attestation against exactly the same key `acceptPairOffer`
 * would, and gets the same security property: an attestation stolen from
 * another family is bound by challenge to THAT family's guardian key and fails
 * here.
 *
 * A root that does not verify is ignored in silence, and an absent root leaves
 * whatever is on record alone — a snapshot is a periodic, idempotent thing, so
 * neither case is news worth telling anyone about. Pure and total.
 */
function adoptRoot(state: AppState, root: RootAttestation | undefined, authorPk: string): AppState {
  if (root === undefined) return state
  if (!verifyRootAttestation(root.authEvent, root.pubkey, authorPk)) return state
  return { ...state, root: { kind: 'signet', pubkey: root.pubkey, authEvent: root.authEvent, backedUpAt: null } }
}

export type Effect =
  | { type: 'ack'; entryId: string; authorPk: string }
  /** A ledger entry that was NEWLY folded in (a re-delivered duplicate acks
   *  but does not re-fire this) — the hook Phase C's notifications and the
   *  guardian's child-activity view hang off. */
  | { type: 'entry'; entry: Entry; authorPk: string }
  /** A config doc that actually APPLIED (an LWW-dropped stale doc does not
   *  fire this) — schedulers and settings screens re-read on it. */
  | { type: 'config'; docKind: ConfigDocKind }
  /** This child device has been revoked by the guardian (v0.2 spec §4.5).
   *  `at` is the unix SECONDS the guardian recorded the revocation.
   *
   *  Fires exactly once, on the TRANSITION, and only off the APPLIED state —
   *  never off a doc the LWW dropped, and never again for a device already
   *  revoked. Handling it destroys key material, so it must agree with
   *  `state.ts#selfRevokedAt` (which App.tsx routes on) in every case. */
  | { type: 'revoked'; at: number }
  | { type: 'request'; payload: RequestPayload; authorPk: string }
  | { type: 'grant'; payload: GrantPayload }
  | { type: 'notify'; text: string }
  | { type: 'tick'; tick: ChoreTick; authorPk: string }
  | { type: 'audit'; audit: AuditResult; authorPk: string }
  /** A peer's heartbeat: ITS view of the ledger (v0.2 spec §2.2). A claim,
   *  not a fact — `sync/resync.ts#compareStatus` decides what to do about
   *  it, and nothing here folds any of it into state. */
  | { type: 'status'; payload: StatusPayload; authorPk: string }
  /** A peer asking to be sent what it is missing, resuming after `since`
   *  (null = everything we have). Answered with `resyncPage`. */
  | { type: 'resyncRequest'; since: string | null; authorPk: string }
  /** One page of RAW SIGNED inner events a peer is replaying to us. NOTHING
   *  in it is trusted until `sync/resync.ts#ingestResyncEvents` has verified
   *  each signature and checked each author. */
  | { type: 'resyncReply'; payload: ResyncReplyPayload; authorPk: string }

/**
 * Unwraps `wrap` (pinned to `pinnedPeerPk`) and dispatches by inner kind:
 *   ENTRY      -> addEntry (assertEntry inside) + an 'ack' effect, carrying
 *                 the authenticated authorPk (which peer to route the ack
 *                 back to — see the 'ack' effect's doc comment)
 *   CONFIG     -> applyConfigDoc (LWW by issuedAt, anti-rollback);
 *                 guardian -> child only (see the direction guard below)
 *   ACK        -> recorded into state.acks
 *   CHILD_SIG  -> tick/audit appended, deduped by id, PLUS a 'tick'/'audit'
 *                 effect carrying authorPk provenance (state mutation itself
 *                 is unchanged — see the case's comment)
 *   SNAPSHOT   -> a `snapshot` sub-payload merges into state (see
 *                 applySnapshot); a `checkpoint` sub-payload carries no
 *                 entries/docs to merge, so it surfaces as a 'notify' effect
 *                 instead, for the app layer to reconcile/audit against;
 *                 guardian -> child only (see the direction guard below)
 *   REQUEST    -> surfaced as a 'request' effect (spend.request,
 *                 allowance.claim — NOT pair.claim, see module header)
 *   GRANT      -> surfaced as a 'grant' effect; guardian -> child only (see
 *                 the direction guard below)
 *   anything else (including PAIR_OFFER, which belongs to the pairing
 *   accept flow, not this dispatcher) -> ignored silently, forward-compat
 *
 * Direction guard (CONFIG/SNAPSHOT/GRANT): these three wire kinds are
 * guardian -> child only (see wire/kinds.ts). `handleWrap` itself is generic
 * over which side calls it, so without this check a hostile or buggy CHILD
 * sending one of these three would be applied by the GUARDIAN exactly as if
 * the guardian had sent it to itself. On CONFIG/SNAPSHOT that's a
 * `docHighWater` poison: `docHighWater` is monotonic and never resets, so a
 * single doc with `issuedAt: Number.MAX_SAFE_INTEGER` would permanently
 * block every real guardian CONFIG for that doc kind thereafter. The guard
 * is `unwrapped.authorPk === state.guardianPubkey`: on the child,
 * `pinnedPeerPk` IS the guardian, and `unwrapFrom` already bound
 * `unwrapped.authorPk` to `pinnedPeerPk` before returning non-null, so this
 * passes trivially there; on the guardian, `state.guardianPubkey` is the
 * guardian's OWN key, which a child author's key can never equal, so it's
 * dropped. A wrap failing this guard is ignored exactly like an unrecognised
 * inner kind — `state` unchanged (the event id is still marked seen, since
 * the wrap itself was a legitimately verified signed event from the pinned
 * peer; only its kind-specific effect is refused).
 *
 * issuedAt clamp (CONFIG/SNAPSHOT): even from the legitimate guardian, a doc
 * whose `issuedAt` is more than `MAX_ISSUED_AT_SKEW_SECS` ahead of `nowSec`
 * is ignored — see `MAX_ISSUED_AT_SKEW_SECS`'s doc comment for why this
 * matters independently of the direction guard (a compromised or buggy
 * guardian is a smaller threat model, but the anti-rollback mechanism is
 * exactly as fragile against a bad timestamp from either side).
 *
 * Total: an unverifiable wrap, or a payload that fails its kind's total
 * parser, drops the event and returns `state` unchanged rather than
 * throwing. Event-id dedupe via `state.seenEventIds` makes re-delivery of
 * the exact same wrap (a late-subscriber replay, a relay rebroadcast) an
 * explicit no-op on top of each branch's own idempotence.
 */
export function handleWrap(
  state: AppState,
  wrap: NostrEvent,
  selfSk: Uint8Array,
  pinnedPeerPk: string,
  nowSec: number,
): { state: AppState; effects: Effect[] } {
  if (state.seenEventIds.includes(wrap.id)) return { state, effects: [] }

  const unwrapped = unwrapFrom({ wrap, recipientSk: selfSk, expectedAuthorPk: pinnedPeerPk })
  if (unwrapped === null) return { state, effects: [] }

  const dispatched = dispatchInner(state, unwrapped.innerKind, unwrapped.payload, unwrapped.authorPk, nowSec)
  // A deferred refusal (see `DispatchResult`) leaves the wrap un-seen and
  // un-retained, so the same wrap delivered again later is tried again.
  if (dispatched.deferred === true) return { state, effects: [] }
  const seen = markSeen(dispatched.state, wrap.id)

  // The lossless corpus (v0.2 spec §2.3) — stored REGARDLESS of whether the
  // payload parses, so an event minted by a newer build survives this build's
  // older parser and can still be handed on to a third device that does
  // understand it, but NOT when the direction guard refused the event (see
  // `retainsInnerEvent`). Keyed by the inner event id; bounded by
  // `retainInnerEvents` on every insert.
  if (!retainsInnerEvent(seen, unwrapped.innerKind, unwrapped.authorPk)) return { state: seen, effects: dispatched.effects }

  const next: AppState = {
    ...seen,
    innerEvents: retainInnerEvents({
      ...seen.innerEvents,
      [unwrapped.inner.id]: toStoredEvent(unwrapped.inner),
    }),
  }
  return { state: next, effects: dispatched.effects }
}

/** What `dispatchInner` did with one inner payload.
 *
 *  `deferred` marks a refusal that is about WHEN, not WHAT: a CONFIG beyond
 *  the receiver's clock skew window, or an ENTRY/CHILD_SIG naming an account
 *  or chore whose policy doc has not arrived yet. The caller must then leave
 *  the carrying event un-seen and un-retained, so a later redelivery or
 *  replay can still fold it (audit P3). `state` is the input, by reference. */
export interface DispatchResult {
  state: AppState
  effects: Effect[]
  deferred?: true
}

/** Whether a CHILD_SIG is the signer's own to make (audit P8). Pure. */
function childSigBinding(
  state: AppState,
  parsed: NonNullable<ReturnType<typeof parseChildSigPayload>>,
  authorPk: string,
): 'ok' | 'refused' | 'deferred' {
  if (authorPk === state.guardianPubkey) return 'refused'
  if (parsed.kind === 'tick') {
    const chore = state.docs.chores.chores.find((c) => c.id === parsed.tick.chore)
    if (chore === undefined) return 'deferred'
    return chore.child === authorPk ? 'ok' : 'refused'
  }
  const audit = parsed.audit
  if (audit.child !== authorPk || audit.author !== 'child') return 'refused'
  const account = state.docs.accounts.accounts.find((a) => a.id === audit.account)
  if (account === undefined) return 'deferred'
  return account.child === authorPk ? 'ok' : 'refused'
}

/**
 * The fold itself, split out of `handleWrap` (v0.2 spec §2.4) so that live
 * wire traffic and `sync/resync.ts`'s verified ingest of replayed events share
 * ONE verification-and-fold path rather than drifting apart — a second
 * implementation of these guards is exactly the kind of duplication that ends
 * with the replay path quietly missing one of them.
 *
 * `authorPk` must always be an AUTHENTICATED author: the seal author of the
 * wrap that carried this payload (`handleWrap`), or the verified `ev.pubkey`
 * of a signature-checked replayed event (`ingestResyncEvents`). Never
 * anything read out of the payload.
 *
 * Pure and total: an unrecognised kind, a payload that fails its total
 * parser, or a payload refused by a guard returns `state` unchanged (the same
 * reference, so callers can detect a no-op with `===`) and no effects, never
 * a throw.
 */
export function dispatchInner(
  state: AppState,
  innerKind: number,
  payload: unknown,
  authorPk: string,
  nowSec: number,
): DispatchResult {
  let next = state
  const effects: Effect[] = []
  // `nowSec` gates the CONFIG/SNAPSHOT issuedAt clamp below (see
  // MAX_ISSUED_AT_SKEW_SECS). Beyond that, receive-side freshness/replay
  // windows are deliberately deferred (see wire/giftwrap.ts's header
  // comment) — event-id dedupe in handleWrap is today's only general
  // anti-replay measure at this layer.

  switch (innerKind) {
    case KIND_ENTRY: {
      const parsed = parseEntryPayload(payload)
      // Provenance guard (audit P1, superseding fix round 2's I2). ENTRY is
      // guardian-authored ONLY. No production flow has a child author one —
      // a child's spend travels as a REQUEST and comes back as the guardian's
      // own ENTRY — and the old "author IS the child it names" rule still let
      // a child mint a `credit` to itself, label it `author: 'guardian'`, or
      // put a leg on a sibling's account. On the guardian that means every
      // live ENTRY is refused (a child is the only other party); on a child it
      // is exactly the pinned guardian.
      //
      // Refused exactly like an unparseable payload — `state` returned by
      // reference, no effects, and no ack: acking would confirm to the
      // sender an entry that was never folded, and the resync path (which
      // detects a no-op by `===` and empty effects) counts it as a
      // rejection for free.
      if (parsed === null || state.guardianPubkey === null || authorPk !== state.guardianPubkey) break
      // Even the guardian's own entries must bind to the accounts doc: every
      // leg on an account that exists, belongs to `entry.child`, and is in
      // the leg's currency. An account we do not know YET is the ordinary
      // out-of-order case (the ENTRY overtook the accounts CONFIG that
      // created it), so the refusal is DEFERRED: the carrying wrap is not
      // marked seen, and a later redelivery or replay folds it once the doc
      // has arrived.
      try {
        assertEntryAgainst(state.docs.accounts.accounts, parsed.entry)
      } catch {
        return { state, effects: [], deferred: true }
      }
      if (parsed !== null) {
        const before = next
        next = addEntry(next, parsed.entry)
        // authorPk provenance: in a multi-peer engine (sync/multi.ts) the
        // guardian talks to N children over ONE subscription, so the ack
        // must be routed back to whichever peer actually sent this ENTRY,
        // not to a single pinned peer — see multi.ts's header.
        effects.push({ type: 'ack', entryId: parsed.entry.id, authorPk })
        // The ack is unconditional (the peer needs one even for an entry we
        // already hold, or it will keep retrying); the `entry` effect is
        // not, because its consumers — notifications, activity feeds — must
        // not fire twice for one entry that arrived twice.
        if (next !== before) effects.push({ type: 'entry', entry: parsed.entry, authorPk })
      }
      break
    }
    case KIND_CONFIG: {
      // Direction guard — see handleWrap's header comment.
      if (authorPk !== state.guardianPubkey) break
      const parsed = parseConfigPayload(payload)
      if (parsed !== null) {
        const doc = parsed.doc as { issuedAt: number }
        // issuedAt clamp — see handleWrap's header comment.
        // Beyond the clamp the doc is DEFERRED rather than dropped (audit
        // P3): the refusal is about the receiver's clock, not the doc, so the
        // carrying wrap must stay un-seen and deliverable once the clock has
        // caught up.
        if (doc.issuedAt > nowSec + MAX_ISSUED_AT_SKEW_SECS) return { state, effects: [], deferred: true }
        {
          const before = next
          switch (parsed.docKind) {
            case 'accounts':
              next = applyConfigDoc(next, 'accounts', parsed.doc as ConfigDocs['accounts'])
              break
            case 'allowance':
              next = applyConfigDoc(next, 'allowance', parsed.doc as ConfigDocs['allowance'])
              break
            case 'interest':
              next = applyConfigDoc(next, 'interest', parsed.doc as ConfigDocs['interest'])
              break
            case 'chores':
              next = applyConfigDoc(next, 'chores', parsed.doc as ConfigDocs['chores'])
              break
          }
          // Only when the doc actually applied — applyConfigDoc returns the
          // very same state for a doc its anti-rollback LWW dropped.
          if (next !== before) effects.push({ type: 'config', docKind: parsed.docKind })
          // Unpair / revoke (v0.2 spec §4.5): the accounts doc is where the
          // guardian records that a child device is no longer part of the
          // family, so a child reading its OWN pubkey there has just been
          // signed out. Checked against `state.self.pubkey`, never anything
          // the payload names, and only on a child — on the guardian this
          // map is simply its own record of who it has removed.
          //
          // Read off the APPLIED state (`next`), never off `parsed.doc` (fix
          // round 1). The store's handler wipes the key and clears the PIN,
          // while App.tsx routes to Unpaired off `state.ts#selfRevokedAt`,
          // which reads the applied doc — so if a doc the LWW DROPPED could
          // still fire this effect, the device would lose its key while its
          // state still said "paired" and land on ChildLock asking for a PIN
          // that no longer exists, with no way forward. Deriving both from
          // the same applied state makes that disagreement unrepresentable.
          //
          // `before` gates it to the TRANSITION: a device already revoked in
          // its own state must not re-wipe on every later policy doc.
          if (parsed.docKind === 'accounts' && state.role === 'child' && state.self.pubkey !== null) {
            const selfPk = state.self.pubkey
            const wasRevoked = before.docs.accounts.revoked?.[selfPk] !== undefined
            const revokedAt = next.docs.accounts.revoked?.[selfPk]
            if (!wasRevoked && revokedAt !== undefined) effects.push({ type: 'revoked', at: revokedAt })
          }
        }
      }
      break
    }
    case KIND_ACK: {
      const parsed = parseAckPayload(payload)
      if (parsed !== null) {
        next = { ...next, acks: { ...next.acks, [parsed.entryId]: parsed.ts } }
      }
      break
    }
    case KIND_CHILD_SIG: {
      const parsed = parseChildSigPayload(payload)
      if (parsed !== null) {
        // authorPk provenance (as for ENTRY/ack above): a multi-peer
        // guardian has no other way to know which child actually signed a
        // given tick/audit — the domain types (ChoreTick/AuditResult) carry
        // no author field of their own, only a `chore`/`account` id, so
        // without this the app layer could not tell a legitimate tick from
        // one child apart from a forged one claiming another child's chore.
        // State mutation (append, deduped by id) is unchanged from before.
        //
        // The EFFECT is gated on the fold having actually happened (review
        // fix, round 1) — exactly as the ENTRY case gates its `entry`
        // effect. Firing on a tick we already hold means a resync replay of
        // an aged-out CHILD_SIG re-notifies a guardian about a chore ticked
        // last week. Unlike ENTRY there is no separate ack to keep sending,
        // so there is nothing left that needs the ungated version.
        //
        // Binding (audit P8): a child signs for ITSELF only. A tick must be
        // on a chore the chores doc gives to the signer; an audit
        // must name the signer as its child and author 'child', on an account
        // the signer owns. Otherwise one child could tick a sibling's chores
        // (satisfying the sibling's chore gate) or post a 'guardian' audit on
        // a sibling's account (resetting its reconcile baseline). A chore or
        // account we do not know yet is deferred, as for ENTRY: the policy
        // doc may simply not have arrived.
        const binding = childSigBinding(state, parsed, authorPk)
        if (binding === 'deferred') return { state, effects: [], deferred: true }
        if (binding === 'refused') break
        if (parsed.kind === 'tick') {
          if (!next.ticks.some((t) => t.id === parsed.tick.id)) {
            next = { ...next, ticks: [...next.ticks, parsed.tick] }
            effects.push({ type: 'tick', tick: parsed.tick, authorPk })
          }
        } else if (!next.audits.some((a) => a.id === parsed.audit.id)) {
          next = { ...next, audits: [...next.audits, parsed.audit] }
          effects.push({ type: 'audit', audit: parsed.audit, authorPk })
        }
      }
      break
    }
    case KIND_SNAPSHOT: {
      // Direction guard — see handleWrap's header comment. Covers both the
      // 'snapshot' and 'checkpoint' sub-payloads carried under this kind.
      if (authorPk !== state.guardianPubkey) break
      const parsed = parseSnapshotOrCheckpointPayload(payload)
      if (parsed !== null) {
        if (parsed.kind === 'snapshot') {
          // issuedAt clamp applied per-doc inside applySnapshot — see its
          // doc comment and handleWrap's header comment.
          next = applySnapshot(next, parsed, nowSec)
          next = adoptRoot(next, parsed.root, authorPk)
        } else {
          effects.push({ type: 'notify', text: `checkpoint received: lastEntryId=${parsed.lastEntryId}, ts=${parsed.ts}` })
        }
      }
      break
    }
    case KIND_STATUS: {
      // Heartbeat and resync traffic (v0.2 spec §2.2). Deliberately state-
      // FREE: everything here is a peer's own account of itself, and the
      // only thing this dispatcher does with a claim is hand it up. The
      // reply page in particular carries raw events from a possibly hostile
      // peer — folding any of it in HERE would bypass the signature and
      // author checks that make a replay safe (spec §2.4), so it goes out
      // as an effect and comes back through `ingestResyncEvents`.
      //
      // No direction guard: both directions legitimately send all three
      // types (a child heartbeats, either side asks for and serves a
      // replay). The authorisation that matters is per-EVENT, at ingest.
      const parsed = parseStatusKindPayload(payload)
      if (parsed !== null) {
        if (parsed.type === 'status') effects.push({ type: 'status', payload: parsed, authorPk })
        else if (parsed.type === 'resync.request') effects.push({ type: 'resyncRequest', since: parsed.since, authorPk })
        else effects.push({ type: 'resyncReply', payload: parsed, authorPk })
      }
      break
    }
    case KIND_REQUEST: {
      const parsed = parseRequestPayload(payload)
      if (parsed !== null) effects.push({ type: 'request', payload: parsed, authorPk })
      break
    }
    case KIND_GRANT: {
      // Direction guard — see handleWrap's header comment.
      if (authorPk !== state.guardianPubkey) break
      const parsed = parseGrantPayload(payload)
      if (parsed !== null) effects.push({ type: 'grant', payload: parsed })
      break
    }
    default:
      // Unknown inner kind (incl. PAIR_OFFER) -> ignored silently, forward-compat.
      break
  }

  return { state: next, effects }
}

// --- Guardian-only: pair.claim intake (no pin yet) --------------------------

/** Synchronous, storage-agnostic seam for wherever the guardian keeps its
 *  single live pairing token. `clear()` must be synchronous and actually
 *  drop the token — see `handlePairClaimWrap`'s atomicity note below. */
export interface PairTokenStore {
  get(): MintedToken | null
  clear(): void
}

export interface HandlePairClaimWrapOpts {
  wrap: NostrEvent
  guardianSk: Uint8Array
  tokenStore: PairTokenStore
  mnemonic: string
  childIndex: number
  childName: string
  snapshot: PairingSnapshotPayload
  relays: string[]
  /** The family's My Signet root, if any (v0.2 spec §1.5). */
  root?: RootAttestation
  nowSec: number
}

/**
 * Guardian-side intake for a `pair.claim` REQUEST. Unwraps WITHOUT
 * `expectedAuthorPk` (there is no peer to pin yet — the claiming device's
 * key is exactly what pairing is establishing; `answerPairClaim` itself
 * checks the claim's self-reported `devicePk` against the AUTHENTICATED seal
 * author, so nothing here trusts an unauthenticated value).
 *
 * THE carried security obligation (Task 6 review, progress.md): `consumeToken`
 * is checked and — on success — the stored token is cleared in the very next
 * statement, before `answerPairClaim` is reached and before any `await`
 * anywhere in this function (there isn't one: this whole function is
 * synchronous). That ordering is what makes single-use atomic: a false
 * result returns `null` immediately, so no offer is ever built and nothing
 * is ever sent; a true result can only be produced once per stored token,
 * because the token is gone from the store before this function returns
 * control to anything else that could re-enter it.
 */
export function handlePairClaimWrap(opts: HandlePairClaimWrapOpts): AnsweredPairClaim | null {
  const unwrapped = unwrapFrom({ wrap: opts.wrap, recipientSk: opts.guardianSk })
  if (unwrapped === null || unwrapped.innerKind !== KIND_REQUEST) return null

  const claim = parseRequestPayload(unwrapped.payload)
  if (claim === null || claim.op !== 'pair.claim') return null

  const params = claim.params as { token?: unknown }
  const presented = typeof params.token === 'string' ? params.token : ''

  // THE hard gate — see header comment. `answerPairClaim` must not be
  // reachable below this point unless `ok` is true.
  const stored = opts.tokenStore.get()
  const ok = consumeToken(stored, presented, opts.nowSec)
  if (ok) opts.tokenStore.clear()
  if (!ok) return null

  return answerPairClaim({
    claim,
    sealAuthorPk: unwrapped.authorPk,
    mnemonic: opts.mnemonic,
    childIndex: opts.childIndex,
    childName: opts.childName,
    snapshot: opts.snapshot,
    relays: opts.relays,
    ...(opts.root !== undefined ? { root: opts.root } : {}),
  })
}

// --- Child-only: PAIR_OFFER intake (pin to the QR-scanned guardian) --------

export interface HandlePairOfferWrapOpts {
  wrap: NostrEvent
  /** The claiming device's own secret key — used to unwrap the offer. */
  deviceSk: Uint8Array
  /** The guardian pubkey read out of the scanned QR (`pairing.ts#parsePairQr`'s
   *  `guardianPk`) — NOT anything read out of the wrap or offer payload
   *  itself. This is what makes the unwrap's authentication meaningful: the
   *  claiming device pins the guardian identity it scanned, and the offer is
   *  only accepted if whoever actually signed it matches that pin. */
  expectedGuardianPk: string
}

/**
 * Child-side production intake for a guardian's `PAIR_OFFER`. Unwraps WITH
 * `expectedAuthorPk: opts.expectedGuardianPk` — the QR-scanned guardian
 * pubkey — so an offer sealed by anyone else is rejected by `unwrapFrom`
 * itself before this function ever looks at its contents (the same
 * "authenticate first, read after" shape as `handleWrap`'s `pinnedPeerPk`,
 * just for the one kind that has to work before a pin exists in `AppState`).
 * The unwrapped inner kind must be `KIND_PAIR_OFFER`; its payload is parsed
 * with `parsePairOfferPayload`'s total parser. Total: an unverifiable wrap,
 * an unwrapped event of any other kind, or a payload that fails the parser
 * all yield `null`, never a throw.
 *
 * This only produces the payload — turning it into a new `AppState` (pinning
 * `guardianPk`, setting `role: 'child'`, merging the snapshot) is
 * `state/onboarding.ts#startAsChildFromOffer`'s job, via
 * `pairing.ts#acceptPairOffer` (which re-derives the same authenticated
 * author from the caller's own unwrap, so callers of THIS function must pass
 * that same `expectedGuardianPk`/`sealAuthorPk` on to `acceptPairOffer`
 * rather than trusting anything the offer itself claims).
 */
export function handlePairOfferWrap(opts: HandlePairOfferWrapOpts): PairOfferPayload | null {
  const unwrapped = unwrapFrom({
    wrap: opts.wrap,
    recipientSk: opts.deviceSk,
    expectedAuthorPk: opts.expectedGuardianPk,
  })
  if (unwrapped === null || unwrapped.innerKind !== KIND_PAIR_OFFER) return null

  return parsePairOfferPayload(unwrapped.payload)
}
