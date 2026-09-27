import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type NostrEvent } from 'nostr-tools/pure'
import { makeFakeRelay } from './fakeRelay'
import type { RelayLike } from './relayClient'
import { armPeriodicFlush, clearOutbox, enqueue, flush, FLUSH_INTERVAL_MS, outboxEvents, STALE_SWEEP_SECS, type StorageLike } from './outbox'

const AT = 1_700_000_000

function makeFakeStorage(): StorageLike {
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

function makeEvent(seed: string): NostrEvent {
  const sk = generateSecretKey()
  return finalizeEvent({ kind: 31120, created_at: AT, tags: [], content: seed }, sk)
}

// finalizeEvent stashes a non-enumerable `Symbol(verified)` marker on the
// event object; it does not survive outbox.ts's JSON storage round-trip
// (nor should it — it's a same-process cache, not wire data), so comparisons
// against a value read back via outboxEvents() must round-trip the expected
// side through JSON too, or the symbol alone fails a deep-equal.
function plain(ev: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(ev)) as NostrEvent
}

describe('outbox: enqueue', () => {
  it('persists an item that survives a fresh read of storage', () => {
    const storage = makeFakeStorage()
    const ev = makeEvent('a')
    enqueue(ev, AT, storage)
    expect(outboxEvents(storage)).toEqual([plain(ev)])
  })

  it('is FIFO — items read back in insertion order', () => {
    const storage = makeFakeStorage()
    const e1 = makeEvent('1')
    const e2 = makeEvent('2')
    const e3 = makeEvent('3')
    enqueue(e1, AT, storage)
    enqueue(e2, AT, storage)
    enqueue(e3, AT, storage)
    expect(outboxEvents(storage)).toEqual([e1, e2, e3].map(plain))
  })

  it('uses the name-free storage key kinjar.outbox.v1', () => {
    const storage = makeFakeStorage()
    enqueue(makeEvent('a'), AT, storage)
    expect(storage.getItem('kinjar.outbox.v1')).not.toBeNull()
  })
})

describe('outbox: publish offline stays queued', () => {
  it('an event published while the relay is offline remains in the queue', async () => {
    const storage = makeFakeStorage()
    const relay = makeFakeRelay()
    relay.goOffline()
    const ev = makeEvent('a')
    enqueue(ev, AT, storage)

    const sent = await flush(relay, AT, storage)

    expect(sent).toBe(0)
    expect(outboxEvents(storage)).toEqual([plain(ev)])
    expect(relay.events).toEqual([]) // never actually landed on the relay
  })
})

describe('outbox: flush after goOnline drains in order', () => {
  it('sends every queued item once the relay is reachable, in FIFO order, and empties the queue', async () => {
    const storage = makeFakeStorage()
    const relay = makeFakeRelay()
    relay.goOffline()
    const e1 = makeEvent('1')
    const e2 = makeEvent('2')
    const e3 = makeEvent('3')
    enqueue(e1, AT, storage)
    enqueue(e2, AT, storage)
    enqueue(e3, AT, storage)

    const offlineSent = await flush(relay, AT, storage)
    expect(offlineSent).toBe(0)

    relay.goOnline()
    const onlineSent = await flush(relay, AT, storage)

    expect(onlineSent).toBe(3)
    expect(outboxEvents(storage)).toEqual([])
    expect(relay.events).toEqual([e1, e2, e3].map(plain))
  })

  it('leaves a rejected item queued while later, already-accepted items still leave', async () => {
    const storage = makeFakeStorage()
    const good1 = makeEvent('good1')
    const bad = makeEvent('bad')
    const good2 = makeEvent('good2')
    enqueue(good1, AT, storage)
    enqueue(bad, AT, storage)
    enqueue(good2, AT, storage)

    const relay: RelayLike = {
      async publish(ev) {
        return ev.id === bad.id ? 'rejected' : 'accepted'
      },
      subscribe: () => () => {},
    }

    const sent = await flush(relay, AT, storage)

    expect(sent).toBe(2)
    expect(outboxEvents(storage)).toEqual([plain(bad)])
  })
})

describe('outbox: enqueue during an in-flight flush is not lost', () => {
  it('keeps an item enqueued while an earlier publish is still awaiting', async () => {
    const storage = makeFakeStorage()
    const slow = makeEvent('slow')
    enqueue(slow, AT, storage)

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let concurrentEvent: NostrEvent | undefined

    // Zero-network, in-memory stub whose publish() the test can pause mid-flush
    // (fakeRelay's publish resolves immediately, so it can't model the race).
    const relay: RelayLike = {
      async publish(ev) {
        if (ev.id === slow.id) {
          await gate
          // Enqueue while flush() is still suspended awaiting this publish —
          // JS is single-threaded, so this only runs because that await
          // yielded control back to the event loop and on to the test body.
          concurrentEvent = makeEvent('concurrent')
          enqueue(concurrentEvent, AT + 1, storage)
        }
        return 'accepted'
      },
      subscribe: () => () => {},
    }

    const flushPromise = flush(relay, AT, storage)
    release?.()
    const sent = await flushPromise

    expect(sent).toBe(1)
    expect(concurrentEvent).toBeDefined()
    expect(outboxEvents(storage)).toEqual([plain(concurrentEvent as NostrEvent)])
  })
})

describe('outbox: 7-day sweep', () => {
  it('drops an item older than the sweep window without attempting to send it', async () => {
    const storage = makeFakeStorage()
    const stale = makeEvent('stale')
    enqueue(stale, AT, storage)

    let publishCalls = 0
    const relay: RelayLike = {
      async publish() {
        publishCalls += 1
        return 'accepted'
      },
      subscribe: () => () => {},
    }

    const sent = await flush(relay, AT + STALE_SWEEP_SECS + 1, storage)

    expect(sent).toBe(0)
    expect(publishCalls).toBe(0)
    expect(outboxEvents(storage)).toEqual([])
  })

  it('keeps an item younger than the sweep window', async () => {
    const storage = makeFakeStorage()
    const fresh = makeEvent('fresh')
    enqueue(fresh, AT, storage)

    const relay = makeFakeRelay()
    relay.goOffline() // keep it queued so we can inspect it post-sweep

    await flush(relay, AT + STALE_SWEEP_SECS - 1, storage)

    expect(outboxEvents(storage)).toEqual([plain(fresh)])
  })
})

describe('outbox: dedupe is the caller\'s job', () => {
  it('enqueue does not itself reject a duplicate event id', () => {
    const storage = makeFakeStorage()
    const ev = makeEvent('dupe')
    enqueue(ev, AT, storage)
    enqueue(ev, AT, storage)
    expect(outboxEvents(storage)).toEqual([ev, ev].map(plain))
  })
})

// ============================================================================
// armPeriodicFlush — v0.2 spec §2.5. The queue is durable but nothing drained
// it except a new send, so an item queued while offline sat there until the
// user happened to do something else.
// ============================================================================

function fakeEventTarget() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn)
    },
    fire: (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

describe('armPeriodicFlush', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('flushes every minute', () => {
    expect(FLUSH_INTERVAL_MS).toBe(60_000)
    vi.useFakeTimers()
    vi.stubGlobal('window', fakeEventTarget())
    const flushNow = vi.fn()
    const disarm = armPeriodicFlush(flushNow)

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS)
    expect(flushNow).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS)
    expect(flushNow).toHaveBeenCalledTimes(2)

    disarm()
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 5)
    expect(flushNow).toHaveBeenCalledTimes(2)
  })

  it('flushes the moment the network comes back, and stops listening once disarmed', () => {
    vi.useFakeTimers()
    const win = fakeEventTarget()
    vi.stubGlobal('window', win)
    const flushNow = vi.fn()
    const disarm = armPeriodicFlush(flushNow)

    expect(win.count('online')).toBe(1)
    win.fire('online')
    expect(flushNow).toHaveBeenCalledTimes(1)

    disarm()
    expect(win.count('online')).toBe(0)
    win.fire('online')
    expect(flushNow).toHaveBeenCalledTimes(1)
  })

  it('still arms the timer where there is no window at all', () => {
    vi.useFakeTimers()
    const flushNow = vi.fn()
    const disarm = armPeriodicFlush(flushNow)
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS)
    expect(flushNow).toHaveBeenCalledTimes(1)
    disarm()
  })
})

// Fix round 1: "Start again" on the Unpaired screen must not leave a queue of
// pre-SEALED wraps behind. They are signed with a key the device no longer
// holds and addressed to a family that removed it, but the next engine start
// would happily republish every one of them.
describe('clearOutbox', () => {
  it('empties the queue', () => {
    const storage = makeFakeStorage()
    enqueue(makeEvent('a'), AT, storage)
    enqueue(makeEvent('b'), AT, storage)
    expect(outboxEvents(storage)).toHaveLength(2)
    clearOutbox(storage)
    expect(outboxEvents(storage)).toEqual([])
  })

  it('is idempotent, and a no-op on a queue that was never written', () => {
    const storage = makeFakeStorage()
    clearOutbox(storage)
    clearOutbox(storage)
    expect(outboxEvents(storage)).toEqual([])
  })

  it('leaves anything else in storage alone', () => {
    const storage = makeFakeStorage()
    storage.setItem('kinjar.state.v1', '{}')
    enqueue(makeEvent('a'), AT, storage)
    clearOutbox(storage)
    expect(storage.getItem('kinjar.state.v1')).toBe('{}')
  })

  it('a later enqueue after clearing starts from empty', () => {
    const storage = makeFakeStorage()
    enqueue(makeEvent('a'), AT, storage)
    clearOutbox(storage)
    enqueue(makeEvent('b'), AT, storage)
    expect(outboxEvents(storage)).toHaveLength(1)
  })
})

describe('outbox: overlapping flushes publish each item once (audit P10)', () => {
  it('serialises concurrent flushes of one queue, and still sends what was queued meanwhile', async () => {
    const storage = makeFakeStorage()
    const a = makeEvent('a')
    enqueue(a, AT, storage)
    const published: string[] = []
    const relay: RelayLike = {
      async publish(ev) {
        published.push(ev.id)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 'accepted'
      },
      subscribe: () => () => {},
    }

    const first = flush(relay, AT, storage)
    const b = makeEvent('b')
    enqueue(b, AT, storage)
    const second = flush(relay, AT, storage)
    const third = flush(relay, AT, storage)
    expect(third).toBe(second) // joins the flush already waiting
    await Promise.all([first, second, third])

    expect(published.filter((id) => id === a.id)).toHaveLength(1)
    expect(published.filter((id) => id === b.id)).toHaveLength(1)
    expect(outboxEvents(storage)).toEqual([])
  })
})
