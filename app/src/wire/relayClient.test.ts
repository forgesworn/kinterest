// Zero network: `nostr-tools/pool` is replaced wholesale with an in-memory
// stub before makePool ever runs, so `new SimplePool()` inside makePool
// never opens a socket — every relay interaction in this file is a plain
// mock function call.
//
// (Spying on the real `SimplePool`/`AbstractSimplePool` prototype instead
// does not work here: `nostr-tools/pool` and `nostr-tools/abstract-pool`
// resolve through the package's conditional exports independently, and
// under Vitest's module graph that yields two separate class instances for
// what looks like "the same" AbstractSimplePool — a spy on one prototype
// never touches the class the other module actually extends. Replacing the
// whole `nostr-tools/pool` module sidesteps that dual-module hazard
// entirely: relayClient.ts's `new SimplePool()` always resolves to *this*
// stub, full stop.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type NostrEvent } from 'nostr-tools/pure'

const AT = 1_700_000_000

type PublishParams = { onauth?: unknown; maxWait?: number; abort?: AbortSignal }
type SubscribeParams = { onevent?: (ev: NostrEvent) => void; [key: string]: unknown }

const publishMock = vi.fn<(relays: string[], ev: NostrEvent, params?: PublishParams) => Promise<string>[]>()
const subscribeManyMock =
  vi.fn<(relays: string[], filter: unknown, params: SubscribeParams) => { close: (reason?: string) => void }>()
const poolCloseMock = vi.fn<(relays: string[]) => void>()
const poolCtorMock = vi.fn<(opts: unknown) => void>()

vi.mock('nostr-tools/pool', () => {
  class SimplePool {
    constructor(opts?: unknown) {
      poolCtorMock(opts)
    }
    publish(relays: string[], ev: NostrEvent, params?: PublishParams): Promise<string>[] {
      return publishMock(relays, ev, params)
    }
    subscribeMany(relays: string[], filter: unknown, params: SubscribeParams) {
      return subscribeManyMock(relays, filter, params)
    }
    close(relays: string[]): void {
      poolCloseMock(relays)
    }
  }
  return { SimplePool }
})

// Imported AFTER vi.mock (hoisted above this point by Vitest either way) so
// makePool's internal `new SimplePool()` resolves to the stub above.
const { makePool, HEALTHY_LINK_MS, PUBLISH_TIMEOUT_MS, RESUBSCRIBE_BACKOFF_MS } = await import('./relayClient')

function makeEvent(): NostrEvent {
  const sk = generateSecretKey()
  return finalizeEvent({ kind: 31120, created_at: AT, tags: [], content: 'x' }, sk)
}

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

afterEach(() => {
  publishMock.mockReset()
  subscribeManyMock.mockReset()
  poolCloseMock.mockReset()
  poolCtorMock.mockReset()
  vi.useRealTimers()
})

describe('makePool: publish', () => {
  it('resolves rejected immediately when zero relays are configured — never hangs', async () => {
    const relay = makePool([])
    await expect(relay.publish(makeEvent())).resolves.toBe('rejected')
    expect(publishMock).not.toHaveBeenCalled()
  })

  it('resolves accepted as soon as one of several relays accepts', async () => {
    publishMock.mockReturnValue([Promise.reject(new Error('relay a down')), Promise.resolve('ok')])
    const relay = makePool(['wss://a.test', 'wss://b.test'])
    await expect(relay.publish(makeEvent())).resolves.toBe('accepted')
  })

  it('resolves rejected once every relay has failed', async () => {
    publishMock.mockReturnValue([Promise.reject(new Error('relay a down')), Promise.reject(new Error('relay b down'))])
    const relay = makePool(['wss://a.test', 'wss://b.test'])
    await expect(relay.publish(makeEvent())).resolves.toBe('rejected')
  })

  it('resolves rejected, never throws, when pool.publish itself throws synchronously', async () => {
    publishMock.mockImplementation(() => {
      throw new Error('SimplePool#publish blew up synchronously')
    })
    const relay = makePool(['wss://a.test', 'wss://b.test'])
    await expect(relay.publish(makeEvent())).resolves.toBe('rejected')
  })

  it('never hangs — resolves rejected after the 10s timeout when no relay responds', async () => {
    vi.useFakeTimers()
    publishMock.mockReturnValue([neverResolves(), neverResolves()])
    const relay = makePool(['wss://a.test', 'wss://b.test'])

    const result = relay.publish(makeEvent())
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS)

    await expect(result).resolves.toBe('rejected')
  })
})

describe('makePool: subscribe', () => {
  it('wires the underlying onevent callback through to the caller-supplied onEvent', () => {
    let capturedOnEvent: ((ev: NostrEvent) => void) | undefined
    subscribeManyMock.mockImplementation((_relays, _filter, params) => {
      capturedOnEvent = params.onevent
      return { close: vi.fn() }
    })

    const relay = makePool(['wss://a.test'])
    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31120] }, (e) => received.push(e))

    const ev = makeEvent()
    capturedOnEvent?.(ev)
    expect(received).toEqual([ev])
  })

  it('passes the filter through, one subscribeMany per relay (so each relay reconnects on its own)', () => {
    subscribeManyMock.mockReturnValue({ close: vi.fn() })
    const relay = makePool(['wss://a.test', 'wss://b.test'], undefined)
    relay.subscribe({ kinds: [31120, 31123], '#p': ['peer-pk'], since: AT }, () => {})

    const filter = { kinds: [31120, 31123], '#p': ['peer-pk'], since: AT }
    expect(subscribeManyMock).toHaveBeenCalledTimes(2)
    expect(subscribeManyMock).toHaveBeenCalledWith(['wss://a.test'], filter, expect.objectContaining({ onevent: expect.any(Function) }))
    expect(subscribeManyMock).toHaveBeenCalledWith(['wss://b.test'], filter, expect.objectContaining({ onevent: expect.any(Function) }))
  })

  it('delivers an event two relays both send only once', () => {
    const onevents: ((ev: NostrEvent) => void)[] = []
    subscribeManyMock.mockImplementation((_r, _f, params) => {
      onevents.push(params.onevent!)
      return { close: vi.fn() }
    })
    const relay = makePool(['wss://a.test', 'wss://b.test'], undefined)
    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31120] }, (e) => received.push(e))
    const ev = makeEvent()
    onevents[0]!(ev)
    onevents[1]!(ev)
    expect(received).toEqual([ev])
  })

  it('closes the underlying subscription when the returned unsubscribe function is called', () => {
    const close = vi.fn()
    subscribeManyMock.mockReturnValue({ close })

    const relay = makePool(['wss://a.test'], undefined)
    const unsubscribe = relay.subscribe({ kinds: [31120] }, () => {})
    expect(close).not.toHaveBeenCalled()

    unsubscribe()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

// With nostr-tools' defaults a dropped socket ended the
// subscription for good — the device silently stopped receiving.
describe('makePool: reconnect after a drop', () => {
  type Params = { onevent?: (ev: NostrEvent) => void; onclose?: (r: unknown) => void; oneose?: () => void }
  function captureSubs() {
    const subs: { relays: string[]; filter: unknown; params: Params }[] = []
    subscribeManyMock.mockImplementation((relays, filter, params) => {
      subs.push({ relays, filter, params: params as Params })
      return { close: vi.fn() }
    })
    return subs
  }
  function fakeOnline() {
    const listeners = new Set<() => void>()
    return {
      addEventListener: (_t: 'online', l: () => void) => listeners.add(l),
      removeEventListener: (_t: 'online', l: () => void) => listeners.delete(l),
      fire: () => listeners.forEach((l) => l()),
      count: () => listeners.size,
    }
  }

  it('turns on ping and leaves the library s since-based reconnect off', () => {
    makePool(['wss://a.test'], undefined)
    const opts = poolCtorMock.mock.calls[0]![0] as { enablePing?: boolean; enableReconnect?: boolean }
    expect(opts.enablePing).toBe(true)
    expect(opts.enableReconnect).not.toBe(true)
  })

  it('re-subscribes a dropped relay after the backoff, with the original filter (no since added)', async () => {
    vi.useFakeTimers()
    const subs = captureSubs()
    const relay = makePool(['wss://a.test'], undefined)
    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [1059], '#p': ['me'] }, (e) => received.push(e))
    expect(subs).toHaveLength(1)

    subs[0]!.params.onclose?.([{ url: 'wss://a.test', reason: 'relay connection closed' }])
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]! - 1)
    expect(subs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(subs).toHaveLength(2)
    expect(subs[1]!.filter).toEqual({ kinds: [1059], '#p': ['me'] })

    const ev = makeEvent()
    subs[1]!.params.onevent?.(ev)
    expect(received).toEqual([ev])
  })

  // Nostr-tools fires `oneose` BEFORE `onclose` on every close,
  // so EOSE must never reset the backoff.
  it('a relay that closes straight after EOSE gets exponentially growing delays, capped at 60 s', async () => {
    vi.useFakeTimers()
    const subs = captureSubs()
    makePool(['wss://a.test'], undefined).subscribe({ kinds: [1059] }, () => {})
    const delays: number[] = []
    for (let i = 0; i < 9; i++) {
      const sub = subs[subs.length - 1]!
      sub.params.oneose?.()
      sub.params.onclose?.([])
      const before = subs.length
      let waited = 0
      while (subs.length === before) {
        await vi.advanceTimersByTimeAsync(500)
        waited += 500
      }
      delays.push(waited)
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000])
  })

  it('resets the backoff once a link has stayed open HEALTHY_LINK_MS', async () => {
    vi.useFakeTimers()
    const subs = captureSubs()
    makePool(['wss://a.test'], undefined).subscribe({ kinds: [1059] }, () => {})
    subs[0]!.params.onclose?.([])
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]!)
    subs[1]!.params.onclose?.([])
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[1]!)
    expect(subs).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(HEALTHY_LINK_MS)
    subs[2]!.params.onclose?.([])
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]!)
    expect(subs).toHaveLength(4)
  })

  it('resets the backoff on a new live event after EOSE, but not on stored ones', async () => {
    vi.useFakeTimers()
    const subs = captureSubs()
    makePool(['wss://a.test'], undefined).subscribe({ kinds: [1059] }, () => {})
    subs[0]!.params.onclose?.([])
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]!)
    // Stored event before EOSE: no reset, so the next wait is 2 s.
    subs[1]!.params.onevent?.(makeEvent())
    subs[1]!.params.onclose?.([])
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]!)
    expect(subs).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[1]! - RESUBSCRIBE_BACKOFF_MS[0]!)
    expect(subs).toHaveLength(3)
    // Live event after EOSE: reset, so the next wait is 1 s.
    subs[2]!.params.oneose?.()
    subs[2]!.params.onevent?.(makeEvent())
    subs[2]!.params.onclose?.([])
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]!)
    expect(subs).toHaveLength(4)
  })

  it('re-subscribes at once when the browser comes back online', async () => {
    vi.useFakeTimers()
    const subs = captureSubs()
    const online = fakeOnline()
    makePool(['wss://a.test'], online).subscribe({ kinds: [1059] }, () => {})
    subs[0]!.params.onclose?.([])
    online.fire()
    expect(subs).toHaveLength(2)
    // …and the pending backoff timer no longer fires a third.
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[RESUBSCRIBE_BACKOFF_MS.length - 1]!)
    expect(subs).toHaveLength(2)
  })

  it('stops reconnecting once unsubscribed, and removes its online listener', async () => {
    vi.useFakeTimers()
    const subs = captureSubs()
    const online = fakeOnline()
    const unsubscribe = makePool(['wss://a.test'], online).subscribe({ kinds: [1059] }, () => {})
    expect(online.count()).toBe(1)
    subs[0]!.params.onclose?.([])
    unsubscribe()
    expect(online.count()).toBe(0)
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[RESUBSCRIBE_BACKOFF_MS.length - 1]!)
    expect(subs).toHaveLength(1)
  })

  it('does not treat its own close as a drop', async () => {
    vi.useFakeTimers()
    const subs = captureSubs()
    const unsubscribe = makePool(['wss://a.test'], undefined).subscribe({ kinds: [1059] }, () => {})
    unsubscribe()
    subs[0]!.params.onclose?.([{ url: 'wss://a.test', reason: 'closed by caller' }])
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]!)
    expect(subs).toHaveLength(1)
  })
})

describe('makePool: close', () => {
  it('tears down every connection this pool opened, scoped to its own urls', () => {
    const relay = makePool(['wss://a.test', 'wss://b.test'])
    expect(poolCloseMock).not.toHaveBeenCalled()

    relay.close?.()

    expect(poolCloseMock).toHaveBeenCalledWith(['wss://a.test', 'wss://b.test'])
  })
})


describe('complete backups on a single relay', () => {
  it('waits for every chunk on the same relay before its manifest, without waiting for a stalled relay', async () => {
    const chunks = [makeEvent(), makeEvent()], manifest = makeEvent()
    const accepted: string[] = []
    publishMock.mockImplementation(([url], event) => {
      if (url === 'wss://stalled.test') return [neverResolves()]
      if (event.id === manifest.id) expect(accepted).toEqual(chunks.map(c => c.id))
      accepted.push(event.id)
      return [Promise.resolve('ok')]
    })
    const relay = makePool(['wss://stalled.test', 'wss://working.test'])
    expect(await relay.publishBackup!(chunks, manifest)).toBe(true)
    expect(accepted).toEqual([...chunks.map(c => c.id), manifest.id])
  })

  it('does not publish a manifest when chunks are split across relays', async () => {
    const chunks = [makeEvent(), makeEvent()], manifest = makeEvent()
    publishMock.mockImplementation(([url], event) => [
      (url === 'wss://a.test' ? event.id === chunks[0]!.id : event.id === chunks[1]!.id)
        ? Promise.resolve('ok') : Promise.reject(new Error('rejected')),
    ])
    expect(await makePool(['wss://a.test', 'wss://b.test']).publishBackup!(chunks, manifest)).toBe(false)
    expect(publishMock.mock.calls.some(([, event]) => event.id === manifest.id)).toBe(false)
  })

  it('bounds the whole attempt even when chunks keep arriving slowly', async () => {
    vi.useFakeTimers()
    publishMock.mockImplementation(() => [new Promise(resolve => setTimeout(() => resolve('ok'), 9000))])
    const chunks = Array.from({ length: 80 }, makeEvent), manifest = makeEvent()
    const result = makePool(['wss://slow.test']).publishBackup!(chunks, manifest)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await result).toBe(false)
    expect(publishMock.mock.calls.some(([, event]) => event.id === manifest.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
  })
})
