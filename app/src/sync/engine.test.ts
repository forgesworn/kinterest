// The big one — see internal plan 2026-08-10-wire-identity-pairing,
// Task 7. Everything Task 7 adds (publish.ts, ingress.ts, engine.ts) is
// exercised from this single file, per the brief's "Test:
// app/src/sync/engine.test.ts (the big one)". Structure:
//   1. publish.ts        — wrap/enqueue/flush plumbing, offline durability
//   2. ingress.ts         — handleWrap dispatch, one describe block per kind
//   3. ingress.ts         — handlePairClaimWrap: the Task 6 CARRIED SECURITY
//                           OBLIGATION (consumeToken hard-gates
//                           answerPairClaim, atomically single-use)
//   4. ingress.ts         — handlePairOfferWrap: child-side PAIR_OFFER
//                           intake, pinned to the QR-scanned guardian pubkey
//   5. engine.ts          — startSync smoke test
//   6. convergence         — the plan's Task 7 EXIT GATE: two real-keyed
//                           peers, offline outbox, shuffled delivery with a
//                           seeded PRNG, full replay idempotence

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { wrapFor } from '../wire/giftwrap'
import { makeFakeRelay } from '../wire/fakeRelay'
import { enqueue, flush, outboxEvents, type StorageLike } from '../wire/outbox'
import {
  KIND_ACK,
  KIND_CHILD_SIG,
  KIND_CONFIG,
  KIND_ENTRY,
  KIND_GRANT,
  KIND_PAIR_OFFER,
  KIND_REQUEST,
  KIND_SNAPSHOT,
} from '../wire/kinds'
import {
  buildAckPayload,
  buildChildTickPayload,
  buildConfigPayload,
  buildEntryPayload,
  buildGrantPayload,
  buildPairOfferPayload,
  buildRequestPayload,
  buildSnapshotPayload,
  type SnapshotPayload,
} from '../wire/payloads'
import { newKeypair } from '../identity/keys'
import { generateMnemonic, guardianFromMnemonic } from '../identity/derive'
import { mintToken, type MintedToken } from '../pairing/tokens'
import { newId } from '../domain/id'
import { creditEntry } from '../domain/ledger'
import { balances } from '../domain/ledger'
import type { Account, Entry } from '../domain/types'
import type { ChoreTick } from '../domain/chores'
import { addEntry, applyConfigDoc, emptyState } from '../state/state'
import type { AppState, ConfigDocs } from '../state/types'
import { sendAck, sendConfig, sendEntry, sendGrant, sendPairOffer, sendRequest, sendTick, type PublishOpts } from './publish'
import { handlePairClaimWrap, handlePairOfferWrap, handleWrap, MAX_ISSUED_AT_SKEW_SECS, type Effect, type PairTokenStore } from './ingress'
import { startSync } from './engine'

const AT = 1_700_000_000

/** `state` holding `accounts`/`chores` docs — audit P1/P8 bind a received
 *  ENTRY to known accounts and a CHILD_SIG tick to a known chore. */
function withDocs(state: AppState, docs: { accounts?: Account[]; chores?: { id: string; child: string }[] }): AppState {
  let next = state
  if (docs.accounts !== undefined) next = { ...next, docs: { ...next.docs, accounts: { v: 1, issuedAt: 1, accounts: docs.accounts } } }
  if (docs.chores !== undefined)
    next = {
      ...next,
      docs: {
        ...next.docs,
        chores: { v: 1, issuedAt: 1, chores: docs.chores.map((c) => ({ ...c, name: c.id, cadence: 'daily' as const })) },
      },
    }
  return next
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

// Deterministic seeded PRNG (mulberry32) — no Math.random anywhere in this
// file (matches domain/invariants.test.ts's convention for the same reason:
// reproducible shuffles).
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(xs: T[], seed: number): T[] {
  const rand = rng(seed)
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function pTagOf(ev: NostrEvent): string {
  return ev.tags.find((t) => t[0] === 'p')?.[1] ?? ''
}

function emptySnapshot(): SnapshotPayload {
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

function makeTokenStore(initial: MintedToken | null): PairTokenStore {
  let current = initial
  return {
    get: () => current,
    clear: () => {
      current = null
    },
  }
}

// ============================================================================
// 1. publish.ts
// ============================================================================

describe('publish.ts', () => {
  it('sendEntry wraps, enqueues, and flushes when the relay is online', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const storage = makeFakeStorage()
    const entry: Entry = creditEntry(
      { id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' },
      { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' },
      500,
      'allowance',
    )

    const result = await sendEntry(entry, { selfSk: guardian.sk, peerPk: child.pk, relay, storage, nowSec: AT })

    expect(result.sent).toBe(true)
    expect(relay.events).toHaveLength(1)
    expect(outboxEvents(storage)).toHaveLength(0)
    expect(pTagOf(relay.events[0]!)).toBe(child.pk)
  })

  it('leaves the event durably queued when the relay is offline, never reads as sent', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    relay.goOffline()
    const storage = makeFakeStorage()

    const result = await sendAck('some-entry-id', { selfSk: child.sk, peerPk: guardian.pk, relay, storage, nowSec: AT })

    expect(result.sent).toBe(false)
    expect(relay.events).toHaveLength(0)
    expect(outboxEvents(storage)).toHaveLength(1)
  })

  it('a later flush drains an item that failed while offline', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    relay.goOffline()
    const storage = makeFakeStorage()

    await sendAck('some-entry-id', { selfSk: child.sk, peerPk: guardian.pk, relay, storage, nowSec: AT })
    expect(outboxEvents(storage)).toHaveLength(1)

    relay.goOnline()
    const sentCount = await flush(relay, AT + 1, storage)

    expect(sentCount).toBe(1)
    expect(outboxEvents(storage)).toHaveLength(0)
    expect(relay.events).toHaveLength(1)
  })
})

// ============================================================================
// 2. ingress.ts — handleWrap dispatch
// ============================================================================

describe('ingress.ts: handleWrap', () => {
  const guardian = newKeypair()
  const child = newKeypair()
  const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }

  function wrapEntry(entry: Entry, authorSk: Uint8Array, recipientPk: string): NostrEvent {
    return wrapFor({ innerKind: KIND_ENTRY, payload: buildEntryPayload(entry), authorSk, recipientPk, nowSec: AT })
  }

  /** A receiving device that has its guardian pinned. Item I2's ENTRY
   *  provenance guard folds a guardian-authored entry for any child, so the
   *  guardian key has to actually be known — a bare `emptyState()` has
   *  `guardianPubkey: null` and pins nobody, which no real device ever is by
   *  the time wire traffic reaches it. */
  //  Audit P1: a guardian ENTRY must also bind to a known account of the
  //  child it names, so the pinned device holds the accounts doc too.
  const pinned = (): AppState => {
    const base = emptyState()
    return { ...base, guardianPubkey: guardian.pk, docs: { ...base.docs, accounts: { v: 1, issuedAt: 1, accounts: [account] } } }
  }

  it('ENTRY -> addEntry + an ack effect', () => {
    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const wrap = wrapEntry(entry, guardian.sk, child.pk)

    const { state, effects } = handleWrap(pinned(), wrap, child.sk, guardian.pk, AT)

    expect(state.entries).toEqual([entry])
    // v0.2: the ack is now accompanied by an additive `entry` effect (spec
    // §2.3) — the ack is what the wire needs, the entry effect is what the
    // app layer (notifications, activity feed) hangs off.
    expect(effects).toEqual([
      { type: 'ack', entryId: entry.id, authorPk: guardian.pk },
      { type: 'entry', entry, authorPk: guardian.pk },
    ])
  })

  it('rejects an ENTRY wrap whose seal author is not the pinned peer', () => {
    const impostor = generateSecretKey()
    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const wrap = wrapEntry(entry, impostor, child.pk)

    const { state, effects } = handleWrap(emptyState(), wrap, child.sk, guardian.pk, AT)

    expect(state.entries).toEqual([])
    expect(effects).toEqual([])
  })

  it('CONFIG -> applyConfigDoc, LWW: a strictly newer doc replaces, an older/equal one is dropped', () => {
    const older = { v: 1 as const, issuedAt: AT, accounts: [account] }
    const newer = { v: 1 as const, issuedAt: AT + 10, accounts: [{ ...account, name: 'Renamed' }] }

    const wrapOlder = wrapFor({
      innerKind: KIND_CONFIG,
      payload: buildConfigPayload('accounts', older),
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })
    const wrapNewer = wrapFor({
      innerKind: KIND_CONFIG,
      payload: buildConfigPayload('accounts', newer),
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT + 10,
    })

    let state: AppState = { ...emptyState(), guardianPubkey: guardian.pk }
    ;({ state } = handleWrap(state, wrapNewer, child.sk, guardian.pk, AT))
    expect(state.docs.accounts).toEqual(newer)

    ;({ state } = handleWrap(state, wrapOlder, child.sk, guardian.pk, AT))
    expect(state.docs.accounts).toEqual(newer) // unchanged — anti-rollback
    expect(state.docHighWater.accounts).toBe(AT + 10)
  })

  it('CONFIG direction guard: a CONFIG authored by the child (not the pinned guardian) is ignored, docHighWater untouched — a hostile/buggy child cannot poison the guardian\'s anti-rollback mark', () => {
    // The GUARDIAN is on the receiving end here (`child.sk` is the sender's
    // key), impersonating a guardian->child CONFIG it never sent. Even
    // though the wrap is a validly signed, correctly-pinned event (it comes
    // from `pinnedPeerPk`), applying it would let a child dictate its own
    // config — and, worse, a far-future issuedAt would permanently poison
    // docHighWater.accounts (monotonic, never resets) for every future
    // legitimate guardian CONFIG.
    const hostileDoc = { v: 1 as const, issuedAt: Number.MAX_SAFE_INTEGER, accounts: [account] }
    const wrap = wrapFor({
      innerKind: KIND_CONFIG,
      payload: buildConfigPayload('accounts', hostileDoc),
      authorSk: child.sk,
      recipientPk: guardian.pk,
      nowSec: AT,
    })

    const guardianState: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    const { state } = handleWrap(guardianState, wrap, guardian.sk, child.pk, AT)

    expect(state.docs.accounts).toEqual(guardianState.docs.accounts) // unchanged
    expect(state.docHighWater.accounts).toBeUndefined() // never poisoned
  })

  it('CONFIG issuedAt clamp: a far-future issuedAt from the LEGITIMATE guardian is still ignored (skew allowance)', () => {
    const farFuture = { v: 1 as const, issuedAt: AT + MAX_ISSUED_AT_SKEW_SECS + 1, accounts: [account] }
    const wrap = wrapFor({
      innerKind: KIND_CONFIG,
      payload: buildConfigPayload('accounts', farFuture),
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })

    const childState: AppState = { ...emptyState(), role: 'child', guardianPubkey: guardian.pk }
    const { state } = handleWrap(childState, wrap, child.sk, guardian.pk, AT)

    expect(state.docs.accounts).toEqual(childState.docs.accounts) // unchanged
    expect(state.docHighWater.accounts).toBeUndefined()
  })

  it('CONFIG issuedAt clamp: exactly within the skew allowance still applies', () => {
    const withinSkew = { v: 1 as const, issuedAt: AT + MAX_ISSUED_AT_SKEW_SECS, accounts: [account] }
    const wrap = wrapFor({
      innerKind: KIND_CONFIG,
      payload: buildConfigPayload('accounts', withinSkew),
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })

    const childState: AppState = { ...emptyState(), role: 'child', guardianPubkey: guardian.pk }
    const { state } = handleWrap(childState, wrap, child.sk, guardian.pk, AT)

    expect(state.docs.accounts).toEqual(withinSkew)
  })

  it('ACK -> recorded into state.acks', () => {
    const wrap = wrapFor({
      innerKind: KIND_ACK,
      payload: buildAckPayload('entry-1', AT),
      authorSk: child.sk,
      recipientPk: guardian.pk,
      nowSec: AT,
    })

    const { state } = handleWrap(emptyState(), wrap, guardian.sk, child.pk, AT)

    expect(state.acks['entry-1']).toBe(AT)
  })

  it('CHILD_SIG (tick) -> appended, deduped by id', () => {
    const tick: ChoreTick = { id: 'tick-1', chore: 'chore-1', day: '2026-08-10', at: AT }
    const wrap = wrapFor({
      innerKind: KIND_CHILD_SIG,
      payload: buildChildTickPayload(tick),
      authorSk: child.sk,
      recipientPk: guardian.pk,
      nowSec: AT,
    })

    let state = withDocs(emptyState(), { chores: [{ id: 'chore-1', child: child.pk }] })
    let effects: Effect[]
    ;({ state, effects } = handleWrap(state, wrap, guardian.sk, child.pk, AT))
    expect(state.ticks).toEqual([tick])
    // authorPk provenance — a multi-peer guardian needs to know which child
    // actually signed this tick (see ingress.ts's CHILD_SIG case comment).
    expect(effects).toEqual([{ type: 'tick', tick, authorPk: child.pk }])

    // A second, distinct wrap event carrying the SAME tick id must not
    // duplicate it (idempotent fold on the domain id, independent of the
    // wrap's own event-id dedupe) — and, since the review fix of round 1,
    // must not re-fire its effect either: notifications hang off these, and
    // a resync replay of an aged-out tick would otherwise buzz a guardian
    // about a chore ticked last week. (ENTRY still emits its ACK on a
    // replay — the peer needs one whether or not we already had the entry —
    // but gates its own `entry` effect the same way this now does.)
    const wrapAgain = wrapFor({
      innerKind: KIND_CHILD_SIG,
      payload: buildChildTickPayload(tick),
      authorSk: child.sk,
      recipientPk: guardian.pk,
      nowSec: AT + 1,
    })
    ;({ state, effects } = handleWrap(state, wrapAgain, guardian.sk, child.pk, AT))
    expect(state.ticks).toEqual([tick])
    expect(effects).toEqual([])
  })

  it('REQUEST -> surfaced as a request effect, carrying the authenticated author', () => {
    const payload = buildRequestPayload({
      op: 'spend.request',
      reqId: 'r1',
      nonce: 'n1',
      child: child.pk,
      ts: AT,
      params: { amountMinor: 150, currency: 'GBP', account: account.id },
    })
    const wrap = wrapFor({ innerKind: KIND_REQUEST, payload, authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })

    const { effects } = handleWrap(emptyState(), wrap, guardian.sk, child.pk, AT)

    expect(effects).toEqual([{ type: 'request', payload, authorPk: child.pk }])
  })

  it('GRANT -> surfaced as a grant effect', () => {
    const payload = buildGrantPayload({ reqId: 'r1', nonce: 'n1', decision: 'allow', ts: AT, params: {} })
    const wrap = wrapFor({ innerKind: KIND_GRANT, payload, authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })

    const childState: AppState = { ...emptyState(), guardianPubkey: guardian.pk }
    const { effects } = handleWrap(childState, wrap, child.sk, guardian.pk, AT)

    expect(effects).toEqual([{ type: 'grant', payload }])
  })

  it('GRANT direction guard: a GRANT authored by the child (not the pinned guardian) is ignored', () => {
    const payload = buildGrantPayload({ reqId: 'r1', nonce: 'n1', decision: 'allow', ts: AT, params: {} })
    const wrap = wrapFor({ innerKind: KIND_GRANT, payload, authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })

    const guardianState: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    const { effects } = handleWrap(guardianState, wrap, guardian.sk, child.pk, AT)

    expect(effects).toEqual([])
  })

  it('SNAPSHOT -> folds entries/docs/children into state', () => {
    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const snapshot = buildSnapshotPayload({
      children: [{ pubkey: child.pk, name: 'Kid', index: 0 }],
      entries: [entry],
      docs: {
        accounts: { v: 1, issuedAt: AT, accounts: [account] },
        allowance: { v: 1, issuedAt: 0, configs: [] },
        interest: { v: 1, issuedAt: 0, configs: [] },
        chores: { v: 1, issuedAt: 0, chores: [] },
      },
    })
    const wrap = wrapFor({ innerKind: KIND_SNAPSHOT, payload: snapshot, authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })

    const childState: AppState = { ...emptyState(), role: 'child', guardianPubkey: guardian.pk }
    const { state } = handleWrap(childState, wrap, child.sk, guardian.pk, AT)

    expect(state.entries).toEqual([entry])
    expect(state.docs.accounts).toEqual(snapshot.state.docs.accounts)
    expect(state.children).toEqual([{ pubkey: child.pk, name: 'Kid', index: 0 }])
  })

  it('SNAPSHOT direction guard: a SNAPSHOT authored by the child (not the pinned guardian) is ignored', () => {
    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const snapshot = buildSnapshotPayload({
      children: [{ pubkey: child.pk, name: 'Kid', index: 0 }],
      entries: [entry],
      docs: {
        accounts: { v: 1, issuedAt: AT, accounts: [account] },
        allowance: { v: 1, issuedAt: 0, configs: [] },
        interest: { v: 1, issuedAt: 0, configs: [] },
        chores: { v: 1, issuedAt: 0, chores: [] },
      },
    })
    const wrap = wrapFor({ innerKind: KIND_SNAPSHOT, payload: snapshot, authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })

    const guardianState: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardian.pk }
    const { state } = handleWrap(guardianState, wrap, guardian.sk, child.pk, AT)

    expect(state.entries).toEqual([])
    expect(state.children).toEqual([])
  })

  it('SNAPSHOT issuedAt clamp: a doc with a far-future issuedAt is skipped, the rest of the snapshot still merges', () => {
    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const snapshot = buildSnapshotPayload({
      children: [{ pubkey: child.pk, name: 'Kid', index: 0 }],
      entries: [entry],
      docs: {
        accounts: { v: 1, issuedAt: AT + MAX_ISSUED_AT_SKEW_SECS + 1, accounts: [account] }, // future -> skipped
        allowance: { v: 1, issuedAt: AT, configs: [] }, // normal -> applied
        interest: { v: 1, issuedAt: 0, configs: [] },
        chores: { v: 1, issuedAt: 0, chores: [] },
      },
    })
    const wrap = wrapFor({ innerKind: KIND_SNAPSHOT, payload: snapshot, authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })

    const childState: AppState = { ...emptyState(), role: 'child', guardianPubkey: guardian.pk }
    const { state } = handleWrap(childState, wrap, child.sk, guardian.pk, AT)

    expect(state.docs.accounts).toEqual(childState.docs.accounts) // unchanged — clamped
    expect(state.docHighWater.accounts).toBeUndefined()
    expect(state.docs.allowance).toEqual(snapshot.state.docs.allowance) // still applied
    expect(state.entries).toEqual([entry]) // entries/children unaffected by the doc clamp
    expect(state.children).toEqual([{ pubkey: child.pk, name: 'Kid', index: 0 }])
  })

  it('an unrecognised inner kind is ignored silently (forward compat)', () => {
    const wrap = wrapFor({ innerKind: 99999, payload: { v: 1, whatever: true }, authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })

    const { state, effects } = handleWrap(emptyState(), wrap, child.sk, guardian.pk, AT)

    // Everything except seenEventIds is untouched — the wrap was still
    // legitimately verified (a real signed event from the pinned peer), so
    // its id is marked seen even though its unrecognised kind produced no
    // other state change.
    expect({ ...state, seenEventIds: [] }).toEqual(emptyState())
    expect(state.seenEventIds).toEqual([wrap.id])
    expect(effects).toEqual([])
  })

  it('event-id dedupe: redelivering the exact same wrap is a no-op (same state reference, no effects)', () => {
    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const wrap = wrapEntry(entry, guardian.sk, child.pk)

    const first = handleWrap(pinned(), wrap, child.sk, guardian.pk, AT)
    const second = handleWrap(first.state, wrap, child.sk, guardian.pk, AT)

    expect(second.state).toBe(first.state) // exact same reference — short-circuited before unwrap
    expect(second.effects).toEqual([])
    expect(second.state.entries).toHaveLength(1)
  })

  it('seenEventIds is a bounded LRU capped at 2000 — the oldest id falls off once the cap is exceeded', () => {
    // Pre-seed 2000 ids directly (bypassing real gift-wrap crypto, which is
    // far too slow to run 2000+ times in a unit test) so this test isolates
    // markSeen's trimming behaviour rather than re-testing dispatch.
    const seeded = Array.from({ length: 2000 }, (_, i) => `seeded-id-${i}`)
    const state: AppState = { ...emptyState(), seenEventIds: seeded }

    const wrap = wrapFor({ innerKind: 88888, payload: { v: 1 }, authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const { state: next } = handleWrap(state, wrap, child.sk, guardian.pk, AT)

    expect(next.seenEventIds).toHaveLength(2000)
    expect(next.seenEventIds).not.toContain('seeded-id-0') // fell off the front
    expect(next.seenEventIds).toContain('seeded-id-1999')
    expect(next.seenEventIds).toContain(wrap.id) // the new one is tracked

    // A redelivery of that same wrap is still deduped (same reference back).
    const redelivered = handleWrap(next, wrap, child.sk, guardian.pk, AT)
    expect(redelivered.state).toBe(next)
  })
})

// ============================================================================
// 3. ingress.ts — handlePairClaimWrap: CARRIED SECURITY OBLIGATION (Task 6)
// ============================================================================

describe('ingress.ts: handlePairClaimWrap — carried security obligation from Task 6 review', () => {
  it('a false consumeToken result prevents any offer from being built — and NOTHING reaches the relay', async () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)
    const device = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()

    // Nothing stored (already used / never minted) — consumeToken must
    // return false no matter what token string is presented.
    const tokenStore = makeTokenStore(null)

    const claimPayload = buildRequestPayload({
      op: 'pair.claim',
      reqId: 'r1',
      nonce: 'n1',
      child: device.pk,
      ts: AT,
      params: { token: 'a'.repeat(32), devicePk: device.pk },
    })
    const claimWrap = wrapFor({ innerKind: KIND_REQUEST, payload: claimPayload, authorSk: device.sk, recipientPk: guardian.pk, nowSec: AT })
    await relay.publish(claimWrap)
    expect(relay.events).toHaveLength(1) // just the claim itself, so far

    const answered = handlePairClaimWrap({
      wrap: claimWrap,
      guardianSk: guardian.sk,
      tokenStore,
      mnemonic,
      childIndex: 0,
      childName: 'Kid',
      snapshot: emptySnapshot(),
      relays: RELAYS,
      nowSec: AT,
    })

    // THE hard gate: no offer was built at all.
    expect(answered).toBeNull()

    // Mirroring the real caller (engine/app layer): an offer is only ever
    // sent when `answered` is non-null. Since it is null here, nothing
    // further is sent — assert the relay saw no PAIR_OFFER (indeed no new
    // event of any kind) as a result of this claim.
    if (answered !== null) {
      await sendPairOffer(answered.offer, {
        selfSk: guardian.sk,
        peerPk: answered.recipientPk,
        relay,
        storage: guardianStorage,
        nowSec: AT,
      })
    }
    expect(relay.events).toHaveLength(1)
  })

  it('two claims presenting the same token yield at most one offer (atomic single-use)', () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)
    const deviceA = newKeypair()
    const deviceB = newKeypair()
    const minted = mintToken(AT)
    const tokenStore = makeTokenStore(minted)

    function claimWrapFor(device: { sk: Uint8Array; pk: string }, name: string): NostrEvent {
      const payload = buildRequestPayload({
        op: 'pair.claim',
        reqId: `r-${name}`,
        nonce: `n-${name}`,
        child: device.pk,
        ts: AT,
        params: { token: minted.token, devicePk: device.pk, name },
      })
      return wrapFor({ innerKind: KIND_REQUEST, payload, authorSk: device.sk, recipientPk: guardian.pk, nowSec: AT })
    }

    const wrapA = claimWrapFor(deviceA, 'A')
    const wrapB = claimWrapFor(deviceB, 'B')

    const opts = (wrap: NostrEvent, childName: string) => ({
      wrap,
      guardianSk: guardian.sk,
      tokenStore,
      mnemonic,
      childIndex: 0,
      childName,
      snapshot: emptySnapshot(),
      relays: RELAYS,
      nowSec: AT,
    })

    const resultA = handlePairClaimWrap(opts(wrapA, 'A'))
    const resultB = handlePairClaimWrap(opts(wrapB, 'B'))

    const offers = [resultA, resultB].filter((r) => r !== null)
    expect(offers).toHaveLength(1)
    expect(resultA).not.toBeNull()
    expect(resultA?.recipientPk).toBe(deviceA.pk)
    expect(resultB).toBeNull() // the token was already gone by the time B's claim was checked
  })

  it('answerPairClaim is never reached for a non-pair.claim REQUEST', () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)
    const device = newKeypair()
    const minted = mintToken(AT)
    const tokenStore = makeTokenStore(minted)

    const payload = buildRequestPayload({
      op: 'spend.request',
      reqId: 'r1',
      nonce: 'n1',
      child: device.pk,
      ts: AT,
      params: { amountMinor: 100, currency: 'GBP', account: 'acc1' },
    })
    const wrap = wrapFor({ innerKind: KIND_REQUEST, payload, authorSk: device.sk, recipientPk: guardian.pk, nowSec: AT })

    const answered = handlePairClaimWrap({
      wrap,
      guardianSk: guardian.sk,
      tokenStore,
      mnemonic,
      childIndex: 0,
      childName: 'Kid',
      snapshot: emptySnapshot(),
      relays: RELAYS,
      nowSec: AT,
    })

    expect(answered).toBeNull()
    expect(tokenStore.get()).toEqual(minted) // untouched — the gate never ran for a non-claim
  })
})

// ============================================================================
// 4. ingress.ts — handlePairOfferWrap: child-side PAIR_OFFER intake
// ============================================================================

describe('ingress.ts: handlePairOfferWrap', () => {
  function offerSnapshot(): SnapshotPayload {
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

  it('a correctly-authored offer from the QR-scanned guardian parses to its payload', () => {
    const guardian = newKeypair()
    const device = newKeypair()
    const offer = buildPairOfferPayload({
      childSkHex: '1'.repeat(64),
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot: offerSnapshot(),
    })
    const wrap = wrapFor({ innerKind: KIND_PAIR_OFFER, payload: offer, authorSk: guardian.sk, recipientPk: device.pk, nowSec: AT })

    const result = handlePairOfferWrap({ wrap, deviceSk: device.sk, expectedGuardianPk: guardian.pk })

    expect(result).toEqual(offer)
  })

  it('an offer sealed by someone OTHER than the QR-scanned guardian is rejected', () => {
    const guardian = newKeypair()
    const impostor = newKeypair()
    const device = newKeypair()
    const offer = buildPairOfferPayload({
      childSkHex: '1'.repeat(64),
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot: offerSnapshot(),
    })
    // Sealed by the impostor, not the guardian the QR named.
    const wrap = wrapFor({ innerKind: KIND_PAIR_OFFER, payload: offer, authorSk: impostor.sk, recipientPk: device.pk, nowSec: AT })

    const result = handlePairOfferWrap({ wrap, deviceSk: device.sk, expectedGuardianPk: guardian.pk })

    expect(result).toBeNull()
  })

  it('a wrap carrying a non-offer inner kind is rejected', () => {
    const guardian = newKeypair()
    const device = newKeypair()
    // Correctly authored by the expected guardian, but the wrong inner kind.
    const grantPayload = buildGrantPayload({ reqId: 'r1', nonce: 'n1', decision: 'allow', ts: AT, params: {} })
    const wrap = wrapFor({ innerKind: KIND_GRANT, payload: grantPayload, authorSk: guardian.sk, recipientPk: device.pk, nowSec: AT })

    const result = handlePairOfferWrap({ wrap, deviceSk: device.sk, expectedGuardianPk: guardian.pk })

    expect(result).toBeNull()
  })

  it('a malformed offer payload (fails parsePairOfferPayload) is rejected, not thrown', () => {
    const guardian = newKeypair()
    const device = newKeypair()
    const malformed = { v: 1, childSkHex: 'not-hex', childIndex: 0, name: 'Sam', relays: RELAYS, snapshot: offerSnapshot() }
    const wrap = wrapFor({ innerKind: KIND_PAIR_OFFER, payload: malformed, authorSk: guardian.sk, recipientPk: device.pk, nowSec: AT })

    expect(() => handlePairOfferWrap({ wrap, deviceSk: device.sk, expectedGuardianPk: guardian.pk })).not.toThrow()
    expect(handlePairOfferWrap({ wrap, deviceSk: device.sk, expectedGuardianPk: guardian.pk })).toBeNull()
  })
})

// ============================================================================
// 5. engine.ts — startSync smoke test
// ============================================================================

describe('engine.ts: startSync', () => {
  it('dispatches an inbound ENTRY, auto-sends the ack, and surfaces a non-ack effect via onEffect', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const childStorage = makeFakeStorage()
    const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }

    let childState: AppState = withDocs({ ...emptyState(), role: 'child', guardianPubkey: guardian.pk }, { accounts: [account] })
    const effects: Effect[] = []

    const stop = startSync({
      getState: () => childState,
      // Functional updater — Task 1 of Plan 4 (child-mode): mirrors
      // multi.ts's own `setState` contract (see engine.ts's module header),
      // applied immediately here since this test has nothing batching
      // dispatches (the ingest-race test right below exercises the batched
      // case this shape actually exists for).
      setState: (update) => {
        childState = update(childState)
      },
      selfSk: child.sk,
      pinnedPeerPk: guardian.pk,
      relay,
      storage: childStorage,
      onEffect: (e) => effects.push(e),
      nowSec: () => AT,
    })

    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const guardianStorage = makeFakeStorage()
    await sendEntry(entry, { selfSk: guardian.sk, peerPk: child.pk, relay, storage: guardianStorage, nowSec: AT })
    relay.deliverAll()
    // Let the fire-and-forget ack's internal await chain settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(childState.entries).toEqual([entry])
    // The ack the engine auto-sent landed on the relay, p-tagged to the guardian.
    const ackWraps = relay.events.filter((ev) => pTagOf(ev) === guardian.pk)
    expect(ackWraps).toHaveLength(1)

    // A GRANT from the guardian is NOT auto-handled — it must surface via onEffect.
    const grantPayload = buildGrantPayload({ reqId: 'r1', nonce: 'n1', decision: 'allow', ts: AT, params: {} })
    await sendGrant(grantPayload, { selfSk: guardian.sk, peerPk: child.pk, relay, storage: guardianStorage, nowSec: AT })
    relay.deliverAll()

    // v0.2: the ENTRY above also surfaces an additive `entry` effect through
    // onEffect (only the ack is auto-consumed by the engine) — the GRANT
    // assertion this test exists for is the second one.
    expect(effects).toEqual([
      { type: 'entry', entry, authorPk: guardian.pk },
      { type: 'grant', payload: grantPayload },
    ])

    stop()
  })

  // The child-side counterpart to multi.test.ts's own "two wraps delivered
  // before a batched setState is actually applied still BOTH land" — see
  // that test's comment for the full mechanism. engine.ts is single-peer
  // (one child <-> its one guardian) rather than multi.ts's membership-
  // checked multi-peer shape, but the SAME hazard applies: before the Task 1
  // refactor, this module computed a whole precomputed `next` AppState from
  // `getState()` and handed THAT to `setState`, so two ENTRY wraps from the
  // guardian delivered back-to-back — before either dispatched update was
  // actually reflected back through `getState()` — would each compute their
  // `next` from the SAME stale snapshot, and applying the batch in order
  // would let the second overwrite the first's entry outright.
  it('two ENTRY wraps delivered before a batched setState is actually applied still BOTH land — the ingest race functional setState fixes', () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }

    let committedState: AppState = withDocs({ ...emptyState(), role: 'child', guardianPubkey: guardian.pk }, { accounts: [account] })
    const pendingUpdates: Array<(app: AppState) => AppState> = []

    const stop = startSync({
      getState: () => committedState, // deliberately never advanced mid-batch
      setState: (update) => {
        pendingUpdates.push(update)
      },
      selfSk: child.sk,
      pinnedPeerPk: guardian.pk,
      relay,
      storage: makeFakeStorage(),
      onEffect: () => {},
      nowSec: () => AT,
    })

    const entryA = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const entryB = creditEntry({ id: newId(AT * 1000 + 1), child: child.pk, createdAt: AT, author: 'guardian' }, account, 700)

    // Both entries published to the SAME relay, then delivered together —
    // `deliverAll()` invokes this module's subscription callback once per
    // event, synchronously, back to back, exactly the scenario where two
    // `setState` calls can land before either is reflected in `getState()`.
    // A FRESH `makeFakeStorage()` per send (mirroring multi.test.ts's own
    // version of this test) — sharing one outbox between two overlapping,
    // un-awaited sends would trigger a SEPARATE, already-documented hazard
    // (publish.ts/outbox.ts: two flush() calls in flight can both read the
    // same still-queued item and both publish it), which is not the race
    // this test exists to exercise.
    void sendEntry(entryA, { selfSk: guardian.sk, peerPk: child.pk, relay, storage: makeFakeStorage(), nowSec: AT })
    void sendEntry(entryB, { selfSk: guardian.sk, peerPk: child.pk, relay, storage: makeFakeStorage(), nowSec: AT })
    relay.deliverAll()

    expect(pendingUpdates).toHaveLength(2)

    // Flush the "batch": apply each queued updater against the PRIOR
    // result, exactly as a real reducer processes dispatched actions in
    // order — this is the composition the fix relies on.
    for (const update of pendingUpdates) committedState = update(committedState)

    expect(committedState.entries.map((e) => e.id).sort()).toEqual([entryA.id, entryB.id].sort())
    stop()
  })
})

// ============================================================================
// 6. Convergence — the plan's Task 7 EXIT GATE
// ============================================================================

describe('convergence: two peers, offline outbox, shuffled delivery, full replay idempotence', () => {
  it('guardian and child converge on the same ledger regardless of delivery order, and a full replay changes nothing', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const guardianStorage = makeFakeStorage()
    const childStorage = makeFakeStorage()

    const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }

    let guardianState: AppState = withDocs(
      {
        ...emptyState(),
        role: 'guardian',
        guardianPubkey: guardian.pk,
        self: { pubkey: guardian.pk, childIndex: null },
        children: [{ pubkey: child.pk, name: 'Kid', index: 0 }],
      },
      { chores: [{ id: 'chore-1', child: child.pk }] },
    )
    let childState: AppState = {
      ...emptyState(),
      role: 'child',
      guardianPubkey: guardian.pk,
      self: { pubkey: child.pk, childIndex: 0 },
    }

    const gOpts = (relayArg = relay): PublishOpts => ({ selfSk: guardian.sk, peerPk: child.pk, relay: relayArg, storage: guardianStorage, nowSec: AT })
    const cOpts = (relayArg = relay): PublishOpts => ({ selfSk: child.sk, peerPk: guardian.pk, relay: relayArg, storage: childStorage, nowSec: AT })

    // --- Guardian (online): config docs + allowance entries, applied
    // locally first (as the real app would) and then sent to the child. ---
    const accountsDoc: ConfigDocs['accounts'] = { v: 1, issuedAt: AT, accounts: [account] }
    guardianState = applyConfigDoc(guardianState, 'accounts', accountsDoc)
    await sendConfig('accounts', accountsDoc, gOpts())

    const allowanceDoc: ConfigDocs['allowance'] = { v: 1, issuedAt: AT, configs: [] }
    guardianState = applyConfigDoc(guardianState, 'allowance', allowanceDoc)
    await sendConfig('allowance', allowanceDoc, gOpts())

    const entries: Entry[] = []
    for (let i = 0; i < 3; i++) {
      const entry = creditEntry(
        { id: newId(AT * 1000 + i), child: child.pk, createdAt: AT + i, author: 'guardian' },
        account,
        500 + i * 100,
        'allowance',
      )
      entries.push(entry)
      guardianState = addEntry(guardianState, entry)
      await sendEntry(entry, gOpts())
    }

    // --- Child (OFFLINE): a chore tick + a spend request, applied locally
    // (tick) and queued (both) rather than sent — the durable outbox. ---
    relay.goOffline()

    const tick: ChoreTick = { id: 'tick-1', chore: 'chore-1', day: '2026-08-10', at: AT }
    childState = { ...childState, ticks: [...childState.ticks, tick] }
    const tickResult = await sendTick(tick, cOpts())
    expect(tickResult.sent).toBe(false)

    const spendRequest = buildRequestPayload({
      op: 'spend.request',
      reqId: 'req-1',
      nonce: 'nonce-1',
      child: child.pk,
      ts: AT,
      params: { amountMinor: 150, currency: 'GBP', account: account.id },
    })
    const requestResult = await sendRequest(spendRequest, cOpts())
    expect(requestResult.sent).toBe(false)

    expect(outboxEvents(childStorage)).toHaveLength(2) // durably queued, not lost

    // --- Child comes online, flushes. ---
    relay.goOnline()
    const flushed = await flush(relay, AT + 5, childStorage)
    expect(flushed).toBe(2)
    expect(outboxEvents(childStorage)).toHaveLength(0)

    // --- Delivery: everything published so far, reordered by a seeded PRNG
    // (no Math.random) rather than delivered in publish order. ---
    const round1 = shuffled([...relay.events], 20260810)
    expect(round1).toHaveLength(7) // 2 config docs + 3 entries (guardian) + tick + spend request (child)

    const guardianEffects: Effect[] = []
    const childEffects: Effect[] = []
    const now2 = AT + 10

    for (const wrap of round1) {
      const to = pTagOf(wrap)
      if (to === child.pk) {
        const { state, effects } = handleWrap(childState, wrap, child.sk, guardian.pk, now2)
        childState = state
        childEffects.push(...effects)
      } else if (to === guardian.pk) {
        const { state, effects } = handleWrap(guardianState, wrap, guardian.sk, child.pk, now2)
        guardianState = state
        guardianEffects.push(...effects)
      }
    }

    // Every guardian ENTRY the child received produced an ack effect — send
    // those acks back now (both sides online).
    for (const effect of childEffects) {
      if (effect.type === 'ack') {
        await sendAck(effect.entryId, cOpts())
      }
    }

    // Guardian receives the acks (a second delivery round).
    const ackWraps = relay.events.filter((ev) => !round1.includes(ev) && pTagOf(ev) === guardian.pk)
    for (const wrap of shuffled(ackWraps, 999)) {
      const { state } = handleWrap(guardianState, wrap, guardian.sk, child.pk, now2 + 1)
      guardianState = state
    }

    // --- Convergence assertions ---
    const sortedIds = (es: Entry[]) => [...es].map((e) => e.id).sort()
    expect(sortedIds(childState.entries)).toEqual(sortedIds(entries))
    expect(sortedIds(guardianState.entries)).toEqual(sortedIds(entries))

    const balancesEqual = (a: Map<string, number>, b: Map<string, number>) =>
      expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b))
    balancesEqual(balances(guardianState.entries), balances(childState.entries))

    expect(childState.docHighWater).toEqual(guardianState.docHighWater)
    expect(childState.docHighWater.accounts).toBe(AT)
    expect(childState.docHighWater.allowance).toBe(AT)

    for (const entry of entries) {
      expect(guardianState.acks[entry.id]).toBeDefined()
    }

    expect(guardianState.ticks).toEqual([tick])
    expect(guardianEffects.some((e) => e.type === 'request' && e.payload.op === 'spend.request')).toBe(true)

    // --- Idempotence: replay EVERY event published over the whole test
    // again (fresh shuffle), and assert nothing changes. ---
    const guardianBefore = JSON.parse(JSON.stringify(guardianState)) as AppState
    const childBefore = JSON.parse(JSON.stringify(childState)) as AppState

    const fullLog = shuffled([...relay.events], 42)
    for (const wrap of fullLog) {
      const to = pTagOf(wrap)
      if (to === child.pk) {
        childState = handleWrap(childState, wrap, child.sk, guardian.pk, now2 + 2).state
      } else if (to === guardian.pk) {
        guardianState = handleWrap(guardianState, wrap, guardian.sk, child.pk, now2 + 2).state
      }
    }

    expect(guardianState).toEqual(guardianBefore)
    expect(childState).toEqual(childBefore)
  })
})
