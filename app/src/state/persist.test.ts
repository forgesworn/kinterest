import { describe, it, expect } from 'vitest'
import { creditEntry } from '../domain/ledger'
import type { Account, Entry } from '../domain/types'
import { buildGrantPayload, buildRequestPayload } from '../wire/payloads'
import { runSchedulers } from '../store/scheduler'
import { emptyState, addEntry, recordGrantResult, recordRequestDecision, upsertRequest } from './state'
import { clearState, loadState, quarantinedEntries, saveState, type StorageLike } from './persist'

const ledgerAcct: Account = { id: 'a-ledger', child: 'sam', name: 'With Mum & Dad', currency: 'GBP', custody: 'ledger' }

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

// A save/load round trip through a fresh in-memory store — the shortest way
// to assert what sanitiseState does to a given blob.
function roundTrip(s: Parameters<typeof saveState>[0]): ReturnType<typeof loadState> {
  const mem = makeFakeStorage()
  saveState(s, mem)
  return loadState(mem)
}

describe('loadState', () => {
  it('returns emptyState when nothing has been stored', () => {
    const storage = makeFakeStorage()
    expect(loadState(storage)).toEqual(emptyState())
  })

  it('returns emptyState for malformed JSON', () => {
    const storage = makeFakeStorage()
    storage.setItem('kinjar.state.v1', '{not valid json')
    expect(loadState(storage)).toEqual(emptyState())
  })

  it('returns emptyState for well-formed JSON that is not an AppState (wrong shape)', () => {
    const storage = makeFakeStorage()
    storage.setItem('kinjar.state.v1', JSON.stringify({ hello: 'world' }))
    expect(loadState(storage)).toEqual(emptyState())
  })

  it('returns emptyState for well-formed JSON of the wrong primitive type', () => {
    const storage = makeFakeStorage()
    storage.setItem('kinjar.state.v1', JSON.stringify('just a string'))
    expect(loadState(storage)).toEqual(emptyState())
  })

  it('returns emptyState for an unsupported version number', () => {
    const storage = makeFakeStorage()
    storage.setItem('kinjar.state.v1', JSON.stringify({ ...emptyState(), v: 2 }))
    expect(loadState(storage)).toEqual(emptyState())
  })
})

describe('loadState sanitisation of a corrupt-but-v1-shaped blob', () => {
  it('drops an invalid entry but keeps a valid one, without throwing', () => {
    const storage = makeFakeStorage()
    const valid: Entry = creditEntry({ id: 'e1', child: 'sam', createdAt: 1000, author: 'guardian' }, ledgerAcct, 500)
    const blob = { ...emptyState(), entries: [valid, { id: 'x' }] }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.entries).toEqual([valid])
  })

  it('drops a stored entry that breaks a ledger invariant (unbalanced transfer) instead of crashing', () => {
    const storage = makeFakeStorage()
    const valid: Entry = creditEntry({ id: 'e1', child: 'sam', createdAt: 1000, author: 'guardian' }, ledgerAcct, 500)
    const minted = { ...valid, id: 'bad', kind: 'transfer', legs: [
      { account: 'a1', currency: 'GBP', amountMinor: 100 },
      { account: 'a2', currency: 'GBP', amountMinor: 100 },
    ] }
    storage.setItem('kinjar.state.v1', JSON.stringify({ ...emptyState(), entries: [valid, minted] }))
    expect(loadState(storage).entries).toEqual([valid])
  })

  it('replaces a non-object docs field with the default docs, keeping the rest of the state', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), role: 'guardian', guardianPubkey: 'abc123', docs: 'nonsense' }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docs).toEqual(emptyState().docs)
    expect(loaded.role).toBe('guardian')
    expect(loaded.guardianPubkey).toBe('abc123')
  })

  it('drops non-object / missing-id rows from ticks and audits', () => {
    const storage = makeFakeStorage()
    const blob = {
      ...emptyState(),
      ticks: [{ id: 't1', chore: 'c1', day: '2026-08-10', at: 1000 }, 'garbage', { chore: 'no-id' }],
      audits: [null, { id: 'a1', account: 'a-ledger', child: 'sam', countedMinor: 0, expectedMinor: 0, deltaMinor: 0, at: 1000, author: 'guardian' }],
    }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.ticks).toEqual([{ id: 't1', chore: 'c1', day: '2026-08-10', at: 1000 }])
    expect(loaded.audits).toEqual([
      { id: 'a1', account: 'a-ledger', child: 'sam', countedMinor: 0, expectedMinor: 0, deltaMinor: 0, at: 1000, author: 'guardian' },
    ])
  })

  it('falls back to default children/relays when those fields are the wrong basic type', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), children: 'nope', relays: 42 }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.children).toEqual(emptyState().children)
    expect(loaded.relays).toEqual(emptyState().relays)
  })

  it('falls back to role "unset" when role is not one of unset/guardian/child, keeping the rest of the state', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), role: 'superuser', guardianPubkey: 'abc123' }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.role).toBe('unset')
    expect(loaded.guardianPubkey).toBe('abc123')
  })

  it('falls back to a null guardianPubkey when it is neither a string nor null', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), role: 'guardian', guardianPubkey: 12345 }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.guardianPubkey).toBeNull()
    expect(loaded.role).toBe('guardian')
  })

  it('accepts a null guardianPubkey (the emptyState default) without falling back', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), guardianPubkey: null }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.guardianPubkey).toBeNull()
  })

  it('falls back to the default self shape when self is malformed', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), self: 'nope', role: 'guardian' }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.self).toEqual(emptyState().self)
    expect(loaded.role).toBe('guardian')
  })

  it('falls back to the default self shape when self has the wrong field types', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), self: { pubkey: 42, childIndex: 'zero' } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.self).toEqual(emptyState().self)
  })

  it('falls back to {} for acks when it is not a record of numbers, keeping the rest of the state', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), acks: ['not', 'a', 'record'], role: 'child' }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.acks).toEqual({})
    expect(loaded.role).toBe('child')
  })

  it('falls back to {} for acks when values are not numbers', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), acks: { 'entry-1': 'not-a-number' } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.acks).toEqual({})
  })

  it('falls back to [] for seenEventIds when it is not an array — the sharp one: a non-array here crashes ingress.ts#handleWrap\'s .includes() check', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), seenEventIds: { corrupt: true }, role: 'guardian' }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.seenEventIds).toEqual([])
    expect(loaded.role).toBe('guardian')
    expect(() => loaded.seenEventIds.includes('anything')).not.toThrow()
  })

  it('falls back to [] for seenEventIds when it contains non-string entries', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), seenEventIds: ['ok', 42, 'also-ok'] }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.seenEventIds).toEqual([])
  })

  it('falls back to [] for requests when it is not an array, keeping the rest of the state', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), requests: 'nope', role: 'guardian' }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.requests).toEqual([])
    expect(loaded.role).toBe('guardian')
  })

  it('drops a malformed StoredRequest row (bad inner request payload) but keeps a valid one', () => {
    const storage = makeFakeStorage()
    const valid = upsertRequest(emptyState(), req('r1'), 'sam', 1000).requests[0]!
    const blob = { ...emptyState(), requests: [valid, { request: { garbage: true }, authorPk: 'sam', status: 'pending', createdAt: 1000 }] }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.requests).toEqual([valid])
  })

  it('drops a StoredRequest row with an unrecognised status', () => {
    const storage = makeFakeStorage()
    const bogus = { request: req('r1'), authorPk: 'sam', status: 'in-limbo', createdAt: 1000 }
    const blob = { ...emptyState(), requests: [bogus] }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.requests).toEqual([])
  })
})

// Fix 3 (final review): the previous check (`isPlainObject(raw.docs)`,
// applied once to the WHOLE docs object) accepted `raw.docs` wholesale the
// instant it was ANY plain object — a corrupt/hand-edited blob with, say,
// `docs.allowance` missing its `configs` array "loaded" successfully every
// time, only to then throw out of scheduler.ts#runSchedulers the moment it
// tried to iterate `state.docs.allowance.configs`, on EVERY launch
// thereafter (the corrupt blob is exactly what gets persisted right back by
// the next saveState). Each of the four doc kinds must now be validated
// (safe-integer issuedAt + its own list array) and fall back to
// emptyState()'s value INDEPENDENTLY of its siblings.
describe('loadState per-doc-kind shape validation (docs.accounts / docs.allowance / docs.interest / docs.chores)', () => {
  it('falls back the accounts doc to empty when its accounts field is not an array, keeping a well-formed sibling doc', () => {
    const storage = makeFakeStorage()
    const goodAllowance = { v: 1, issuedAt: 500, configs: [] }
    const blob = { ...emptyState(), docs: { ...emptyState().docs, accounts: { v: 1, issuedAt: 1000, accounts: 'nope' }, allowance: goodAllowance } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docs.accounts).toEqual(emptyState().docs.accounts)
    expect(loaded.docs.allowance).toEqual(goodAllowance)
  })

  it('falls back the accounts doc to empty when issuedAt is not a safe integer', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), docs: { ...emptyState().docs, accounts: { v: 1, issuedAt: 'soon', accounts: [] } } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docs.accounts).toEqual(emptyState().docs.accounts)
  })

  it('falls back the allowance doc to empty when its configs field is missing entirely — the scheduler-crash defect this closes', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), docs: { ...emptyState().docs, allowance: { v: 1, issuedAt: 500 } } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docs.allowance).toEqual(emptyState().docs.allowance)
    // Belt-and-braces: proves the fallback is actually safe to feed the
    // scheduler, not just structurally equal to emptyState() by coincidence
    // — this is the exact call store.tsx's scheduler effect makes on every
    // launch, and previously threw against a blob shaped like this one.
    expect(() => runSchedulers(loaded, 2000)).not.toThrow()
  })

  it('falls back the interest doc to empty when configs is not an array', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), docs: { ...emptyState().docs, interest: { v: 1, issuedAt: 500, configs: {} } } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docs.interest).toEqual(emptyState().docs.interest)
  })

  it('falls back the interest doc to empty when issuedAt is not a safe integer', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), docs: { ...emptyState().docs, interest: { v: 1, issuedAt: null, configs: [] } } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docs.interest).toEqual(emptyState().docs.interest)
  })

  it('falls back the chores doc to empty when chores is not an array', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), docs: { ...emptyState().docs, chores: { v: 1, issuedAt: 500, chores: null } } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docs.chores).toEqual(emptyState().docs.chores)
  })

  it('accepts a well-formed doc for one kind even while a sibling kind is corrupt, and keeps the rest of the state', () => {
    const storage = makeFakeStorage()
    const goodAccounts = { v: 1, issuedAt: 500, accounts: [ledgerAcct] }
    const blob = {
      ...emptyState(),
      role: 'guardian',
      docs: { ...emptyState().docs, accounts: goodAccounts, allowance: { v: 1, issuedAt: 500 } },
    }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docs.accounts).toEqual(goodAccounts)
    expect(loaded.docs.allowance).toEqual(emptyState().docs.allowance)
    expect(loaded.role).toBe('guardian')
  })
})

describe('loadState docHighWater per-key validation', () => {
  it('drops a non-integer docHighWater value but keeps a valid sibling key', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), docHighWater: { accounts: 1000, allowance: 'soon' } }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docHighWater).toEqual({ accounts: 1000 })
  })

  it('falls back to {} when docHighWater itself is not a plain object, keeping the rest of the state', () => {
    const storage = makeFakeStorage()
    const blob = { ...emptyState(), docHighWater: 'nope', role: 'guardian' }
    storage.setItem('kinjar.state.v1', JSON.stringify(blob))
    const loaded = loadState(storage)
    expect(loaded.docHighWater).toEqual({})
    expect(loaded.role).toBe('guardian')
  })
})

function req(reqId: string) {
  return buildRequestPayload({
    op: 'spend.request' as const,
    reqId,
    nonce: `n-${reqId}`,
    child: 'sam',
    ts: 1000,
    params: { amountMinor: 150, currency: 'GBP', account: 'a-ledger' },
  })
}

describe('save/load round-trip', () => {
  it('round-trips an empty state', () => {
    const storage = makeFakeStorage()
    const s = emptyState()
    saveState(s, storage)
    expect(loadState(storage)).toEqual(s)
  })

  it('round-trips a state with entries, config docs and high-water marks', () => {
    const storage = makeFakeStorage()
    let s = emptyState()
    s = addEntry(s, {
      v: 1,
      id: 'e1',
      child: 'sam',
      kind: 'credit',
      createdAt: 1000,
      author: 'guardian',
      legs: [{ account: 'a-ledger', currency: 'GBP', amountMinor: 500 }],
    })
    s = { ...s, role: 'guardian', guardianPubkey: 'abc123', relays: ['wss://example.test'] }
    saveState(s, storage)
    const loaded = loadState(storage)
    expect(loaded).toEqual(s)
  })

  it('round-trips a state with a decided request (decidedAt + grantedAmountMinor included)', () => {
    const storage = makeFakeStorage()
    let s = upsertRequest(emptyState(), req('r1'), 'sam', 1000)
    s = recordRequestDecision(s, req('r1'), 'sam', 'approved', 2000, 75)
    saveState(s, storage)
    expect(loadState(storage)).toEqual(s)
  })

  it('round-trips periodLegitimateAtReceipt on a pending claim', () => {
    const storage = makeFakeStorage()
    const s = { ...upsertRequest(emptyState(), req('r1'), 'sam', 1000) }
    s.requests = [{ ...s.requests[0]!, periodLegitimateAtReceipt: true }]
    saveState(s, storage)
    expect(loadState(storage).requests[0]!.periodLegitimateAtReceipt).toBe(true)
  })

  it('uses the name-free storage key kinjar.state.v1', () => {
    const storage = makeFakeStorage()
    saveState(emptyState(), storage)
    expect(storage.getItem('kinjar.state.v1')).not.toBeNull()
  })

  it('never throws when storage is full, and reports the failure', () => {
    const full: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
      removeItem: () => {},
    }
    expect(saveState(emptyState(), full)).toBe(false)
    expect(saveState(emptyState(), makeFakeStorage())).toBe(true)
  })

  it('falls back to an in-memory store, without throwing, when no storage is injected and globalThis.localStorage is absent (node env)', () => {
    expect(() => saveState(emptyState())).not.toThrow()
    expect(() => loadState()).not.toThrow()
  })

  it('falls back to an in-memory store, without throwing, when accessing localStorage itself throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get(): never {
        throw new Error('SecurityError: localStorage blocked')
      },
    })
    try {
      expect(() => saveState(emptyState())).not.toThrow()
      expect(() => loadState()).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})

// --- v0.2: root record, innerEvents corpus, per-child revocation ----------------

describe('sanitiseState: root, innerEvents, revoked', () => {
  it('keeps a valid signet root and drops a malformed one', () => {
    const root = {
      kind: 'signet' as const,
      pubkey: 'a'.repeat(64),
      authEvent: {
        id: 'b'.repeat(64),
        pubkey: 'a'.repeat(64),
        kind: 21236,
        created_at: 1,
        tags: [],
        content: '',
        sig: 'c'.repeat(128),
      },
      backedUpAt: 5,
    }
    expect(roundTrip({ ...emptyState(), root }).root).toEqual(root)
    expect(roundTrip({ ...emptyState(), root: { ...root, pubkey: 'zz' } } as never).root).toBeNull()
    expect(roundTrip({ ...emptyState(), root: { kind: 'phrase' } }).root).toEqual({ kind: 'phrase' })
  })

  // Phase A review follow-up: half an event is not an event. The record is
  // re-verified wherever it is shown as proof, and that check needs a `sig`
  // and a `tags` array to have anything to verify.
  it('drops a signet root whose authEvent is not fully event-shaped', () => {
    const base = {
      kind: 'signet' as const,
      pubkey: 'a'.repeat(64),
      authEvent: {
        id: 'b'.repeat(64),
        pubkey: 'a'.repeat(64),
        kind: 21236,
        created_at: 1,
        tags: [],
        content: '',
        sig: 'c'.repeat(128),
      },
      backedUpAt: null,
    }
    const { sig: _sig, ...noSig } = base.authEvent
    expect(roundTrip({ ...emptyState(), root: { ...base, authEvent: noSig } } as never).root).toBeNull()
    expect(roundTrip({ ...emptyState(), root: { ...base, authEvent: { ...base.authEvent, tags: 'nope' } } } as never).root).toBeNull()
    expect(roundTrip({ ...emptyState(), root: { ...base, authEvent: { ...base.authEvent, created_at: 'soon' } } } as never).root).toBeNull()
  })

  it('drops mis-keyed innerEvents entries', () => {
    const good = {
      id: 'd'.repeat(64),
      pubkey: 'a'.repeat(64),
      kind: 31120,
      created_at: 1,
      tags: [],
      content: '{}',
      sig: 'c'.repeat(128),
    }
    const loaded = roundTrip({
      ...emptyState(),
      innerEvents: { ['d'.repeat(64)]: good, wrongKey: good, ['e'.repeat(64)]: { nope: 1 } },
    } as never)
    expect(Object.keys(loaded.innerEvents)).toEqual(['d'.repeat(64)])
  })

  it('keeps a well-formed revoked map and drops a malformed one, never the whole doc', () => {
    const withRevoked = emptyState()
    withRevoked.docs.accounts = { ...withRevoked.docs.accounts, revoked: { ['a'.repeat(64)]: 100, nope: 1, ['b'.repeat(64)]: 'x' as never } }
    expect(roundTrip(withRevoked).docs.accounts.revoked).toEqual({ ['a'.repeat(64)]: 100 })

    const badRevoked = emptyState()
    badRevoked.docs.accounts = { ...badRevoked.docs.accounts, revoked: 'nope' as never }
    const loaded = roundTrip(badRevoked)
    expect(loaded.docs.accounts.revoked).toBeUndefined()
    expect(loaded.docs.accounts.accounts).toEqual([])
  })

  it('a pre-v0.2 blob with neither field loads with the empty defaults', () => {
    const mem = makeFakeStorage()
    const { root: _root, innerEvents: _innerEvents, ...legacy } = emptyState()
    mem.setItem('kinjar.state.v1', JSON.stringify(legacy))
    const loaded = loadState(mem)
    expect(loaded.root).toBeNull()
    expect(loaded.innerEvents).toEqual({})
  })
})

// v0.2 spec §4.5 — the Unpaired screen's "Start again".
describe('clearState', () => {
  it('removes the blob, so the next load is a brand new device', () => {
    const storage = makeFakeStorage()
    saveState({ ...emptyState(), role: 'child' }, storage)
    expect(loadState(storage).role).toBe('child')
    clearState(storage)
    expect(loadState(storage)).toEqual(emptyState())
  })

  it('is idempotent', () => {
    const storage = makeFakeStorage()
    clearState(storage)
    clearState(storage)
    expect(loadState(storage)).toEqual(emptyState())
  })
})

describe('synthetic request rows survive a reload', () => {
  it('keeps a synthetic row that parseRequestPayload would reject, and still drops a non-synthetic one', () => {
    let s = recordGrantResult(emptyState(), buildGrantPayload({ reqId: 'scheduler:sam:a:2026-W32', nonce: 'n', decision: 'deny', ts: 1, params: {} }), 'sam', 10)
    s = recordGrantResult(s, buildGrantPayload({ reqId: '01JSPEND', nonce: 'n2', decision: 'allow', ts: 1, params: { amountMinor: 250 } }), 'sam', 11)
    const bogus = { ...s.requests[0]!, synthetic: undefined, request: { ...s.requests[0]!.request, reqId: 'plain' } }
    const loaded = roundTrip({ ...s, requests: [...s.requests, bogus] })
    expect(loaded.requests.map((r) => [r.request.reqId, r.request.op, r.status, r.synthetic])).toEqual([
      ['scheduler:sam:a:2026-W32', 'allowance.claim', 'denied', true],
      ['01JSPEND', 'spend.request', 'approved', true],
    ])
    expect(loaded.requests[1]!.grantedAmountMinor).toBe(250)
  })
})

describe('sanitiseState per-row guards', () => {
  it('drops malformed children, relays, ticks and audits row by row, keeping the good ones', () => {
    const mem = makeFakeStorage()
    const goodChild = { pubkey: 'a'.repeat(64), name: 'Sam', index: 0 }
    const goodTick = { id: 't1', chore: 'c1', day: '2026-08-10', at: 100 }
    const goodAudit = { id: 'au1', account: 'a-box', child: 'sam', countedMinor: 700, expectedMinor: 767, deltaMinor: -67, at: 100, author: 'child' }
    mem.setItem('kinjar.state.v1', JSON.stringify({
      ...emptyState(),
      children: [goodChild, { pubkey: 'b'.repeat(64), name: 'Alex' }, 'junk'],
      relays: ['wss://relay.example', 42, null],
      ticks: [goodTick, { id: 't2' }, { ...goodTick, id: 't3', day: 'yesterday' }],
      audits: [goodAudit, { id: 'au2' }, { ...goodAudit, id: 'au3', countedMinor: 1.5 }],
    }))
    const loaded = loadState(mem)
    expect(loaded.children).toEqual([goodChild])
    expect(loaded.relays).toEqual(['wss://relay.example'])
    expect(loaded.ticks).toEqual([goodTick])
    expect(loaded.audits).toEqual([goodAudit])
  })
})

describe('invalid entries are quarantined, not silently lost', () => {
  it('sets a failing entry aside under its own key, once, and keeps it out of state', () => {
    const mem = makeFakeStorage()
    const good = creditEntry({ id: 'ok', child: 'sam', createdAt: 1, author: 'guardian' }, ledgerAcct, 100)
    const bad = { ...good, id: 'bad', legs: [{ account: 'a-ledger', currency: 'GBP', amountMinor: -5 }] } // a negative credit
    mem.setItem('kinjar.state.v1', JSON.stringify({ ...emptyState(), entries: [good, bad] }))
    expect(loadState(mem).entries.map((e) => e.id)).toEqual(['ok'])
    expect(quarantinedEntries(mem)).toEqual([bad])
    loadState(mem) // a second load does not duplicate it
    expect(quarantinedEntries(mem)).toHaveLength(1)
    clearState(mem) // "Start again" leaves nothing behind
    expect(quarantinedEntries(mem)).toEqual([])
  })
  it('is empty when nothing was ever quarantined', () => {
    expect(quarantinedEntries(makeFakeStorage())).toEqual([])
  })
})

// v0.3: a child paired on a build older than `ChildProfile.pairedAt` itself
// has none stored — `loadState` backfills it from independent evidence (see
// state.ts#hasPairedDevice/backfillPairedAt) so every consumer, not just
// ChildDetail.tsx, sees a consistent answer straight after load.
describe('loadState backfills pairedAt from evidence (state.ts#backfillPairedAt)', () => {
  const PK = 'a'.repeat(64)

  it('stamps pairedAt, at the given nowSec, for a pre-v0.3 child with a child-authored entry on disk', () => {
    const mem = makeFakeStorage()
    const good = creditEntry({ id: 'e1', child: PK, createdAt: 1, author: 'child' }, { ...ledgerAcct, child: PK }, 100)
    mem.setItem('kinjar.state.v1', JSON.stringify({ ...emptyState(), children: [{ pubkey: PK, name: 'Alex', index: 0 }], entries: [good] }))
    const loaded = loadState(mem, 12345)
    expect(loaded.children[0]!.pairedAt).toBe(12345)
  })

  it('leaves a child with no evidence at all without a pairedAt', () => {
    const mem = makeFakeStorage()
    mem.setItem('kinjar.state.v1', JSON.stringify({ ...emptyState(), children: [{ pubkey: PK, name: 'Alex', index: 0 }] }))
    const loaded = loadState(mem, 12345)
    expect(loaded.children[0]!.pairedAt).toBeUndefined()
  })

  it('never overwrites an already-stored pairedAt', () => {
    const mem = makeFakeStorage()
    mem.setItem('kinjar.state.v1', JSON.stringify({ ...emptyState(), children: [{ pubkey: PK, name: 'Alex', index: 0, pairedAt: 500 }] }))
    const loaded = loadState(mem, 12345)
    expect(loaded.children[0]!.pairedAt).toBe(500)
  })

  it('defaults nowSec to the real clock when not given (sanity: still a safe integer, close to now)', () => {
    const mem = makeFakeStorage()
    const good = creditEntry({ id: 'e1', child: PK, createdAt: 1, author: 'child' }, { ...ledgerAcct, child: PK }, 100)
    mem.setItem('kinjar.state.v1', JSON.stringify({ ...emptyState(), children: [{ pubkey: PK, name: 'Alex', index: 0 }], entries: [good] }))
    const before = Math.floor(Date.now() / 1000)
    const loaded = loadState(mem)
    expect(loaded.children[0]!.pairedAt).toBeGreaterThanOrEqual(before)
  })
})
