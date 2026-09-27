// Relay transport seam — see internal plan 2026-08-10-wire-identity-pairing,
// Task 5. `RelayLike` is the interface the rest of the app (outbox, sync
// engine) codes against; `makePool` is the real implementation over
// nostr-tools' `SimplePool`, `fakeRelay.ts` is the in-memory test double.
//
// Publish semantics (Global Constraints): fan out to every configured relay,
// **one accepted relay = sent**. Any failure path — every relay rejecting,
// zero relays configured, or the whole fan-out simply taking too long —
// resolves 'rejected', never throws and never hangs. `PUBLISH_TIMEOUT_MS`
// bounds the worst case so airplane mode (or a wedged relay) can never leave
// a caller waiting forever; it must never read as success.

import { SimplePool } from 'nostr-tools/pool'
import type { NostrEvent } from 'nostr-tools/pure'

/** 10s — never hang on a publish; see Global Constraints. */
export const PUBLISH_TIMEOUT_MS = 10_000

export interface SubscribeFilter {
  kinds: number[]
  '#p'?: string[]
  since?: number
  // Matches nostr-tools' `Filter` shape so a `SubscribeFilter` can be passed
  // straight through to `SimplePool#subscribeMany` without a cast.
  [key: `#${string}`]: string[] | undefined
}

export interface RelayLike {
  publish(ev: NostrEvent): Promise<'accepted' | 'rejected'>
  subscribe(filter: SubscribeFilter, onEvent: (ev: NostrEvent) => void): () => void
  /** Tears down every underlying connection this `RelayLike` opened.
   *  Optional (test doubles such as `fakeRelay.ts` hold no real connections
   *  to close) — callers that construct a REAL pool (`makePool`, below) and
   *  later replace or discard it (e.g. `store.tsx`'s relay list changing at
   *  runtime) should call this to avoid leaking open sockets. Never called
   *  automatically by anything in this module — ownership of when a pool's
   *  lifetime ends belongs to whoever constructed it. */
  close?(): void
}

/** Reconnect backoff for a dropped subscription, in ms: doubling from 1s,
 *  capped at a minute. Reset only once the link has proved healthy — see
 *  `HEALTHY_LINK_MS` — never on EOSE. */
export const RESUBSCRIBE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000]

/** How long a subscription must stay open, in ms, before its backoff is
 *  reset (review R4). EOSE proves nothing: nostr-tools fires `oneose` on
 *  every close, BEFORE `onclose`, so a relay that refuses or drops at once
 *  would otherwise be retried every second for ever. A new live event
 *  (after EOSE) also counts as healthy. */
export const HEALTHY_LINK_MS = 30_000

/** Ids remembered per `subscribe` call to stop the same event, delivered by
 *  two relays, reaching `onEvent` twice. */
const CROSS_RELAY_DEDUPE = 2_000

/** The browser's connectivity events, when there are any. Structural, so a
 *  test can pass its own target and a non-browser runtime simply has none. */
export interface OnlineTarget {
  addEventListener(type: 'online', listener: () => void): void
  removeEventListener(type: 'online', listener: () => void): void
}

function defaultOnlineTarget(): OnlineTarget | undefined {
  const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown }
  return typeof g.addEventListener === 'function' && typeof g.removeEventListener === 'function'
    ? (globalThis as unknown as OnlineTarget)
    : undefined
}

/** Real transport over nostr-tools' SimplePool. Fan out to every url in
 *  `urls`; resolves 'accepted' the moment any one relay accepts, 'rejected'
 *  only once every relay has failed (or after PUBLISH_TIMEOUT_MS, or
 *  immediately if `urls` is empty — zero reachable relays is a rejection,
 *  not a hang). */
export function makePool(urls: string[], onlineTarget: OnlineTarget | undefined = defaultOnlineTarget()): RelayLike {
  // Ping ON, so a half-open socket (a mobile network change, a backgrounded
  // app) is noticed and closed rather than sitting silent for ever. The
  // library's own reconnect stays OFF: on reconnection it resubscribes with
  // `since = lastEmitted + 1`, and a NIP-59 gift wrap's `created_at` is
  // deliberately backdated by up to two days, so that `since` would silently
  // skip every wrap published during the outage. `subscribe` below does its
  // own resubscribing, with the original filter (audit P4).
  const pool = new SimplePool({ enablePing: true })

  return {
    publish(ev: NostrEvent): Promise<'accepted' | 'rejected'> {
      if (urls.length === 0) return Promise.resolve('rejected')

      return new Promise<'accepted' | 'rejected'>((resolve) => {
        let settled = false
        const settle = (result: 'accepted' | 'rejected') => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }

        const timer = setTimeout(() => settle('rejected'), PUBLISH_TIMEOUT_MS)

        // `SimplePool#publish` is documented as returning an array of
        // per-relay promises, but nothing stops it (or a future nostr-tools
        // version, or a mock in a test) from throwing synchronously instead
        // — e.g. before it's even had a chance to open a per-relay promise
        // at all. Without this try/catch that throw would propagate out of
        // the executor and reject the whole `publish()` promise, breaking
        // this function's documented contract (never throws, always
        // resolves 'accepted' | 'rejected').
        let perRelay: Promise<string>[]
        try {
          perRelay = pool.publish(urls, ev)
        } catch {
          settle('rejected')
          return
        }

        let pending = perRelay.length
        for (const p of perRelay) {
          p.then(
            () => settle('accepted'),
            () => {
              pending -= 1
              if (pending === 0) settle('rejected')
            },
          )
        }
      })
    },
    // One subscription PER RELAY, each re-established on its own when it
    // drops (audit P4): a pool-wide subscription only reports a close once
    // EVERY relay has closed, so one dead relay of two would stay dead. A
    // drop is retried with backoff, and at once when the browser comes back
    // `online`. The filter is re-sent unchanged (no `since`, see above):
    // redelivered wraps are deduped downstream by event id.
    subscribe(filter: SubscribeFilter, onEvent: (ev: NostrEvent) => void): () => void {
      let stopped = false
      const seen = new Set<string>()
      const deliver = (ev: NostrEvent) => {
        if (seen.has(ev.id)) return
        seen.add(ev.id)
        if (seen.size > CROSS_RELAY_DEDUPE) seen.delete(seen.values().next().value as string)
        onEvent(ev)
      }

      interface Link {
        url: string
        closer: { close: (reason?: string) => void } | null
        generation: number
        attempt: number
        timer: ReturnType<typeof setTimeout> | null
        /** Resets `attempt` once this generation has stayed open
         *  HEALTHY_LINK_MS; cleared on any close. */
        healthy: ReturnType<typeof setTimeout> | null
      }
      const links: Link[] = urls.map((url) => ({ url, closer: null, generation: 0, attempt: 0, timer: null, healthy: null }))

      const clearHealthy = (link: Link) => {
        if (link.healthy !== null) clearTimeout(link.healthy)
        link.healthy = null
      }

      const open = (link: Link) => {
        if (stopped) return
        link.timer = null
        clearHealthy(link)
        const generation = ++link.generation
        let eosed = false
        link.healthy = setTimeout(() => {
          link.healthy = null
          if (!stopped && generation === link.generation) link.attempt = 0
        }, HEALTHY_LINK_MS)
        try {
          link.closer = pool.subscribeMany([link.url], filter, {
            onevent: (ev: NostrEvent) => {
              // A new event after EOSE is live traffic: the link works.
              // Stored events (before EOSE) and redeliveries prove nothing.
              if (eosed && generation === link.generation && !seen.has(ev.id)) link.attempt = 0
              deliver(ev)
            },
            oneose: () => {
              // NOT a health signal (review R4): also fired on every close.
              if (generation === link.generation) eosed = true
            },
            onclose: () => {
              // A close we caused ourselves (a newer generation, or stop)
              // is not a drop.
              if (stopped || generation !== link.generation) return
              clearHealthy(link)
              link.closer = null
              scheduleReopen(link)
            },
          })
        } catch {
          clearHealthy(link)
          link.closer = null
          scheduleReopen(link)
        }
      }

      const scheduleReopen = (link: Link) => {
        if (stopped || link.timer !== null) return
        const delay = RESUBSCRIBE_BACKOFF_MS[Math.min(link.attempt, RESUBSCRIBE_BACKOFF_MS.length - 1)]!
        link.attempt += 1
        link.timer = setTimeout(() => open(link), delay)
      }

      const onOnline = () => {
        for (const link of links) {
          if (link.timer === null) continue
          clearTimeout(link.timer)
          link.attempt = 0
          open(link)
        }
      }

      for (const link of links) open(link)
      onlineTarget?.addEventListener('online', onOnline)

      return () => {
        stopped = true
        onlineTarget?.removeEventListener('online', onOnline)
        for (const link of links) {
          if (link.timer !== null) clearTimeout(link.timer)
          link.timer = null
          clearHealthy(link)
          link.closer?.close()
          link.closer = null
        }
      }
    },
    close(): void {
      pool.close(urls)
    },
  }
}
