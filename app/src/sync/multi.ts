// The guardian's multi-peer sync engine — see
// internal plan 2026-08-11-parent-mode, Task 2, and the Plan 2
// carry-forwards ("Engine is single-peer; guardian-with-N-children UI needs
// a multi-peer shape").
//
// `sync/engine.ts#startSync` is pinned to exactly ONE peer (`pinnedPeerPk`):
// fine for a child device (which only ever talks to its one guardian), not
// fine for the guardian, who talks to every one of their children over the
// SAME relay subscription. This module is that guardian-side engine:
//
//   - ONE subscription (`kinds: [WRAP], '#p': [selfPk]`) — not one per
//     child. A relay-visible guardian pubkey already reveals guardian-ness;
//     N separate subscriptions for the same filter would add relay chatter
//     for zero benefit.
//   - Every delivered wrap is unwrapped WITHOUT a pin first (`unwrapFrom`
//     with no `expectedAuthorPk`) purely to learn who signed it, then
//     membership-checked (`authorPk ∈ peerPks`) BEFORE any state mutation.
//     This is deliberately equivalent security to `engine.ts`'s single
//     fixed pin, not a weaker substitute for it: a wrap whose authenticated
//     author isn't a known child is worth exactly as little to this module
//     as a wrap that fails signature verification outright, and neither
//     ever reaches `handleWrap`. Once membership passes, the actual
//     dispatch is delegated straight to `ingress.ts#handleWrap` — passing
//     the now-authenticated `authorPk` itself as that call's `pinnedPeerPk`
//     re-derives the identical unwrap trivially (the author obviously
//     matches itself), so all of `handleWrap`'s existing, already-tested
//     dispatch/direction-guard/clamp logic applies unchanged per sender.
//   - The one legitimate reason a wrap's author is NOT (yet) a member is an
//     unclaimed device's `pair.claim` — routed synchronously to
//     `ingress.ts#handlePairClaimWrap` (no `await` in front of it, matching
//     that function's own single-use-atomicity requirement), but ONLY while
//     the caller reports an active pairing session (`getPairingSession`).
//     No session -> the claim is silently dropped, same as any other
//     non-member traffic: this module never reveals whether a pairing
//     ceremony is in progress to an unauthenticated prober.
//   - Outbox flush ownership (Plan 2 carry-forward: "nothing drains the
//     outbox except a new send"): this module flushes once at `start()` and
//     again after every batch of member traffic it processes (deferred until
//     any acks that batch triggered have themselves settled — see the
//     member branch below for why). A successfully-answered pair-claim does
//     NOT get its own explicit flush call here: the caller's
//     `onPairClaimAnswered` handler is expected to send the PAIR_OFFER via
//     `publish.ts#sendPairOffer`, which already flushes internally, so an
//     extra call here would only race it. See `STALE_SWEEP_SECS`'s note in
//     wire/outbox.ts for why a flush against an empty queue is cheap.
//   - Auto-ack, same shape as engine.ts: fire-and-forget with `.catch`, now
//     addressed using the effect's own `authorPk` (see ingress.ts's ENTRY
//     case) rather than a single fixed peer.
//   - `setState` takes a FUNCTIONAL updater, `(app: AppState) => AppState`,
//     never a precomputed `AppState` — this is load-bearing, not a style
//     choice. `getState()`/`setState()` are backed by a React ref/reducer on
//     the caller's side (store.tsx), and relay delivery can call this
//     module's subscription callback for a SECOND wrap before the FIRST
//     wrap's `setState` call has actually been reflected back through
//     `getState()` (React batches/defers when a dispatched update is
//     actually applied). If this module precomputed `next` once via
//     `handleWrap(getState(), ...)` and handed that whole value to
//     `setState`, a second wrap processed in that same window would compute
//     ITS `next` from the exact same stale `getState()` snapshot and then
//     overwrite the first wrap's update entirely — silently losing an
//     entry, both in memory and (since persistence is driven off the same
//     state) on disk. Passing an updater instead makes wherever `setState`
//     is actually implemented the single accumulation point: `handleWrap`
//     is total and side-effect-free, so re-running it fresh against
//     whichever `app` the updater is eventually invoked with (the TRUE
//     current state at that moment, guaranteed by the caller's reducer) is
//     always correct, however many wraps landed in between. Persistence is
//     NOT this module's job either way — see the `getState`/`setState` doc
//     comments below.

import { getPublicKey } from 'nostr-tools/pure'
import type { NostrEvent } from 'nostr-tools/pure'
import { unwrapFrom } from '../wire/giftwrap'
import { WRAP } from '../wire/kinds'
import type { RelayLike } from '../wire/relayClient'
import type { StorageLike } from '../wire/outbox'
import { flush } from '../wire/outbox'
import type { RootAttestation, SnapshotPayload } from '../wire/payloads'
import type { AppState } from '../state/types'
import { handlePairClaimWrap, handleWrap, type Effect, type PairTokenStore } from './ingress'
import type { AnsweredPairClaim } from '../pairing/pairing'
import { sendAck } from './publish'

/** Everything `handlePairClaimWrap` needs beyond the wrap itself, supplied
 *  by whichever screen currently has a pairing ceremony open (Task 3's
 *  PairDevice screen, via store.tsx). `null`/absent from
 *  `StartGuardianSyncOpts.getPairingSession` means "no ceremony in
 *  progress" — every `pair.claim` is then dropped unconditionally. */
export interface PairingSession {
  tokenStore: PairTokenStore
  mnemonic: string
  childIndex: number
  childName: string
  snapshot: SnapshotPayload
  relays: string[]
  /** The family's My Signet root, if any (v0.2 spec §1.5) — decorates the
   *  offer this session answers with. */
  root?: RootAttestation
}

export interface StartGuardianSyncOpts {
  /** The guardian's own secret key — subscribes for wraps addressed to its
   *  pubkey, unwraps as recipient, and signs every auto-ack. */
  selfSk: Uint8Array
  /** The membership set: every currently-known child's pubkey. A wrap
   *  authored by anyone outside this set is never mutated into state — see
   *  module header. Callers restart this engine (a fresh `startGuardianSync`
   *  call) when the child list changes; this module takes a snapshot of
   *  `peerPks` at `start()` and does not watch for later mutation of the
   *  array in place. */
  peerPks: string[]
  relay: RelayLike
  /** This device's durable outbox storage (`sendAck`'s enqueue/flush) — NOT
   *  used for `AppState` persistence, which this module deliberately never
   *  performs itself (see `setState`'s doc comment: persistence belongs to
   *  whatever owns the reducer this module's updates flow through — one
   *  authoritative path, store.tsx's own effect on `state.app`, rather than
   *  this module racing it with a second `saveState` call of its own). */
  storage: StorageLike
  /** Must return the CURRENT app state at call time (a live read, e.g. of a
   *  ref mirroring React state — never a value captured once and reused).
   *  Used here only to compute `effects` for driving acks/`onEffect` (see
   *  the member branch below for why that's safe even from a
   *  possibly-microtask-stale snapshot); the actual ledger fold never
   *  trusts this directly — see `setState`. */
  getState: () => AppState
  /** Applies `update` to whatever the CALLER's own accumulation point
   *  considers the CURRENT app to be at the moment `update` actually runs —
   *  see this module's header for why that must NOT be "whatever `getState`
   *  happened to return when this wrap arrived". A React reducer action
   *  carrying `update` as its payload (`{ type: 'updateApp', update }`,
   *  applied as `{ ...state, app: update(state.app) }`) is the intended
   *  shape — see store.tsx. */
  setState: (update: (app: AppState) => AppState) => void
  /** Every effect other than 'ack' (auto-sent) is handed here — same
   *  contract as engine.ts. */
  onEffect: (effect: Effect) => void
  /** The active pairing ceremony, if any — see `PairingSession`'s doc. */
  getPairingSession?: () => PairingSession | null
  /** Called synchronously with a successfully-answered pair.claim (token
   *  consumed, identity bound) so the caller can register the new child,
   *  send the PAIR_OFFER, and close the pairing UI. Never called for a
   *  rejected/expired/mismatched claim. */
  onPairClaimAnswered?: (answered: AnsweredPairClaim) => void
  /** Defaults to wall-clock seconds; tests inject a fixed/controlled clock. */
  nowSec?: () => number
}

/**
 * Subscribes once for every gift-wrapped event addressed to the guardian's
 * own pubkey, dispatches each through the membership-checked flow described
 * in this module's header (accumulating via the caller's own `setState`
 * updater, never persisting anything itself — see `storage`'s doc comment),
 * auto-acks, and surfaces everything else via `onEffect`/`onPairClaimAnswered`.
 * Returns a stop function.
 */
export function startGuardianSync(opts: StartGuardianSyncOpts): () => void {
  const selfPk = getPublicKey(opts.selfSk)
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000))
  const memberPks = new Set(opts.peerPks)

  // Flush on start — see module header ("outbox flush ownership").
  void flush(opts.relay, nowSec(), opts.storage).catch(() => {})

  const unsubscribe = opts.relay.subscribe({ kinds: [WRAP], '#p': [selfPk] }, (wrap: NostrEvent) => {
    const now = nowSec()

    // Unwrap UNPINNED, purely to learn the authenticated author — no state
    // mutation happens before the membership check below. A wrap that fails
    // to unwrap at all (bad decrypt, bad shape, bad signature) can never be
    // a legitimate member's traffic NOR a legitimate pair.claim (both paths
    // below would fail the exact same unwrap independently), so it is
    // dropped outright.
    const probe = unwrapFrom({ wrap, recipientSk: opts.selfSk })
    if (probe === null) return

    if (memberPks.has(probe.authorPk)) {
      const authorPk = probe.authorPk

      // `effects` are computed once, eagerly, from whatever `getState()`
      // returns right now — safe DESPITE the staleness hazard described in
      // this module's header, because every effect-producing branch of
      // `handleWrap` derives its payload purely from the WRAP itself (see
      // ingress.ts): an 'ack' carries the entry id the wrap named, a
      // 'request'/'grant'/'tick'/'audit' carries the wrap's own parsed
      // payload, none of it read back out of `state`. The one exception —
      // CONFIG/SNAPSHOT/GRANT's direction guard, keyed on
      // `state.guardianPubkey` — can never itself be "stale between one
      // snapshot and the next" because that field is fixed for the whole
      // lifetime of a guardian session. So effects are fine to read from a
      // possibly-microtask-stale snapshot; the LEDGER itself is not (see
      // below).
      const { effects } = handleWrap(opts.getState(), wrap, opts.selfSk, authorPk, now)

      // The ledger fold MUST re-run fresh against whatever the caller's
      // accumulation point considers current AT THE MOMENT this update is
      // actually applied — see this module's header and `setState`'s doc
      // comment. `handleWrap` is total/side-effect-free, so re-invoking it
      // here (a second time, against a possibly-different `app` than the
      // one `effects` above was read from) is exactly as safe as calling it
      // once — its own `seenEventIds` dedupe and `addEntry`/`applyConfigDoc`
      // idempotence make a stale-vs-fresh `app` difference a no-op in the
      // overwhelmingly common case, and the ONLY case it isn't a no-op
      // (another wrap landed in between) is precisely the case this
      // indirection exists to get right.
      opts.setState((app) => handleWrap(app, wrap, opts.selfSk, authorPk, now).state)

      // Each ack's own `sendAck` (publish.ts) already enqueues-then-flushes
      // internally, so tracking these promises isn't for their own sake —
      // it lets the post-batch flush below WAIT for them rather than racing
      // them: `wire/outbox.ts#flush` reads its queue snapshot at call time,
      // so two flush() calls in flight at once can both read the same
      // still-queued item and both publish it (dedup only happens at
      // removal). Awaiting every ack send first guarantees the batch flush
      // only ever sees outbox state these acks have already settled.
      const ackSends: Promise<unknown>[] = []
      for (const effect of effects) {
        if (effect.type === 'ack') {
          // Fire-and-forget from the caller's point of view (nothing useful
          // to do differently on failure — the outbox already durably
          // queues it), but an unhandled rejection is a distinct failure
          // mode of its own — catch and swallow, same as engine.ts.
          ackSends.push(
            sendAck(effect.entryId, {
              selfSk: opts.selfSk,
              peerPk: effect.authorPk,
              relay: opts.relay,
              storage: opts.storage,
              nowSec: now,
            }).catch(() => {}),
          )
        } else {
          opts.onEffect(effect)
        }
      }

      void Promise.allSettled(ackSends).then(() => flush(opts.relay, now, opts.storage).catch(() => {}))
      return
    }

    // Not a known member — the ONLY legitimate reason is an unclaimed
    // device's pair.claim, and only while a pairing ceremony is open.
    const session = opts.getPairingSession?.() ?? null
    if (session === null) return

    // Synchronous, no `await` before it — `handlePairClaimWrap` itself is
    // the carried single-use-atomicity obligation (see ingress.ts); calling
    // it from inside this delivery callback with nothing in between
    // preserves that.
    const answered = handlePairClaimWrap({
      wrap,
      guardianSk: opts.selfSk,
      tokenStore: session.tokenStore,
      mnemonic: session.mnemonic,
      childIndex: session.childIndex,
      childName: session.childName,
      snapshot: session.snapshot,
      relays: session.relays,
      ...(session.root !== undefined ? { root: session.root } : {}),
      nowSec: now,
    })
    if (answered !== null) {
      // No explicit flush call here: the caller's `onPairClaimAnswered`
      // handler is expected to send the PAIR_OFFER via `publish.ts#sendPairOffer`,
      // which already enqueues-then-flushes internally (same as every other
      // `publish.ts` helper) — an extra flush call from this module racing
      // that one would risk the same double-publish this module's member
      // branch avoids by awaiting its own sends first (see above); there is
      // nothing else in this branch left to drain.
      opts.onPairClaimAnswered?.(answered)
    }
  })

  return unsubscribe
}
