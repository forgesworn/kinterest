// In-memory `RelayLike` test double — see relayClient.ts and
// internal plan 2026-08-10-wire-identity-pairing, Task 5.
// Exported for later plans' tests too (pairing, sync engine): every test in
// this suite talks to this, never to a real socket.
//
// Model: `publish` stores the event (when online) and resolves immediately —
// it does NOT push the event to already-subscribed listeners. Delivery to
// live subscribers is the test's own explicit action, `deliverAll()`, which
// mirrors a relay flushing its queue; this keeps ordering fully in the
// test's hands rather than racing on real async delivery. A *late*
// subscriber — one that calls `subscribe` after events already exist —
// receives every already-stored event matching its filter synchronously,
// during the `subscribe` call itself, exactly once (replaying the 48h
// window a real relay would serve on connect). Each subscriber tracks how
// much of the event log it has already seen so `deliverAll()` only pushes
// events newer than its last delivery — it will not re-deliver the events a
// late subscriber already got via its initial replay. Event-id dedupe
// beyond that (e.g. two peers rebroadcasting the same event) is explicitly
// the caller's job (`state.seenEventIds`), not this double's.

import type { NostrEvent } from 'nostr-tools/pure'
import type { RelayLike, SubscribeFilter } from './relayClient'

export interface FakeRelay extends RelayLike {
  events: NostrEvent[]
  deliverAll(): void
  goOffline(): void
  goOnline(): void
}

function matchesFilter(ev: NostrEvent, filter: SubscribeFilter): boolean {
  if (!filter.kinds.includes(ev.kind) || filter.ids && !filter.ids.includes(ev.id)) return false
  if (filter.since !== undefined && ev.created_at < filter.since) return false
  const wantP = filter['#p']
  if (wantP !== undefined) {
    const pTags = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1])
    if (!wantP.some((p) => pTags.includes(p))) return false
  }
  return true
}

interface Subscriber {
  filter: SubscribeFilter
  onEvent: (ev: NostrEvent) => void
  /** Index into `events` up to (exclusive) which this subscriber has already
   *  received matching events — via initial replay or a prior deliverAll(). */
  deliveredUpTo: number
}

export function makeFakeRelay(): FakeRelay {
  let online = true
  const events: NostrEvent[] = []
  const subscribers = new Set<Subscriber>()

  return {
    events,

    publish(ev: NostrEvent): Promise<'accepted' | 'rejected'> {
      if (!online) return Promise.resolve('rejected')
      events.push(ev)
      return Promise.resolve('accepted')
    },

    subscribe(filter: SubscribeFilter, onEvent: (ev: NostrEvent) => void): () => void {
      const sub: Subscriber = { filter, onEvent, deliveredUpTo: events.length }
      // Late-subscriber replay: everything already stored that matches,
      // delivered synchronously before subscribe() returns.
      for (const ev of events) {
        if (matchesFilter(ev, filter)) onEvent(ev)
      }
      subscribers.add(sub)
      return () => {
        subscribers.delete(sub)
      }
    },

    deliverAll(): void {
      for (const sub of subscribers) {
        for (let i = sub.deliveredUpTo; i < events.length; i += 1) {
          const ev = events[i]
          if (ev !== undefined && matchesFilter(ev, sub.filter)) sub.onEvent(ev)
        }
        sub.deliveredUpTo = events.length
      }
    },

    goOffline(): void {
      online = false
    },

    goOnline(): void {
      online = true
    },
  }
}
