import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { emptyState } from '../state/state'
import type { AppState } from '../state/types'
import type { RelayLike } from '../wire/relayClient'
import { flush, outboxEvents, type StorageLike } from '../wire/outbox'
import { generateMnemonic } from '../identity/derive'
import { readVaultPublished, republishVaultIfDue, vaultQueued, writeVaultPublished } from './vaultRepublish'

// The background re-seal must never reach My Signet or any signer. If this
// module (or anything it loads) imported the signet-login wrapper, loading it
// here would throw.
const signetTouched = vi.fn()
vi.mock('../identity/signetLogin', () => {
  signetTouched()
  throw new Error('the background vault re-seal must not load signet-login')
})
vi.mock('signet-login', () => {
  signetTouched()
  throw new Error('the background vault re-seal must not load signet-login')
})

function memStorage(): StorageLike {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }
}

const NOW = 1_800_000_000
const rootSk = generateSecretKey()
const rootPk = getPublicKey(rootSk)
const authEvent: NostrEvent = finalizeEvent({ kind: 21236, created_at: NOW - 100, tags: [], content: '' }, rootSk)
const guardianSk = generateSecretKey()
const mnemonic = generateMnemonic()

function guardianApp(pubkey = rootPk): AppState {
  return {
    ...emptyState(),
    role: 'guardian',
    relays: ['wss://relay.example'],
    root: { kind: 'signet', pubkey, authEvent, backedUpAt: null },
  }
}

function relay(result: 'accepted' | 'rejected'): RelayLike & { published: NostrEvent[] } {
  const published: NostrEvent[] = []
  return {
    published,
    publish: async (ev) => {
      published.push(ev)
      return result
    },
    subscribe: () => () => {},
  }
}

function opts(app: AppState, r: RelayLike, storage = memStorage(), record = memStorage()) {
  return { getApp: () => app, guardianSk, relay: r, storage, record, nowSec: NOW, loadMnemonic: async () => mnemonic, inFlight: { current: null } }
}

describe('republishVaultIfDue', () => {
  it('seals to the stored Signet pubkey with no signer, and stamps the publish', async () => {
    const r = relay('accepted')
    const o = opts(guardianApp(), r)
    expect(await republishVaultIfDue(o)).toBe(NOW)
    expect(r.published).toHaveLength(1)
    expect(r.published[0]!.kind).toBe(1059)
    expect(r.published[0]!.tags).toContainEqual(['p', rootPk])
    expect(readVaultPublished(o.record)).not.toBeNull()
    expect(signetTouched).not.toHaveBeenCalled()
  })

  it('skips when no Signet pubkey is stored', async () => {
    const r = relay('accepted')
    expect(await republishVaultIfDue(opts(guardianApp(''), r))).toBeNull()
    expect(await republishVaultIfDue(opts({ ...guardianApp(), root: null }, r))).toBeNull()
    expect(r.published).toEqual([])
  })

  it('does not seal a second vault while one is still queued in the outbox', async () => {
    const r = relay('rejected')
    const o = opts(guardianApp(), r)
    expect(await republishVaultIfDue(o)).toBeNull()
    expect(vaultQueued(rootPk, o.storage)).toBe(true)
    expect(await republishVaultIfDue(o)).toBeNull()
    expect(outboxEvents(o.storage)).toHaveLength(1)
  })

  it('remembers a publish whose durable record could not be written', async () => {
    const r = relay('accepted')
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    const o = { ...opts(guardianApp(), r), record: blocked }
    expect(await republishVaultIfDue(o)).toBe(NOW)
    // The roster is unchanged and backedUpAt is fresh: nothing is due again.
    const app = guardianApp()
    const stamped: AppState = { ...app, root: { kind: 'signet', pubkey: rootPk, authEvent, backedUpAt: NOW } }
    expect(await republishVaultIfDue({ ...o, getApp: () => stamped })).toBeNull()
    expect(r.published).toHaveLength(1)
  })

  it('a record write that throws never throws out', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => writeVaultPublished('sig', blocked)).not.toThrow()
    expect(readVaultPublished(blocked)).toBe('sig')
  })
})


it('records a queued vault accepted by a later flush without sealing it again', async () => {
  const app = guardianApp()
  const r = relay('rejected')
  const o = opts(app, r)
  expect(await republishVaultIfDue(o)).toBeNull()
  const successful = relay('accepted')
  await flush(successful, NOW + 10, o.storage)
  expect(await republishVaultIfDue({ ...o, relay: successful, nowSec: NOW + 20 })).toBe(NOW)
  expect(successful.published).toHaveLength(1)
  expect(readVaultPublished(o.record)).not.toBeNull()
})


it('does not call a rejected direct publish backed up when the outbox write failed', async () => {
  const storage = { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('quota') } }
  const r = relay('rejected')
  const o = opts(guardianApp(), r, storage)
  expect(await republishVaultIfDue(o)).toBeNull()
  expect(await republishVaultIfDue({ ...o, nowSec: NOW + 20 })).toBeNull()
  expect(readVaultPublished(o.record)).toBeNull()
  expect(r.published).toHaveLength(2)
})
