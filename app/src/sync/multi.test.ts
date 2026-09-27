// sync/multi.ts — the guardian's multi-peer engine. See the module's header
// for the design this exercises: ONE subscription, unwrap-unpinned-then-
// membership-check before any mutation, synchronous pair-claim routing, and
// outbox flush ownership (start + after every processed wrap).

import { describe, expect, it } from 'vitest'
import { generateSecretKey, type NostrEvent } from 'nostr-tools/pure'
import { wrapFor } from '../wire/giftwrap'
import { makeFakeRelay } from '../wire/fakeRelay'
import { enqueue, outboxEvents, type StorageLike } from '../wire/outbox'
import { KIND_ACK, KIND_ENTRY, KIND_REQUEST } from '../wire/kinds'
import { buildAckPayload, buildEntryPayload, buildRequestPayload, buildSnapshotPayload } from '../wire/payloads'
import { newKeypair } from '../identity/keys'
import { generateMnemonic, guardianFromMnemonic } from '../identity/derive'
import { mintToken, type MintedToken } from '../pairing/tokens'
import { newId } from '../domain/id'
import { creditEntry } from '../domain/ledger'
import type { Account, Entry } from '../domain/types'
import type { ChoreTick } from '../domain/chores'
import { emptyState } from '../state/state'
import type { AppState } from '../state/types'
import { sendEntry, sendTick } from './publish'
import type { Effect, PairTokenStore } from './ingress'
import { startGuardianSync, type PairingSession } from './multi'
import type { RelayLike, SubscribeFilter } from '../wire/relayClient'

const AT = 1_700_000_000

/** A guardian state holding a chores doc — audit P8 binds a CHILD_SIG tick to
 *  a known chore of the child that signed it. */
function withChores(state: AppState, chores: { id: string; child: string }[]): AppState {
  return {
    ...state,
    docs: { ...state.docs, chores: { v: 1, issuedAt: 1, chores: chores.map((c) => ({ ...c, name: c.id, cadence: 'daily' as const })) } },
  }
}
const RELAYS = ['wss://relay.example.com']

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

function makeTokenStore(initial: MintedToken | null): PairTokenStore {
  let current = initial
  return {
    get: () => current,
    clear: () => {
      current = null
    },
  }
}

function emptySnapshot() {
  return buildSnapshotPayload({
    children: [],
    entries: [],
    docs: {
      accounts: { v: 1, issuedAt: 0, accounts: [] },
      allowance: { v: 1, issuedAt: 0, configs: [] },
      interest: { v: 1, issuedAt: 0, configs: [] },
      chores: { v: 1, issuedAt: 0, chores: [] },
    },
  })
}

/** Counts `subscribe` calls on top of a real fake relay — proves
 *  `startGuardianSync` opens exactly ONE subscription regardless of how
 *  many children/peers it watches. */
function countingRelay(inner: ReturnType<typeof makeFakeRelay>): RelayLike & { subscribeCalls: number } {
  let subscribeCalls = 0
  return {
    publish: inner.publish,
    subscribe(filter: SubscribeFilter, onEvent: (ev: NostrEvent) => void) {
      subscribeCalls += 1
      return inner.subscribe(filter, onEvent)
    },
    get subscribeCalls() {
      return subscribeCalls
    },
  }
}

describe('sync/multi.ts: startGuardianSync', () => {
  it('opens exactly ONE subscription regardless of peer count', () => {
    const guardian = newKeypair()
    const childA = newKeypair()
    const childB = newKeypair()
    const relay = countingRelay(makeFakeRelay())
    const storage = makeFakeStorage()
    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }

    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [childA.pk, childB.pk],
      relay,
      storage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      nowSec: () => AT,
    })

    expect(relay.subscribeCalls).toBe(1)
    stop()
  })

  it('applies traffic from a known member (membership check passes)', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()
    const childStorage = makeFakeStorage()

    let state: AppState = withChores(
      { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk, children: [{ pubkey: child.pk, name: 'Kid', index: 0 }] },
      [{ id: 'chore-1', child: child.pk }],
    )

    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [child.pk],
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      nowSec: () => AT,
    })

    // A tick, not an ENTRY: since audit P1 the guardian folds no
    // child-authored ENTRY at all (see the auto-ack test below).
    const tick: ChoreTick = { id: 'tick-member', chore: 'chore-1', day: '2026-08-10', at: AT }
    await sendTick(tick, { selfSk: child.sk, peerPk: guardian.pk, relay, storage: childStorage, nowSec: AT })
    relay.deliverAll()

    expect(state.ticks).toEqual([tick])
    stop()
  })

  it('drops traffic from a non-member entirely — no state mutation, even though the wrap is validly signed', async () => {
    const guardian = newKeypair()
    const knownChild = newKeypair()
    const stranger = newKeypair() // validly keyed, just never registered as a peer
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()
    const strangerStorage = makeFakeStorage()
    const account: Account = { id: 'acc1', child: stranger.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }

    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    const stateBefore = JSON.parse(JSON.stringify(state)) as AppState

    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [knownChild.pk], // stranger is NOT a member
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      nowSec: () => AT,
      // No pairing session — a non-member's REQUEST is not even a pair.claim
      // attempt here, but this also proves the "no session -> always drop"
      // rule for any wrap from a stranger.
    })

    const entry = creditEntry({ id: newId(AT * 1000), child: stranger.pk, createdAt: AT, author: 'child' }, account, 150, 'spend')
    await sendEntry(entry, { selfSk: stranger.sk, peerPk: guardian.pk, relay, storage: strangerStorage, nowSec: AT })
    relay.deliverAll()

    expect(state).toEqual(stateBefore)
    stop()
  })

  // Audit P1: ENTRY is guardian-authored only. A member's own ENTRY is
  // refused outright — not folded, and (so the sender is not told it was)
  // not acked either.
  it('refuses a child-authored ENTRY from a member: no fold, and no ack to anyone', async () => {
    const guardian = newKeypair()
    const childA = newKeypair()
    const childB = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()
    const childAStorage = makeFakeStorage()
    const accountA: Account = { id: 'accA', child: childA.pk, name: 'A pocket money', currency: 'GBP', custody: 'ledger' }

    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }

    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [childA.pk, childB.pk],
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      nowSec: () => AT,
    })

    const entry = creditEntry({ id: newId(AT * 1000), child: childA.pk, createdAt: AT, author: 'child' }, accountA, 150, 'spend')
    await sendEntry(entry, { selfSk: childA.sk, peerPk: guardian.pk, relay, storage: childAStorage, nowSec: AT })
    relay.deliverAll()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const pTagOf = (ev: NostrEvent) => ev.tags.find((t) => t[0] === 'p')?.[1] ?? ''
    const ackWraps = relay.events.filter((ev) => pTagOf(ev) === childA.pk || pTagOf(ev) === childB.pk)
    expect(ackWraps).toHaveLength(0)
    expect(state.entries).toEqual([])

    stop()
  })

  it('flushes the outbox on start', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const storage = makeFakeStorage()

    // Pre-seed a queued ack as if a previous session queued it while offline.
    const staleAck = wrapFor({
      innerKind: KIND_ACK,
      payload: buildAckPayload('some-entry', AT - 10),
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT - 10,
    })
    enqueue(staleAck, AT - 10, storage)
    expect(outboxEvents(storage)).toHaveLength(1)

    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [child.pk],
      relay,
      storage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      nowSec: () => AT,
    })

    // The start-of-day flush is fire-and-forget; let its microtasks settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(outboxEvents(storage)).toHaveLength(0)
    expect(relay.events).toHaveLength(1)
    stop()
  })

  it('flushes the outbox again after processing member traffic', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()
    const childStorage = makeFakeStorage()
    const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }

    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [child.pk],
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      nowSec: () => AT,
    })
    await Promise.resolve() // let the start-of-day flush settle (queue is empty, no-op)

    // Guardian queues something while "offline" from its own perspective —
    // simulated directly via enqueue, standing in for an earlier failed send.
    const queuedTick = wrapFor({
      innerKind: KIND_ACK,
      payload: buildAckPayload('other-entry', AT),
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })
    enqueue(queuedTick, AT, guardianStorage)
    expect(outboxEvents(guardianStorage)).toHaveLength(1)

    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'child' }, account, 150, 'spend')
    await sendEntry(entry, { selfSk: child.sk, peerPk: guardian.pk, relay, storage: childStorage, nowSec: AT })
    relay.deliverAll()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // The pre-queued item was drained by the post-ingress flush, alongside
    // the entry's own auto-ack (which never touches the outbox at all since
    // the relay is online — see publish.ts).
    expect(outboxEvents(guardianStorage)).toHaveLength(0)
    stop()
  })

  it('surfaces non-ack/tick effects (e.g. a spend.request) via onEffect', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()
    const childStorage = makeFakeStorage()

    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    const effects: Effect[] = []
    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [child.pk],
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: (e) => effects.push(e),
      nowSec: () => AT,
    })

    const requestPayload = buildRequestPayload({
      op: 'spend.request',
      reqId: 'r1',
      nonce: 'n1',
      child: child.pk,
      ts: AT,
      params: { amountMinor: 150, currency: 'GBP', account: 'acc1' },
    })
    const wrap = wrapFor({ innerKind: KIND_REQUEST, payload: requestPayload, authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })
    await relay.publish(wrap)
    relay.deliverAll()
    void childStorage // unused beyond this test's shape symmetry

    expect(effects).toEqual([{ type: 'request', payload: requestPayload, authorPk: child.pk }])
    stop()
  })

  it('surfaces a CHILD_SIG tick effect carrying authorPk, from a member', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()

    let state: AppState = withChores({ ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }, [{ id: 'chore-1', child: child.pk }])
    const effects: Effect[] = []
    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [child.pk],
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: (e) => effects.push(e),
      nowSec: () => AT,
    })

    const tick: ChoreTick = { id: 'tick-1', chore: 'chore-1', day: '2026-08-10', at: AT }
    const childStorage = makeFakeStorage()
    await sendTick(tick, { selfSk: child.sk, peerPk: guardian.pk, relay, storage: childStorage, nowSec: AT })
    relay.deliverAll()

    expect(state.ticks).toEqual([tick])
    expect(effects).toEqual([{ type: 'tick', tick, authorPk: child.pk }])
    stop()
  })

  it('pair.claim from a non-member is dropped when no pairing session is active', async () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)
    const device = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()

    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    let answered = false
    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [],
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      onPairClaimAnswered: () => {
        answered = true
      },
      getPairingSession: () => null, // no ceremony open
      nowSec: () => AT,
    })

    const minted = mintToken(AT)
    const claimPayload = buildRequestPayload({
      op: 'pair.claim',
      reqId: 'r1',
      nonce: 'n1',
      child: device.pk,
      ts: AT,
      params: { token: minted.token, devicePk: device.pk },
    })
    const wrap = wrapFor({ innerKind: KIND_REQUEST, payload: claimPayload, authorSk: device.sk, recipientPk: guardian.pk, nowSec: AT })
    await relay.publish(wrap)
    relay.deliverAll()

    expect(answered).toBe(false)
    stop()
  })

  it('pair.claim from a non-member is answered synchronously when a pairing session is active and the token is valid', async () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)
    const device = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()
    const minted = mintToken(AT)
    const tokenStore = makeTokenStore(minted)

    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    let answeredRecipient: string | null = null
    const session: PairingSession = {
      tokenStore,
      mnemonic,
      childIndex: 0,
      childName: 'Sam',
      snapshot: emptySnapshot(),
      relays: RELAYS,
    }
    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [],
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      onPairClaimAnswered: (a) => {
        answeredRecipient = a.recipientPk
      },
      getPairingSession: () => session,
      nowSec: () => AT,
    })

    const claimPayload = buildRequestPayload({
      op: 'pair.claim',
      reqId: 'r1',
      nonce: 'n1',
      child: device.pk,
      ts: AT,
      params: { token: minted.token, devicePk: device.pk },
    })
    const wrap = wrapFor({ innerKind: KIND_REQUEST, payload: claimPayload, authorSk: device.sk, recipientPk: guardian.pk, nowSec: AT })
    await relay.publish(wrap)
    relay.deliverAll()

    expect(answeredRecipient).toBe(device.pk)
    expect(tokenStore.get()).toBeNull() // consumed — single use
    stop()
  })

  it('a claim presenting a bad/expired token is answered null and the session token is left alone', async () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)
    const device = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()
    const minted = mintToken(AT)
    const tokenStore = makeTokenStore(minted)

    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    let answered = false
    const session: PairingSession = {
      tokenStore,
      mnemonic,
      childIndex: 0,
      childName: 'Sam',
      snapshot: emptySnapshot(),
      relays: RELAYS,
    }
    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [],
      relay,
      storage: guardianStorage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      onPairClaimAnswered: () => {
        answered = true
      },
      getPairingSession: () => session,
      nowSec: () => AT,
    })

    const claimPayload = buildRequestPayload({
      op: 'pair.claim',
      reqId: 'r1',
      nonce: 'n1',
      child: device.pk,
      ts: AT,
      params: { token: 'wrong-token-entirely', devicePk: device.pk },
    })
    const wrap = wrapFor({ innerKind: KIND_REQUEST, payload: claimPayload, authorSk: device.sk, recipientPk: guardian.pk, nowSec: AT })
    await relay.publish(wrap)
    relay.deliverAll()

    expect(answered).toBe(false)
    expect(tokenStore.get()).toEqual(minted) // untouched — the bad presentation never consumed it
    stop()
  })

  it('a wrap this device cannot even unwrap is dropped without touching state or attempting a pair-claim', async () => {
    const guardian = newKeypair()
    const relay = makeFakeRelay()
    const storage = makeFakeStorage()
    let state: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    const stateBefore = JSON.parse(JSON.stringify(state)) as AppState
    let answered = false

    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [],
      relay,
      storage,
      getState: () => state,
      setState: (update) => {
        state = update(state)
      },
      onEffect: () => {},
      onPairClaimAnswered: () => {
        answered = true
      },
      getPairingSession: () => ({
        tokenStore: makeTokenStore(mintToken(AT)),
        mnemonic: generateMnemonic(),
        childIndex: 0,
        childName: 'Sam',
        snapshot: emptySnapshot(),
        relays: RELAYS,
      }),
      nowSec: () => AT,
    })

    // A wrap correctly p-tagged to the guardian (so the fake relay's filter
    // delivers it) but whose content is corrupted post-hoc — nip44 decrypt
    // fails inside unwrapFrom, which returns null.
    const someoneElse = generateSecretKey()
    const validlyAddressed = wrapFor({
      innerKind: KIND_ENTRY,
      payload: buildEntryPayload({
        v: 1,
        id: 'x',
        child: 'x',
        kind: 'credit',
        createdAt: AT,
        author: 'guardian',
        legs: [{ account: 'a', currency: 'GBP', amountMinor: 1 }],
      } as Entry),
      authorSk: someoneElse,
      recipientPk: guardian.pk,
      nowSec: AT,
    })
    const undecryptable: NostrEvent = { ...validlyAddressed, content: 'not valid nip44 ciphertext' }

    await relay.publish(undecryptable)
    relay.deliverAll()

    expect(state).toEqual(stateBefore)
    expect(answered).toBe(false)
    stop()
  })

  it('two wraps delivered before a batched setState is actually applied still BOTH land — the ingest race functional setState fixes', () => {
    // Simulates React's batching (createRoot's automatic batching defers
    // when a dispatched update is actually reflected back through
    // `getState()`, so it must NEVER be treated as synchronous with the
    // `setState` call) rather than a real reducer: `setState` here just
    // QUEUES the updater, `getState()` deliberately never advances until
    // `flushBatch` runs — mirroring the real gap between this module's
    // subscription callback firing (possibly more than once before a
    // render commits) and a dispatched action actually being processed.
    // Before the fix, this module computed a whole precomputed `next`
    // AppState from `getState()` and handed THAT to `setState`; two wraps
    // processed inside the same batch would each compute their `next` from
    // the SAME stale snapshot, and flushing the batch in order would let
    // the second overwrite the first's entry outright.
    const guardian = newKeypair()
    const childA = newKeypair()
    const childB = newKeypair()
    const relay = makeFakeRelay()

    let committedState: AppState = withChores({ ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }, [
      { id: 'chore-a', child: childA.pk },
      { id: 'chore-b', child: childB.pk },
    ])
    const pendingUpdates: Array<(app: AppState) => AppState> = []

    const stop = startGuardianSync({
      selfSk: guardian.sk,
      peerPks: [childA.pk, childB.pk],
      relay,
      storage: makeFakeStorage(),
      getState: () => committedState, // deliberately never advanced mid-batch
      setState: (update) => {
        pendingUpdates.push(update)
      },
      onEffect: () => {},
      nowSec: () => AT,
    })

    // Ticks rather than ENTRYs since audit P1 (no child authors an ENTRY).
    const tickA: ChoreTick = { id: 'tick-a', chore: 'chore-a', day: '2026-08-10', at: AT }
    const tickB: ChoreTick = { id: 'tick-b', chore: 'chore-b', day: '2026-08-10', at: AT }

    // Both entries published to the SAME relay, then delivered together —
    // `deliverAll()` invokes this module's subscription callback once per
    // event, synchronously, back to back, exactly the scenario where two
    // `setState` calls can land before either is reflected in `getState()`.
    void sendTick(tickA, { selfSk: childA.sk, peerPk: guardian.pk, relay, storage: makeFakeStorage(), nowSec: AT })
    void sendTick(tickB, { selfSk: childB.sk, peerPk: guardian.pk, relay, storage: makeFakeStorage(), nowSec: AT })

    // sendEntry's own enqueue is synchronous (see publish.ts), so both
    // wraps are on the relay by the time deliverAll() runs even though the
    // sends' own flush()es are still in-flight promises.
    relay.deliverAll()

    expect(pendingUpdates).toHaveLength(2)

    // Flush the "batch": apply each queued updater against the PRIOR
    // result, exactly as a real reducer processes dispatched actions in
    // order — this is the composition the fix relies on.
    for (const update of pendingUpdates) committedState = update(committedState)

    expect(committedState.ticks.map((t) => t.id).sort()).toEqual([tickA.id, tickB.id].sort())
    stop()
  })
})
