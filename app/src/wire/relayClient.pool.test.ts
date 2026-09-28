// Against the REAL nostr-tools SimplePool (relayClient.test.ts
// replaces it with a stub). In nostr-tools the pool fires `oneose` BEFORE
// `onclose` on every failure, so a backoff reset on EOSE retried a dead
// relay about once a second for ever.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { makePool } from './relayClient'

afterEach(() => vi.useRealTimers())

describe('makePool against the real SimplePool', () => {
  it('a relay that refuses every connection is retried with backoff, not once a second', async () => {
    vi.useFakeTimers()
    let opened = 0
    class DeadWS {
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      onclose: (() => void) | null = null
      onmessage: unknown = null
      readyState = 0
      constructor(_url: string) {
        opened += 1
        setTimeout(() => this.onerror?.(), 0)
      }
      send() {}
      close() {}
    }
    useWebSocketImplementation(DeadWS as unknown)
    const pool = makePool(['wss://dead.example'], undefined)
    const stop = pool.subscribe({ kinds: [1059] } as never, () => {})
    for (let i = 0; i < 600; i++) await vi.advanceTimersByTimeAsync(100)
    stop()
    // 1, 2, 4, 8, 15, 30 s of backoff: the first attempt plus six retries.
    expect(opened).toBeLessThanOrEqual(8)
    expect(opened).toBeGreaterThanOrEqual(5)
  })
})
