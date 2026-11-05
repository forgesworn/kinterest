// Wraps already handed to `setState` whose fold may not yet be reflected in
// `getState()` — the gap engine.ts's and multi.ts's module headers describe
// (React batches dispatches, so the subscription callback can fire again
// before the previous wrap's updater has run).
//
// The ledger fold itself is safe across that gap: both engines re-run
// `handleWrap` inside the functional updater, against whatever the reducer
// holds at the time. The EFFECTS were not: they were computed once, from the
// possibly-stale `getState()`, and `dispatchInner`'s deferred branch is keyed
// on state. A guardian saving a new pot and crediting it sends an accounts
// CONFIG then an ENTRY back to back; delivered in one batch, the stale pass
// saw the ENTRY's account as unknown (deferred, so only a 'gap' effect) while
// the fresh updater — CONFIG already folded — folded the entry and marked
// the wrap seen. No 'ack' and no 'entry' effect were ever emitted, and none
// could be: a redelivery hits the seen-check. The guardian's feed then showed
// the entry as never delivered, for ever, and the child never got its
// notification.
//
// So effects are now computed against `project(getState())`: the committed
// state with every pending wrap folded in, in order — the same fold the
// updater will perform. `handleWrap` is pure and idempotent, so a wrap that
// HAS landed by the time it is re-folded here is a no-op (its id is in
// `seenEventIds`, and it is dropped from the pending list on that basis), and
// a deferred one is simply tried again. The list is bounded: a React batch
// is a handful of wraps, and each pending wrap costs one decrypt-and-verify
// per newly delivered wrap.

import type { NostrEvent } from 'nostr-tools/pure'
import type { AppState } from '../state/types'
import { handleWrap } from './ingress'

/** How many pending wraps are re-folded for effect computation. */
export const PENDING_WRAP_LIMIT = 8

export class PendingWraps {
  private items: { wrap: NostrEvent; authorPk: string }[] = []

  constructor(private readonly limit: number = PENDING_WRAP_LIMIT) {}

  /** `base` with every pending wrap it does not yet reflect folded in.
   *
   *  Pruning mirrors updater order, not per-id presence: updaters run in
   *  dispatch order, so once the NEWEST pending wrap found in
   *  `base.seenEventIds` has committed, every earlier one has run too —
   *  including any the updater DEFERRED (an ENTRY that overtook its accounts
   *  CONFIG), which is deferred in the committed state as well and must not
   *  be folded here on top of a base that has since learnt the pot. Keeping
   *  such a wrap pending made the projection claim it as seen, so its real
   *  redelivery (another relay, the reconnect replay) yielded no ack and no
   *  entry effect while the updater folded it. For the same reason a pending
   *  item with the incoming wrap's own id is skipped: the fold being judged
   *  IS that wrap. */
  project(base: AppState, selfSk: Uint8Array, nowSec: number, incoming?: NostrEvent): AppState {
    let newestSeen = -1
    this.items.forEach((p, i) => {
      if (base.seenEventIds.includes(p.wrap.id)) newestSeen = i
    })
    if (newestSeen >= 0) this.items = this.items.slice(newestSeen + 1)
    let state = base
    for (const p of this.items) {
      if (incoming !== undefined && p.wrap.id === incoming.id) continue
      state = handleWrap(state, p.wrap, selfSk, p.authorPk, nowSec).state
    }
    return state
  }

  /** Records a wrap just handed to `setState`. */
  note(wrap: NostrEvent, authorPk: string): void {
    this.items.push({ wrap, authorPk })
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
  }

  /** For tests. */
  get size(): number {
    return this.items.length
  }
}
