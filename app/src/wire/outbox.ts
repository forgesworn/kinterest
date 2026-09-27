// Durable send queue — see internal plan 2026-08-10-wire-identity-pairing,
// Task 5. Every gift-wrapped event this app sends goes through here first:
// `enqueue` persists it to localStorage (name-free key, matching
// `state/persist.ts`'s pattern of injecting a `StorageLike` so this compiles
// and tests the same whether or not a DOM `localStorage` exists), `flush`
// then attempts to publish everything queued, in FIFO order, against a
// `RelayLike`.
//
// An item leaves the queue ONLY when its publish resolves 'accepted' — a
// 'rejected' result (offline, zero reachable relays, timeout) leaves it
// queued for the next flush. Each item is looked up and removed from
// storage by its Nostr event id, re-reading storage fresh at that point
// rather than writing back a single stale end-of-flush snapshot — that is
// what makes flush re-entrant-safe: an `enqueue()` call that lands while an
// earlier item's publish is still in flight (`await`ing) only ever appends
// to whatever is currently in storage, and this flush's later removals only
// ever subtract the specific ids it just sent, so the concurrently-enqueued
// item is never overwritten or lost (port of the guarantee described by
// roost-kit's `createOutbox`,
// adapted from its in-memory snapshot-diff to a per-id read/write since this
// module has no closure-held queue state of its own).

import type { NostrEvent } from 'nostr-tools/pure'
import type { RelayLike } from './relayClient'

// Name-free by design: no product name on disk.
const STORAGE_KEY = 'kinjar.outbox.v1'

/** Stale items older than this are swept on every flush() without ever being
 *  retried — see Global Constraints / Task 5 (7-day sweep). */
export const STALE_SWEEP_SECS = 7 * 24 * 60 * 60

export interface OutboxItem {
  event: NostrEvent
  queuedAt: number
}

// Minimal Storage surface — see state/persist.ts's StorageLike for the full
// rationale (DOM-lib-independent, injectable for tests).
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function noopStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

function defaultStorage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage
    if (ls) return ls
  } catch {
    // fall through to no-op
  }
  return noopStorage()
}

function isNostrEventShape(x: unknown): x is NostrEvent {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.pubkey === 'string' &&
    typeof e.created_at === 'number' &&
    typeof e.kind === 'number' &&
    Array.isArray(e.tags) &&
    typeof e.content === 'string' &&
    typeof e.sig === 'string'
  )
}

function isOutboxItemShape(x: unknown): x is OutboxItem {
  if (typeof x !== 'object' || x === null) return false
  const i = x as Record<string, unknown>
  return isNostrEventShape(i.event) && typeof i.queuedAt === 'number'
}

// Total: garbage on disk yields an empty queue rather than throwing —
// nothing downstream of this module should ever see a malformed item.
function readItems(storage: StorageLike): OutboxItem[] {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isOutboxItemShape)
  } catch {
    return []
  }
}

function writeItems(storage: StorageLike, items: OutboxItem[]): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(items))
}

/**
 * Empties the durable queue outright (v0.2 spec §4.5's "Start again").
 *
 * Everything in the outbox is a fully SEALED gift wrap: signed, addressed and
 * ready to publish. A device the family has removed still holds those wraps,
 * and `armPeriodicFlush`/the next engine start would republish every one of
 * them — up to `STALE_SWEEP_SECS` worth — to a family that removed it, under
 * a key it is no longer meant to speak with. Clearing the state blob alone
 * does not touch them; they live under their own storage key.
 *
 * Total and idempotent: a missing or unwritable queue is a no-op, never a
 * throw.
 */
export function clearOutbox(storage: StorageLike = defaultStorage()): void {
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing useful to do, and nothing downstream that could act on it.
  }
}

/** Append `ev` to the durable queue (FIFO — new items go to the back). */
export function enqueue(
  ev: NostrEvent,
  nowSec: number = Math.floor(Date.now() / 1000),
  storage: StorageLike = defaultStorage(),
): void {
  const items = readItems(storage)
  items.push({ event: ev, queuedAt: nowSec })
  writeItems(storage, items)
}

/** Drop anything queued more than {@link STALE_SWEEP_SECS} ago, without
 *  attempting to send it. Re-reads/writes storage directly (not the FIFO
 *  snapshot flush() takes) so it composes safely with concurrent enqueues
 *  the same way flush()'s per-id removal does. */
function sweepStale(nowSec: number, storage: StorageLike): void {
  const items = readItems(storage)
  const kept = items.filter((i) => nowSec - i.queuedAt < STALE_SWEEP_SECS)
  if (kept.length !== items.length) writeItems(storage, kept)
}

function removeById(id: string, storage: StorageLike): void {
  const items = readItems(storage)
  writeItems(
    storage,
    items.filter((i) => i.event.id !== id),
  )
}

/** Sweep stale items, then attempt to publish everything currently queued,
 *  in FIFO order, against `relay`. Resolves to the count actually accepted.
 *  An item leaves the queue only on 'accepted' — 'rejected' leaves it queued
 *  for the caller's next flush() call. Re-entrant-safe: see module doc. */
export async function flush(
  relay: RelayLike,
  nowSec: number = Math.floor(Date.now() / 1000),
  storage: StorageLike = defaultStorage(),
): Promise<number> {
  sweepStale(nowSec, storage)

  const snapshot = readItems(storage)
  let sent = 0
  for (const item of snapshot) {
    const result = await relay.publish(item.event)
    if (result === 'accepted') {
      sent += 1
      removeById(item.event.id, storage)
    }
  }
  return sent
}

/** Read-only introspection of the current queue, in FIFO order — for tests
 *  and any UI that wants to show "N pending". */
export function outboxEvents(storage: StorageLike = defaultStorage()): NostrEvent[] {
  return readItems(storage).map((i) => i.event)
}

/** How often a live sync engine drains the queue (v0.2 spec §2.5). */
export const FLUSH_INTERVAL_MS = 60_000

/**
 * Arms the two things that drain a durable queue nobody is otherwise
 * touching: a one-minute timer, and the browser's own "the network came
 * back" event. Returns a disarm function; the caller (store.tsx's engine
 * effects) owns the lifetime, exactly as it does for the engines themselves.
 *
 * Before this, `flush` only ever ran as a side effect of a NEW send or an
 * engine start — so an event enqueued while offline sat in storage until the
 * user happened to do something else entirely. No backoff: a flush against a
 * dead relay is one rejected publish and a flush against an empty queue is a
 * single storage read, so a minute is cheap enough not to need one.
 *
 * `setInterval` is taken off the global rather than `window` so this works
 * unchanged in a worker or a test environment with no DOM; the `online`
 * listener is genuinely a `window` thing and is guarded accordingly.
 */
export function armPeriodicFlush(flushNow: () => void, opts?: { intervalMs?: number }): () => void {
  const interval = setInterval(flushNow, opts?.intervalMs ?? FLUSH_INTERVAL_MS)
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) window.addEventListener('online', flushNow)
  return () => {
    clearInterval(interval)
    if (hasWindow) window.removeEventListener('online', flushNow)
  }
}
