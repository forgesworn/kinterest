// Small orchestrator gluing relay subscribe -> ingress -> effect execution.
// See internal plan 2026-08-10-wire-identity-pairing, Task 7, and
// internal plan 2026-08-11-child-mode, Task 1 (the functional-
// updater refactor below). Deliberately thin: UI plans (3-4) drive it,
// decide what to do with non-ack effects (surfacing spend/allowance/
// pair-claim requests to a guardian's review screen, grants to a child's
// notification feed, etc.), and own the guardian-only `pair.claim` intake
// path (ingress.ts's `handlePairClaimWrap`) — that path isn't wired in here
// because it needs guardian-specific inputs (mnemonic, next child index, a
// token store) this generic single-peer engine doesn't have.
//
// This is the single-peer sibling of `sync/multi.ts` (the guardian's
// multi-peer engine) — a child device only ever talks to its one guardian,
// so it keeps the single `pinnedPeerPk` shape `ingress.ts#handleWrap` was
// originally built around, rather than multi.ts's membership-checked
// unpinned-probe dance. Task 1's refactor brings it up to the SAME two
// disciplines multi.ts already established, for the SAME reasons (see that
// module's header for the full argument):
//   - `setState` takes a FUNCTIONAL updater, `(app: AppState) => AppState`,
//     never a precomputed `AppState`. Relay delivery can invoke this
//     module's subscription callback for a SECOND wrap before the FIRST
//     wrap's `setState` call has actually been reflected back through
//     `getState()` (a React reducer batches/defers when a dispatched update
//     is actually applied) — precomputing `next` once via `handleWrap
//     (getState(), ...)` and handing that whole value to `setState` would
//     let a second wrap in the same window compute ITS `next` from the exact
//     same stale snapshot and overwrite the first wrap's update outright.
//     Passing an updater instead makes wherever `setState` is actually
//     implemented (store.tsx's `dispatch({ type: 'updateApp', update })`)
//     the single accumulation point: `handleWrap` is total and
//     side-effect-free, so re-running it fresh against whichever `app` the
//     updater is eventually invoked with is always correct.
//   - Persistence is NOT this module's job, for the same reason multi.ts's
//     own `storage`/`setState` doc comments give: it belongs to whoever owns
//     the reducer this module's updates flow through (store.tsx's own
//     `useEffect` on `state.app`), the ONE authoritative path, rather than
//     this module racing it with a second `saveState` call of its own. The
//     `storage` this module DOES take is scoped to the outbox only (flush-
//     on-start below, and `sendAck`'s enqueue/flush) — never state.
//   - Outbox flush on start, and an auto-ack `.catch`-swallowed the same way.

import { getPublicKey } from 'nostr-tools/pure'
import type { NostrEvent } from 'nostr-tools/pure'
import { WRAP } from '../wire/kinds'
import type { RelayLike } from '../wire/relayClient'
import type { StorageLike } from '../wire/outbox'
import { flush } from '../wire/outbox'
import type { AppState } from '../state/types'
import { handleWrap, type Effect } from './ingress'
import { sendAck } from './publish'

export interface StartSyncOpts {
  /** Must return the CURRENT app state at call time (a live read, e.g. of a
   *  ref mirroring React state) — used only to compute `effects` for driving
   *  acks/`onEffect` (safe even from a possibly-microtask-stale snapshot, see
   *  this module's header); the ledger fold itself never trusts this
   *  directly, see `setState`. */
  getState: () => AppState
  /** Applies `update` to whatever the CALLER's own accumulation point
   *  considers the CURRENT app to be at the moment `update` actually runs —
   *  see this module's header. A React reducer action carrying `update` as
   *  its payload (`{ type: 'updateApp', update }`) is the intended shape —
   *  see store.tsx. */
  setState: (update: (app: AppState) => AppState) => void
  /** This device's own secret key — used both to derive which pubkey to
   *  subscribe for (`#p` filter) and to unwrap/sign as. */
  selfSk: Uint8Array
  /** The single peer this engine instance is pinned to (see ingress.ts's
   *  `handleWrap` — pair.claim intake is out of scope here, see header). */
  pinnedPeerPk: string
  relay: RelayLike
  /** This device's durable outbox storage (`sendAck`'s enqueue/flush) — NOT
   *  used for `AppState` persistence, which this module deliberately never
   *  performs itself (see this module's header). */
  storage: StorageLike
  /** Every effect other than 'ack' (which is auto-sent) is handed here. */
  onEffect: (effect: Effect) => void
  /** Defaults to wall-clock seconds; tests inject a fixed/controlled clock. */
  nowSec?: () => number
}

/**
 * Subscribes for gift-wrapped events addressed to this device, dispatches
 * each through `ingress.ts#handleWrap` (accumulating via the caller's own
 * `setState` updater, never persisting anything itself — see `storage`'s doc
 * comment), auto-sends an ack for every 'ack' effect, and surfaces everything
 * else to `onEffect`. Flushes the outbox once at start (mirrors multi.ts's
 * "outbox flush ownership"). Returns a stop function.
 */
export function startSync(opts: StartSyncOpts): () => void {
  const selfPk = getPublicKey(opts.selfSk)
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000))

  // Flush on start — see this module's header ("outbox flush ownership",
  // mirroring multi.ts).
  void flush(opts.relay, nowSec(), opts.storage).catch(() => {})

  const unsubscribe = opts.relay.subscribe({ kinds: [WRAP], '#p': [selfPk] }, (wrap: NostrEvent) => {
    const now = nowSec()

    // `effects` computed once, eagerly, from whatever `getState()` returns
    // right now — safe despite the staleness hazard this module's header
    // describes, for the same reason multi.ts's own comment gives: every
    // effect-producing branch of `handleWrap` derives its payload purely
    // from the WRAP itself, none of it read back out of `state`.
    const { effects } = handleWrap(opts.getState(), wrap, opts.selfSk, opts.pinnedPeerPk, now)

    // The ledger fold MUST re-run fresh against whatever the caller's
    // accumulation point considers current AT THE MOMENT this update is
    // actually applied — see this module's header. `handleWrap` is
    // total/side-effect-free, so re-invoking it here (a second time, against
    // a possibly-different `app` than the one `effects` above was read from)
    // is exactly as safe as calling it once.
    opts.setState((app) => handleWrap(app, wrap, opts.selfSk, opts.pinnedPeerPk, now).state)

    // Awaiting every ack send before the batch flush below (same reasoning
    // as multi.ts: `wire/outbox.ts#flush` reads its queue snapshot at call
    // time, so two flush() calls in flight at once can both read the same
    // still-queued item and both publish it).
    const ackSends: Promise<unknown>[] = []
    for (const effect of effects) {
      if (effect.type === 'ack') {
        // Fire-and-forget from the caller's point of view (nothing useful to
        // do differently on failure — the outbox already durably queues it),
        // but an unhandled rejection is a distinct failure mode of its own —
        // catch and swallow, same as multi.ts.
        ackSends.push(
          sendAck(effect.entryId, {
            selfSk: opts.selfSk,
            peerPk: opts.pinnedPeerPk,
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
  })

  return unsubscribe
}
