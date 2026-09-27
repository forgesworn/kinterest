// store/store.tsx — the pure reducer + action-builder half (everything
// above `AppProvider`), exercised entirely without React/DOM per the plan's
// "Store logic must be testable without DOM". `AppProvider`/`useApp`
// themselves touch `window`/`localStorage` and are left to a real browser
// (this suite runs with `environment: 'node'` — see vite.config.ts).

import { describe, expect, it } from 'vitest'
import { newKeypair } from '../identity/keys'
import { makeFakeRelay } from '../wire/fakeRelay'
import { outboxEvents, type StorageLike } from '../wire/outbox'
import { buildRequestPayload, type RequestPayload } from '../wire/payloads'
import { wrapFor } from '../wire/giftwrap'
import { KIND_REQUEST } from '../wire/kinds'
import { newId } from '../domain/id'
import { creditEntry } from '../domain/ledger'
import type { Account, Entry } from '../domain/types'
import type { AllowanceConfig } from '../domain/allowance'
import { activeChildren, addEntry, applyConfigDoc, emptyState, recordGrantResult, recordRequestDecision, upsertRequest } from '../state/state'
import { handleWrap } from '../sync/ingress'
import type { AppState, ChildProfile } from '../state/types'
import type { Chore, ChoreTick } from '../domain/chores'
import { choreGateReadyClaims, periodDaysEndingAt } from '../screens/chores'
import { runSchedulers } from './scheduler'
import {
  addEntryAndSend,
  beginPairingSession,
  buildGrantDecision,
  childSessionReducer,
  initialChildSession,
  initialStoreState,
  notificationContextFor,
  publishConfigDoc,
  reMintPairingSession,
  runSchedulersAndSend,
  shouldRunRelayService,
  snapshotOf,
  pairingChildPk,
  grantAwaitsEntry,
  readVaultPublished,
  writeVaultPublished,
  stampConfigDoc,
  storeReducer,
  type PairingSessionState,
  type StoreState,
  type WireOpts,
} from './store'

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

function wireOpts(selfSk: Uint8Array, relay = makeFakeRelay(), storage = makeFakeStorage(), nowSec = AT): WireOpts {
  return { selfSk, relay, storage, nowSec }
}

// ============================================================================
// storeReducer
// ============================================================================

describe('storeReducer', () => {
  it('updateApp swaps the app slice via its updater, same-reference no-op when unchanged', () => {
    const state: StoreState = initialStoreState(emptyState())
    const same = storeReducer(state, { type: 'updateApp', update: (app) => app })
    expect(same).toBe(state)

    const changed = { ...emptyState(), role: 'guardian' as const }
    const next = storeReducer(state, { type: 'updateApp', update: () => changed })
    expect(next.app).toBe(changed)
    expect(next).not.toBe(state)
  })

  it('updateApp\'s updater receives the reducer\'s OWN current app, not whatever the caller saw when it dispatched — the fix for the ingest race', () => {
    // Simulates two "concurrent" writers racing to update the ledger: A
    // computed its intent from state0 and dispatches an ADDITIVE updater
    // (not a precomputed snapshot); B does the same, dispatched second.
    // Both updaters must compose — B's must see A's entry already applied,
    // exactly as `useReducer` guarantees (each action's reducer call sees
    // the state left by the one before it) — never overwrite it, which is
    // exactly the bug a naive `{ type: 'replaceApp', app: precomputedNext }`
    // design had (sync/multi.ts's and AppProvider's scheduler effect's
    // former shape): two precomputed-from-the-same-snapshot dispatches
    // would clobber one another instead of composing.
    const account: Account = { id: 'acc1', child: 'sam', name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
    const entryA = creditEntry({ id: 'a1', child: 'sam', createdAt: AT, author: 'guardian' }, account, 100)
    const entryB = creditEntry({ id: 'b1', child: 'sam', createdAt: AT, author: 'guardian' }, account, 200)

    const state0: StoreState = initialStoreState(emptyState())

    // Both "writers" build their updater from the SAME state0 snapshot —
    // simulating two callbacks that each read a stale ref before either
    // dispatch had been processed.
    const afterA = storeReducer(state0, { type: 'updateApp', update: (app) => addEntry(app, entryA) })
    const afterB = storeReducer(afterA, { type: 'updateApp', update: (app) => addEntry(app, entryB) })

    // Both entries survive — B's updater ran against afterA's app (via the
    // reducer), not against state0.
    expect(afterB.app.entries.map((e) => e.id).sort()).toEqual(['a1', 'b1'])
  })

  it('beginPairing/endPairing set and clear the pairing slice', () => {
    const state: StoreState = initialStoreState(emptyState())
    const session: PairingSessionState = {
      token: { token: 'a'.repeat(32), mintedAt: AT },
      mnemonic: 'irrelevant for this test',
      childIndex: 0,
      childName: 'Sam',
      relays: ['wss://relay.example.com'],
      status: 'active',
    }
    const begun = storeReducer(state, { type: 'beginPairing', session })
    expect(begun.pairing).toEqual(session)

    const ended = storeReducer(begun, { type: 'endPairing' })
    expect(ended.pairing).toBeNull()
    expect(storeReducer(ended, { type: 'endPairing' })).toBe(ended) // no-op, already null
  })

  it('burnPairing marks the session burned, is a no-op when already burned or absent', () => {
    const session: PairingSessionState = {
      token: { token: 'a'.repeat(32), mintedAt: AT },
      mnemonic: 'x',
      childIndex: 0,
      childName: 'Sam',
      relays: [],
      status: 'active',
    }
    const state: StoreState = { app: emptyState(), pairing: session, notice: null }
    const burned = storeReducer(state, { type: 'burnPairing' })
    expect(burned.pairing?.status).toBe('burned')

    const burnedAgain = storeReducer(burned, { type: 'burnPairing' })
    expect(burnedAgain).toBe(burned) // no-op

    const noSession: StoreState = { app: emptyState(), pairing: null, notice: null }
    expect(storeReducer(noSession, { type: 'burnPairing' })).toBe(noSession)
  })
})

describe('storeReducer — one-off notice (U8)', () => {
  it('setNotice holds the message; clearNotice drops it and is a no-op when already clear', () => {
    const start = initialStoreState(emptyState())
    expect(start.notice).toBeNull()
    const withNotice = storeReducer(start, { type: 'setNotice', notice: 'Your family is back.' })
    expect(withNotice.notice).toBe('Your family is back.')
    expect(withNotice.app).toBe(start.app)
    const cleared = storeReducer(withNotice, { type: 'clearNotice' })
    expect(cleared.notice).toBeNull()
    expect(storeReducer(cleared, { type: 'clearNotice' })).toBe(cleared)
  })
})

// ============================================================================
// Pairing session constructors
// ============================================================================

describe('beginPairingSession / reMintPairingSession', () => {
  const child: ChildProfile = { pubkey: 'a'.repeat(64), name: 'Sam', index: 0 }
  const app: AppState = { ...emptyState(), role: 'guardian', children: [child] }

  it('builds a session for a known child', () => {
    const session = beginPairingSession(app, child.pubkey, 'family mnemonic words', ['wss://relay.example.com'], AT)
    expect(session).not.toBeNull()
    expect(session?.childIndex).toBe(0)
    expect(session?.childName).toBe('Sam')
    expect(session?.status).toBe('active')
    expect(session?.token.token).toHaveLength(32)
  })

  it('returns null for an unknown child pubkey', () => {
    expect(beginPairingSession(app, 'b'.repeat(64), 'x', [], AT)).toBeNull()
  })

  it('re-minting produces a fresh token and resets status to active', () => {
    const session = beginPairingSession(app, child.pubkey, 'x', [], AT)!
    const burned: PairingSessionState = { ...session, status: 'burned' }
    const reMinted = reMintPairingSession(burned, AT + 1)
    expect(reMinted.status).toBe('active')
    expect(reMinted.token.token).not.toBe(session.token.token)
    expect(reMinted.childIndex).toBe(session.childIndex)
    expect(reMinted.childName).toBe(session.childName)
  })
})

describe('snapshotOf', () => {
  it('builds a SnapshotPayload mirroring the app state', () => {
    const account: Account = { id: 'acc1', child: 'sam', name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
    const entry = creditEntry({ id: newId(AT * 1000), child: 'sam', createdAt: AT, author: 'guardian' }, account, 500)
    const app: AppState = {
      ...emptyState(),
      children: [{ pubkey: 'sam', name: 'Sam', index: 0 }],
      entries: [entry],
      docs: { ...emptyState().docs, accounts: { v: 1, issuedAt: AT, accounts: [account] } },
    }

    const snap = snapshotOf(app, 'sam')

    expect(snap.state.children).toEqual(app.children)
    expect(snap.state.entries).toEqual([entry])
    expect(snap.state.docs).toEqual(app.docs)
  })

  // Audit P6: the snapshot sent to one child carries nothing of a sibling's.
  it('scopes to the addressed child: no sibling profile, entry, account, config or chore', () => {
    const samAcc: Account = { id: 'acc-sam', child: 'sam', name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
    const alexAcc: Account = { id: 'acc-alex', child: 'alex', name: 'Savings', currency: 'GBP', custody: 'ledger' }
    const samEntry = creditEntry({ id: newId(AT * 1000), child: 'sam', createdAt: AT, author: 'guardian' }, samAcc, 500)
    const alexEntry = creditEntry({ id: newId(AT * 1000 + 1), child: 'alex', createdAt: AT, author: 'guardian' }, alexAcc, 700)
    const cfg = (child: string, account: string) => ({ child, account, amountMinor: 100, cadence: 'weekly' as const, day: 5, tz: 'Europe/London', startDay: '2026-09-01' })
    const app: AppState = {
      ...emptyState(),
      children: [
        { pubkey: 'sam', name: 'Sam', index: 0 },
        { pubkey: 'alex', name: 'Alex', index: 1 },
      ],
      entries: [samEntry, alexEntry],
      docs: {
        accounts: { v: 1, issuedAt: AT, accounts: [samAcc, alexAcc], revoked: { alex: AT } },
        allowance: { v: 1, issuedAt: AT, configs: [cfg('sam', 'acc-sam'), cfg('alex', 'acc-alex')] },
        interest: { v: 1, issuedAt: AT, configs: [{ ...cfg('alex', 'acc-alex'), rateBps: 100 }] },
        chores: { v: 1, issuedAt: AT, chores: [{ id: 'c1', child: 'alex', name: 'Dishes', cadence: 'daily' }] },
      },
    }

    const snap = snapshotOf(app, 'sam')
    const text = JSON.stringify(snap)
    expect(text).not.toContain('alex')
    expect(text).not.toContain('Alex')
    expect(snap.state.entries).toEqual([samEntry])
    expect(snap.state.docs.accounts.accounts).toEqual([samAcc])
    expect(snap.state.docs.accounts.revoked).toBeUndefined()
    // issuedAt is kept, so the narrowed doc slots into the child's LWW.
    expect(snap.state.docs.allowance.issuedAt).toBe(AT)
    // A revoked child's own revocation row does travel — it is how it learns.
    expect(snapshotOf(app, 'alex').state.docs.accounts.revoked).toEqual({ alex: AT })
  })

  it('pairingChildPk resolves the roster entry a ceremony binds to', () => {
    const app: AppState = { ...emptyState(), children: [{ pubkey: 'sam', name: 'Sam', index: 3 }] }
    expect(pairingChildPk(app, 3)).toBe('sam')
    expect(pairingChildPk(app, 4)).toBeNull()
  })

  // v0.2 §1.5: the family root rides along, so a child that syncs a snapshot
  // learns the same root a freshly paired one gets from its offer.
  it('attaches the family root when there is a signet one, and not otherwise', () => {
    const authEvent = { id: 'b'.repeat(64), pubkey: 'a'.repeat(64), kind: 21236, created_at: 1, tags: [], content: '', sig: 'c'.repeat(128) }
    const withRoot: AppState = {
      ...emptyState(),
      root: { kind: 'signet', pubkey: 'a'.repeat(64), authEvent, backedUpAt: 5 },
    }
    expect(snapshotOf(withRoot, 'sam').root).toEqual({ pubkey: 'a'.repeat(64), authEvent })
    expect(snapshotOf(emptyState(), 'sam').root).toBeUndefined()
    expect(snapshotOf({ ...emptyState(), root: { kind: 'phrase' } }, 'sam').root).toBeUndefined()
  })
})

// ============================================================================
// addEntryAndSend
// ============================================================================

describe('addEntryAndSend', () => {
  it('applies the entry locally and sends it to entry.child', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const relay = makeFakeRelay()
    const storage = makeFakeStorage()

    const { app, sent } = await addEntryAndSend(emptyState(), entry, wireOpts(guardian.sk, relay, storage))

    expect(app.entries).toEqual([entry])
    expect(sent).toBe(true)
    expect(relay.events).toHaveLength(1)
    const pTag = relay.events[0]!.tags.find((t) => t[0] === 'p')?.[1]
    expect(pTag).toBe(child.pk)
  })

  it('reports sent: false and leaves the item queued when the relay is offline', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
    const entry = creditEntry({ id: newId(AT * 1000), child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
    const relay = makeFakeRelay()
    relay.goOffline()
    const storage = makeFakeStorage()

    const { app, sent } = await addEntryAndSend(emptyState(), entry, wireOpts(guardian.sk, relay, storage))

    expect(app.entries).toEqual([entry]) // still applied locally — optimistic
    expect(sent).toBe(false)
    expect(outboxEvents(storage)).toHaveLength(1)
  })
})

// ============================================================================
// publishConfigDoc
// ============================================================================

// ============================================================================
// stampConfigDoc — the shared stamping rule publishConfigDoc AND a live
// screen's own split "compute the doc, dispatch separately" wiring (Task 6's
// ChildSettings.tsx#submitConfig) both build on. publishConfigDoc's own
// tests below exercise this indirectly too; these cover the function
// directly since it is now its own public contract two independent callers
// rely on.
// ============================================================================

describe('stampConfigDoc', () => {
  it('stamps v: 1 and issuedAt = nowSec when no doc of this kind has been seen yet', () => {
    const app: AppState = { ...emptyState() }
    const doc = stampConfigDoc(app, 'accounts', { accounts: [] }, AT)
    expect(doc).toEqual({ v: 1, issuedAt: AT, accounts: [] })
  })

  it('bumps strictly past the existing high-water mark rather than using nowSec verbatim', () => {
    const app: AppState = { ...emptyState(), docHighWater: { accounts: AT + 100 } }
    const doc = stampConfigDoc(app, 'accounts', { accounts: [] }, AT)
    expect(doc.issuedAt).toBe(AT + 101)
  })

  it('U1: revoke -> rename an account -> activeChildren still excludes the device', () => {
    const acct: Account = { id: 'acc1', child: 'kid1', name: 'Spending', currency: 'GBP', custody: 'ledger' }
    const kids: ChildProfile[] = [
      { pubkey: 'kid1', name: 'Sam', index: 0 },
      { pubkey: 'kid2', name: 'Ella', index: 1 },
    ]
    let app: AppState = { ...emptyState(), children: kids }
    app = applyConfigDoc(app, 'accounts', stampConfigDoc(app, 'accounts', { accounts: [acct], revoked: { kid1: AT } }, AT))
    expect(activeChildren(app).map((c) => c.pubkey)).toEqual(['kid2'])
    // A screen saving an accounts edit sends only `{ accounts }`.
    app = applyConfigDoc(app, 'accounts', stampConfigDoc(app, 'accounts', { accounts: [{ ...acct, name: 'Pocket' }] }, AT + 5))
    expect(app.docs.accounts.accounts[0]!.name).toBe('Pocket')
    expect(activeChildren(app).map((c) => c.pubkey)).toEqual(['kid2'])
    expect(app.docs.accounts.revoked).toEqual({ kid1: AT })
  })

  it('D1: an allowance save that switches account re-anchors startDay (history is not reopened)', () => {
    const cfg: AllowanceConfig = { child: 'kid1', account: 'acc1', amountMinor: 500, cadence: 'weekly', day: 2, tz: 'UTC', startDay: '2026-06-30' }
    let app: AppState = { ...emptyState() }
    app = applyConfigDoc(app, 'allowance', stampConfigDoc(app, 'allowance', { configs: [cfg] }, AT))
    const wed = Date.UTC(2026, 8, 23, 12) / 1000
    const doc = stampConfigDoc(app, 'allowance', { configs: [{ ...cfg, account: 'acc2' }] }, wed)
    expect(doc.configs[0]!.startDay).toBe('2026-09-27')
  })

  it('is pure — the same inputs always produce the same stamped doc', () => {
    const app: AppState = { ...emptyState(), docHighWater: { allowance: AT } }
    const configs: AllowanceConfig[] = []
    const a = stampConfigDoc(app, 'allowance', { configs }, AT)
    const b = stampConfigDoc(app, 'allowance', { configs }, AT)
    expect(a).toEqual(b)
  })

  // Review finding (Minor): calling stampConfigDoc ONCE, before dispatch,
  // against a captured `app` snapshot — the shape ChildSettings.tsx's own
  // submitConfig used before this fix — loses the second of two same-frame
  // saves to the SAME doc kind (both stamp the identical issuedAt off the
  // identical stale docHighWater, so the second's applyConfigDoc drops it
  // as <= the high-water mark the first just set). Calling it INSIDE each
  // dispatched updater instead — ChildSettings.tsx's `saveDoc`'s own
  // pattern, reproduced here directly against storeReducer without any
  // React/DOM involved — must NOT lose the second edit, because
  // storeReducer processes actions strictly in order.
  it('two same-frame updateApp saves to the same doc kind BOTH survive when stamped inside each dispatched updater', () => {
    const account1: Account = { id: 'acc1', child: 'sam', name: 'First', currency: 'GBP', custody: 'ledger' }
    const account2: Account = { id: 'acc2', child: 'sam', name: 'Second', currency: 'GBP', custody: 'ledger' }

    function saveAction(accounts: Account[]): { type: 'updateApp'; update: (a: AppState) => AppState } {
      return {
        type: 'updateApp',
        update: (a) => applyConfigDoc(a, 'accounts', stampConfigDoc(a, 'accounts', { accounts }, AT)),
      }
    }

    let state = initialStoreState(emptyState())
    // Both actions are built up front, from the SAME nowSec (AT) — exactly
    // what a fast double-tap on Save produces, since neither action's
    // `update` closure has run yet (no dispatch has happened) when the
    // second is constructed.
    const first = saveAction([account1])
    const second = saveAction([account1, account2])

    state = storeReducer(state, first)
    state = storeReducer(state, second)

    // The second save is NOT dropped — it landed with a strictly later
    // issuedAt than the first, because its stampConfigDoc call read
    // docHighWater fresh from the state the FIRST action's reducer call
    // had already committed.
    expect(state.app.docs.accounts.accounts).toEqual([account1, account2])
    expect(state.app.docs.accounts.issuedAt).toBe(AT + 1)
    expect(state.app.docHighWater.accounts).toBe(AT + 1)
  })
})

describe('publishConfigDoc', () => {
  it('stamps v/issuedAt, applies locally, and broadcasts to every known child', async () => {
    const guardian = newKeypair()
    const childA = newKeypair()
    const childB = newKeypair()
    const account: Account = { id: 'acc1', child: childA.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
    const app: AppState = {
      ...emptyState(),
      role: 'guardian',
      guardianPubkey: guardian.pk,
      children: [
        { pubkey: childA.pk, name: 'A', index: 0 },
        { pubkey: childB.pk, name: 'B', index: 1 },
      ],
    }
    const relay = makeFakeRelay()
    const storage = makeFakeStorage()

    const { app: next, sent } = await publishConfigDoc(app, 'accounts', { accounts: [account] }, wireOpts(guardian.sk, relay, storage, AT))

    expect(next.docs.accounts).toEqual({ v: 1, issuedAt: AT, accounts: [account] })
    expect(next.docHighWater.accounts).toBe(AT)
    expect(sent).toBe(true)
    expect(relay.events).toHaveLength(2) // one wrap per child

    const pTags = relay.events.map((e) => e.tags.find((t) => t[0] === 'p')?.[1]).sort()
    expect(pTags).toEqual([childA.pk, childB.pk].sort())
  })

  // Fix round 1: a revoked device must stop receiving family policy too.
  // Before this, every future config doc kept being gift-wrapped to it.
  it('does not broadcast to a revoked child', async () => {
    const guardian = newKeypair()
    const childA = newKeypair()
    const childB = newKeypair()
    const base: AppState = {
      ...emptyState(),
      role: 'guardian',
      guardianPubkey: guardian.pk,
      children: [
        { pubkey: childA.pk, name: 'A', index: 0 },
        { pubkey: childB.pk, name: 'B', index: 1 },
      ],
    }
    const app: AppState = { ...base, docs: { ...base.docs, accounts: { ...base.docs.accounts, revoked: { [childA.pk]: 500 } } } }
    const relay = makeFakeRelay()

    await publishConfigDoc(app, 'chores', { chores: [] }, wireOpts(guardian.sk, relay, makeFakeStorage(), AT))

    expect(relay.events).toHaveLength(1)
    expect(relay.events[0]!.tags.find((t) => t[0] === 'p')?.[1]).toBe(childB.pk)
  })

  it('a stale local clock still wins: issuedAt is bumped past the existing high-water mark rather than being dropped', async () => {
    // A guardian device whose clock reads AT, publishing into a doc kind
    // whose high-water mark is already AT+100 (e.g. restored from a
    // snapshot with an inflated issuedAt, or simply a clock skew) — the
    // guardian is this doc kind's sole legitimate writer, so its own edit
    // must never silently vanish the way a naive `issuedAt: nowSec` would
    // (applyConfigDoc's anti-rollback rule drops anything <= the high-water
    // mark) — it wins by being stamped strictly past the mark instead.
    const guardian = newKeypair()
    const app: AppState = { ...emptyState(), role: 'guardian', docHighWater: { accounts: AT + 100 } }
    const { app: next } = await publishConfigDoc(app, 'accounts', { accounts: [] }, wireOpts(guardian.sk, makeFakeRelay(), makeFakeStorage(), AT))
    expect(next.docHighWater.accounts).toBe(AT + 101) // bumped past the mark, not dropped
    expect(next.docs.accounts.issuedAt).toBe(AT + 101)
  })

  it('two same-second publishes to the same doc kind both apply and both propagate — the second is never lost', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const relay = makeFakeRelay()
    const storage = makeFakeStorage()
    const account1: Account = { id: 'acc1', child: child.pk, name: 'First', currency: 'GBP', custody: 'ledger' }
    const account2: Account = { id: 'acc2', child: child.pk, name: 'Second', currency: 'GBP', custody: 'ledger' }
    const app: AppState = { ...emptyState(), role: 'guardian', children: [{ pubkey: child.pk, name: 'Kid', index: 0 }] }

    // Both calls pass the IDENTICAL nowSec — simulating two edits landing
    // within the same wall-clock second (a guardian adding two accounts
    // back to back). With plain `issuedAt: nowSec` the second call's doc
    // would be `<=` the first's issuedAt and get silently dropped by
    // `applyConfigDoc`'s anti-rollback rule, both locally and over the wire.
    const first = await publishConfigDoc(app, 'accounts', { accounts: [account1] }, wireOpts(guardian.sk, relay, storage, AT))
    const second = await publishConfigDoc(first.app, 'accounts', { accounts: [account1, account2] }, wireOpts(guardian.sk, relay, storage, AT))

    expect(first.app.docs.accounts.issuedAt).toBe(AT)
    expect(second.app.docs.accounts.issuedAt).toBeGreaterThan(first.app.docs.accounts.issuedAt)
    // The second publish's content actually won (both accounts present),
    // not silently dropped in favour of the first.
    expect(second.app.docs.accounts.accounts.map((a) => a.id).sort()).toEqual(['acc1', 'acc2'])
    expect(first.sent).toBe(true)
    expect(second.sent).toBe(true)

    // Both propagate: one wrap per publish (one child each), not just one
    // that "won" locally with the other silently dropped over the wire too.
    expect(relay.events).toHaveLength(2)

    // The receiving side would independently accept both in the same order
    // (its own anti-rollback LWW, applyConfigDoc, is exactly what this
    // module's monotonic bump exists to stay ahead of).
    let receiverState: AppState = { ...emptyState(), role: 'child', guardianPubkey: guardian.pk }
    for (const wrap of relay.events) {
      receiverState = handleWrap(receiverState, wrap, child.sk, guardian.pk, AT).state
    }
    expect(receiverState.docs.accounts.accounts.map((a) => a.id).sort()).toEqual(['acc1', 'acc2'])
  })

  it('with zero known children, the doc still applies locally and reports sent: true (nothing to fail)', async () => {
    const guardian = newKeypair()
    const app: AppState = { ...emptyState(), role: 'guardian' }
    const { app: next, sent } = await publishConfigDoc(app, 'accounts', { accounts: [] }, wireOpts(guardian.sk, makeFakeRelay(), makeFakeStorage(), AT))
    expect(next.docs.accounts.issuedAt).toBe(AT)
    expect(sent).toBe(true)
  })
})

// ============================================================================
// buildGrantDecision
// ============================================================================

describe('buildGrantDecision: spend.request', () => {
  const child = newKeypair()
  const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }

  function baseApp(): AppState {
    return { ...emptyState(), role: 'guardian', docs: { ...emptyState().docs, accounts: { v: 1, issuedAt: 0, accounts: [account] } } }
  }

  function request(amountMinor = 150): RequestPayload {
    return buildRequestPayload({
      op: 'spend.request',
      reqId: 'r1',
      nonce: 'n1',
      child: child.pk,
      ts: AT,
      params: { amountMinor, currency: 'GBP', account: account.id },
    })
  }

  it('allow (full amount): builds the debit entry, an allow GRANT with the full amount, and applyToApp records both', () => {
    const build = buildGrantDecision(baseApp(), { request: request(150), decision: 'allow' }, AT)

    expect(build).not.toBeNull()
    const { entry, grant, applyToApp } = build!
    expect(entry).toBeDefined()
    expect(entry!.legs[0]!.amountMinor).toBe(-150)
    expect(entry!.requestId).toBe('r1')
    expect(grant.decision).toBe('allow')
    expect(grant.params).toEqual({ amountMinor: 150 })

    const next = applyToApp(baseApp())
    expect(next.entries).toEqual([entry])
    expect(next.requests).toHaveLength(1)
    expect(next.requests[0]!.status).toBe('approved')
    expect(next.requests[0]!.grantedAmountMinor).toBe(150)
  })

  it('allow, clamped below the asked amount: the grant and the entry both use the clamp', () => {
    const { entry, grant } = buildGrantDecision(baseApp(), { request: request(150), decision: 'allow', amountMinor: 50 }, AT)!
    expect(entry!.legs[0]!.amountMinor).toBe(-50)
    expect(grant.params).toEqual({ amountMinor: 50 })
  })

  it('a clamp of exactly 0 is treated as a deny — no entry, only a deny GRANT', () => {
    const build = buildGrantDecision(baseApp(), { request: request(150), decision: 'allow', amountMinor: 0 }, AT)!
    expect(build.entry).toBeUndefined()
    expect(build.grant.decision).toBe('deny')
    const next = build.applyToApp(baseApp())
    expect(next.entries).toEqual([])
    expect(next.requests[0]!.status).toBe('denied')
  })

  it('a clamp above what was asked is capped at the asked amount, never grants more', () => {
    const { entry } = buildGrantDecision(baseApp(), { request: request(150), decision: 'allow', amountMinor: 9_999 }, AT)!
    expect(entry!.legs[0]!.amountMinor).toBe(-150)
  })

  // Carried defect (progress.md, Task 3 -> Task 5 MUST-CARRY): a negative
  // self-reported params.amountMinor (the wire parser only checks isSafeInt,
  // not non-negativity) must clamp to 0 = deny, never reach debitEntry's
  // assertPositiveMinor as an unhandled throw.
  it('a negative self-reported asked amount denies rather than throwing', () => {
    const bogus = request(-500)
    const build = buildGrantDecision(baseApp(), { request: bogus, decision: 'allow' }, AT)
    expect(build).not.toBeNull()
    expect(build!.entry).toBeUndefined()
    expect(build!.grant.decision).toBe('deny')
  })

  it('deny: only a deny GRANT, no entry', () => {
    const build = buildGrantDecision(baseApp(), { request: request(150), decision: 'deny' }, AT)!
    expect(build.entry).toBeUndefined()
    expect(build.grant.decision).toBe('deny')
    expect(build.applyToApp(baseApp()).requests[0]!.status).toBe('denied')
  })

  // v0.2 spec §4.3: a dismissal is now a real, sent decision, not a
  // guardian-local status flip the child can never see.
  it('a dismissed decision sends a grant and creates no entry', () => {
    const built = buildGrantDecision(baseApp(), { request: request(150), decision: 'dismissed' }, AT)
    expect(built?.grant.decision).toBe('dismissed')
    expect(built?.grant.params).toEqual({})
    expect(built?.entry).toBeUndefined()
    expect(built?.applyToApp(baseApp()).requests[0]!.status).toBe('dismissed')
    expect(built?.applyToApp(baseApp()).entries).toEqual([])
  })

  it('returns null for a request naming an account this guardian does not have', () => {
    const bogus = buildRequestPayload({
      op: 'spend.request',
      reqId: 'r1',
      nonce: 'n1',
      child: child.pk,
      ts: AT,
      params: { amountMinor: 150, currency: 'GBP', account: 'does-not-exist' },
    })
    expect(buildGrantDecision(baseApp(), { request: bogus, decision: 'allow' }, AT)).toBeNull()
  })

  // Carried defect: the account lookup previously omitted the !archived
  // check scheduler.ts's own accountFor applies — a request naming a
  // since-archived account must not still get granted.
  it('returns null for a request naming an archived account', () => {
    const archivedAccount: Account = { ...account, archived: true }
    const app: AppState = { ...baseApp(), docs: { ...baseApp().docs, accounts: { v: 1, issuedAt: 0, accounts: [archivedAccount] } } }
    expect(buildGrantDecision(app, { request: request(150), decision: 'allow' }, AT)).toBeNull()
  })

  it('returns null for a pair.claim REQUEST (never answered as a grant)', () => {
    const claim = buildRequestPayload({
      op: 'pair.claim',
      reqId: 'r1',
      nonce: 'n1',
      child: child.pk,
      ts: AT,
      params: { token: 'a'.repeat(32), devicePk: child.pk },
    })
    expect(buildGrantDecision(baseApp(), { request: claim, decision: 'allow' }, AT)).toBeNull()
  })

  // Carried defect: no idempotency check against request.reqId meant
  // answering the same request twice created two ledger entries.
  describe('idempotency — answering the same request twice', () => {
    it('a reqId already decided (via app.requests) is refused outright: buildGrantDecision returns null', () => {
      const decided = recordRequestDecision(baseApp(), request(150), child.pk, 'approved', AT, 150)
      expect(buildGrantDecision(decided, { request: request(150), decision: 'allow' }, AT + 1)).toBeNull()
    })

    it("applyToApp itself is idempotent under a genuine double-dispatch of the SAME build (the race the outer check alone can't cover)", () => {
      const build = buildGrantDecision(baseApp(), { request: request(150), decision: 'allow' }, AT)!
      const once = build.applyToApp(baseApp())
      const twice = build.applyToApp(once)
      expect(twice.entries).toHaveLength(1) // not 2 — the second dispatch is a no-op
      expect(twice).toBe(once)
    })

    it('a deny decided once is never re-applied by a second dispatch of the same build', () => {
      const build = buildGrantDecision(baseApp(), { request: request(150), decision: 'deny' }, AT)!
      const once = build.applyToApp(baseApp())
      const twice = build.applyToApp(once)
      expect(twice).toBe(once)
      expect(twice.requests).toHaveLength(1)
    })
  })

  // Fix 1 (independent review, deterministic grant ids): two builds for the
  // SAME reqId (e.g. a racing double-send — screens/Approvals.tsx's own
  // requestAlreadyDecided pre-check narrows but cannot fully close that
  // window) must always produce the SAME entry id, so the child's own
  // addEntry dedupe-by-id collapses a racing double-send to one real entry.
  it('two builds for the same reqId produce the SAME (deterministic) entry id, even with a different clamp/nowSec', () => {
    const buildA = buildGrantDecision(baseApp(), { request: request(150), decision: 'allow' }, AT)!
    const buildB = buildGrantDecision(baseApp(), { request: request(150), decision: 'allow', amountMinor: 50 }, AT + 5)!
    expect(buildA.entry!.id).toBe(buildB.entry!.id)
    expect(buildA.entry!.id).toBe('grant:r1')
  })
})

describe('buildGrantDecision: allowance.claim', () => {
  const child = newKeypair()
  const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
  const cfg: AllowanceConfig = {
    child: child.pk,
    account: account.id,
    amountMinor: 500,
    cadence: 'weekly',
    day: 5,
    tz: 'UTC',
    startDay: '2026-08-01',
    choresGate: true,
  }
  // Friday 2026-08-21, 08:00 UTC — chosen to match domain/allowance.test.ts's
  // own fixture exactly (same cfg shape): due Fridays since startDay are
  // 2026-08-07/14/21, and '2026-W33' (below) is 2026-08-14's period key. The
  // file-wide `AT` (2023) predates `cfg.startDay` entirely and would make
  // EVERY periodKey here illegitimate under `legitimatePeriodKeys` — this
  // block needs its own, chronologically consistent "now".
  const NOW = Date.UTC(2026, 7, 21, 8, 0) / 1000

  function baseApp(): AppState {
    return {
      ...emptyState(),
      role: 'guardian',
      docs: {
        ...emptyState().docs,
        accounts: { v: 1, issuedAt: 0, accounts: [account] },
        allowance: { v: 1, issuedAt: 0, configs: [cfg] },
      },
    }
  }

  function claim(periodKey = '2026-W33', reqId = 'r2'): RequestPayload {
    return buildRequestPayload({ op: 'allowance.claim', reqId, nonce: `n-${reqId}`, child: child.pk, ts: NOW, params: { periodKey } })
  }

  it('allow: pays the full configured allowance for that (legitimate, due) periodKey and records the decision', () => {
    const build = buildGrantDecision(baseApp(), { request: claim(), decision: 'allow' }, NOW)
    expect(build).not.toBeNull()
    const { entry, applyToApp } = build!
    expect(entry!.legs[0]!.amountMinor).toBe(500)
    expect(entry!.periodKey).toBe('2026-W33')
    expect(entry!.category).toBe('allowance')

    const next = applyToApp(baseApp())
    expect(next.entries).toEqual([entry])
    expect(next.requests[0]!.status).toBe('approved')
  })

  describe('R2: a re-anchoring edit does not strand a pending claim', () => {
    const SAT = Date.UTC(2026, 7, 22, 9, 0) / 1000
    /** W34 claimed on its due day, then the gate is switched off on Saturday. */
    function reanchored(extra: (a: AppState) => AppState = (a) => a): AppState {
      let a = extra(upsertRequest(baseApp(), claim('2026-W34', 'r34'), child.pk, NOW))
      const doc = stampConfigDoc(a, 'allowance', { configs: [{ ...cfg, choresGate: false }] }, SAT)
      a = { ...a, docs: { ...a.docs, allowance: doc } }
      expect(a.docs.allowance.configs[0]!.startDay > '2026-08-21').toBe(true) // re-anchored past W34
      return a
    }

    it('the pending claim is still grantable, and pays once', () => {
      const app = reanchored()
      const build = buildGrantDecision(app, { request: claim('2026-W34', 'r34'), decision: 'allow' }, SAT)
      expect(build).not.toBeNull()
      const after = build!.applyToApp(app)
      expect(after.entries.map((e) => e.legs[0]!.amountMinor)).toEqual([500])
      // A second claim for the same period (another reqId) pays nothing more.
      const again = upsertRequest(after, claim('2026-W34', 'r34b'), child.pk, NOW)
      const second = buildGrantDecision(again, { request: claim('2026-W34', 'r34b'), decision: 'allow' }, SAT)
      expect(second === null || second.entry === undefined).toBe(true)
      expect(buildGrantDecision(after, { request: claim('2026-W34', 'r34'), decision: 'allow' }, SAT)).toBeNull()
    })

    it('a claim for the same period received after the edit is not grantable', () => {
      const app = reanchored()
      const late = upsertRequest(app, claim('2026-W33', 'r33late'), child.pk, SAT)
      expect(buildGrantDecision(late, { request: claim('2026-W33', 'r33late'), decision: 'allow' }, SAT)).toBeNull()
    })

    it('a claim denied before the edit stays unpaid', () => {
      const app = reanchored((a) => recordRequestDecision(a, claim('2026-W34', 'r34'), child.pk, 'denied', NOW))
      expect(buildGrantDecision(app, { request: claim('2026-W34', 'r34'), decision: 'allow' }, SAT)).toBeNull()
    })

    it('a claim never recorded as pending is not grantable after the edit', () => {
      const app = reanchored()
      expect(buildGrantDecision(app, { request: claim('2026-W33', 'rX'), decision: 'allow' }, SAT)).toBeNull()
    })
  })

  it('deny: no entry', () => {
    const build = buildGrantDecision(baseApp(), { request: claim(), decision: 'deny' }, NOW)!
    expect(build.entry).toBeUndefined()
    expect(build.applyToApp(baseApp()).entries).toEqual([])
  })

  // Review fix (Task 4 follow-up): a deny GRANT must still echo the claim's
  // own periodKey — see denyOnly's own doc comment in store.tsx. Without
  // this, a scheduler-originated gated claim (never sent by the child
  // itself, so the child's own state.requests has nothing to match by reqId
  // — see recordGrantResult's doc comment) denied by the guardian arrives
  // with an EMPTY params object, and the synthetic row recordGrantResult
  // builds on the child side ends up with no periodKey for
  // screens/chores.ts#alreadyClaimed to match against — the chores gate
  // then re-raises a fresh claim for the very period just denied.
  it('deny echoes params.periodKey on the GRANT (spend.request denies stay {} — see the sibling describe block)', () => {
    const build = buildGrantDecision(baseApp(), { request: claim(), decision: 'deny' }, NOW)!
    expect(build.grant.params).toEqual({ periodKey: '2026-W33' })
  })

  // A dismissal (v0.2 spec §4.3) is answered by the same no-entry path as a
  // deny, so it inherits the periodKey echo for exactly the same reason —
  // otherwise the child's chores gate re-raises the period just dismissed.
  it('dismissed: no entry, a dismissed GRANT that still echoes the periodKey, and a dismissed status', () => {
    const build = buildGrantDecision(baseApp(), { request: claim(), decision: 'dismissed' }, NOW)!
    expect(build.entry).toBeUndefined()
    expect(build.grant.decision).toBe('dismissed')
    expect(build.grant.params).toEqual({ periodKey: '2026-W33' })
    expect(build.applyToApp(baseApp()).entries).toEqual([])
    expect(build.applyToApp(baseApp()).requests[0]!.status).toBe('dismissed')
  })

  it('returns null when no allowance config exists for this child', () => {
    const noConfig: AppState = { ...baseApp(), docs: { ...baseApp().docs, allowance: { v: 1, issuedAt: 0, configs: [] } } }
    expect(buildGrantDecision(noConfig, { request: claim(), decision: 'allow' }, NOW)).toBeNull()
  })

  it('returns null for an archived allowance account', () => {
    const archivedAccount: Account = { ...account, archived: true }
    const app: AppState = { ...baseApp(), docs: { ...baseApp().docs, accounts: { v: 1, issuedAt: 0, accounts: [archivedAccount] } } }
    expect(buildGrantDecision(app, { request: claim(), decision: 'allow' }, NOW)).toBeNull()
  })

  // Money-stakes hole: buildGrantDecision must reject a periodKey that was
  // never actually due under this config's own schedule, not just any
  // non-empty string (wire/payloads.ts's isAllowanceClaimParams only checks
  // that).
  describe('periodKey legitimacy', () => {
    it('a hostile/fabricated periodKey ("xyz") is refused — never paid', () => {
      expect(buildGrantDecision(baseApp(), { request: claim('xyz'), decision: 'allow' }, NOW)).toBeNull()
    })

    it('a far-future periodKey (never due yet as of `nowSec`) is refused — never paid', () => {
      // '2027-W32' is a whole year past NOW; nothing due that far ahead yet.
      expect(buildGrantDecision(baseApp(), { request: claim('2027-W32'), decision: 'allow' }, NOW)).toBeNull()
    })

    it('a legitimate, already-due period is approved (the happy path above, asserted explicitly here too)', () => {
      const build = buildGrantDecision(baseApp(), { request: claim('2026-W33'), decision: 'allow' }, NOW)
      expect(build).not.toBeNull()
      expect(build!.entry).toBeDefined()
    })

    it('an illegitimate periodKey can STILL be denied (deny never validates the period — see the top-level early return)', () => {
      const build = buildGrantDecision(baseApp(), { request: claim('xyz'), decision: 'deny' }, NOW)
      expect(build).not.toBeNull()
      expect(build!.grant.decision).toBe('deny')
    })
  })

  // "already-paid periodKey -> treat as approved, no double entry" — a
  // SECOND claim (a different reqId, e.g. the child's own retry) for a
  // periodKey already paid must approve without minting a second entry.
  it('a duplicate claim (different reqId, same periodKey already paid) approves without a second entry', () => {
    const first = buildGrantDecision(baseApp(), { request: claim('2026-W33', 'r2'), decision: 'allow' }, NOW)!
    const afterFirst = first.applyToApp(baseApp())
    expect(afterFirst.entries).toHaveLength(1)

    const second = buildGrantDecision(afterFirst, { request: claim('2026-W33', 'r3'), decision: 'allow' }, NOW + 10)
    expect(second).not.toBeNull()
    expect(second!.entry).toBeUndefined() // no second entry to apply/send
    expect(second!.grant.decision).toBe('allow') // the child's own request still clears

    const afterSecond = second!.applyToApp(afterFirst)
    expect(afterSecond.entries).toHaveLength(1) // still just the one entry
    expect(afterSecond.requests.find((r) => r.request.reqId === 'r3')?.status).toBe('approved')
  })

  // Fix 2 (final review): the OUTER periodAlreadyPaid pre-check above only
  // knows about entries that existed at buildGrantDecision's OWN snapshot
  // read — it cannot see a SCHEDULER payment for the same period that lands
  // (under a different, sched:-prefixed entry id) AFTER that read but BEFORE
  // applyToApp is actually dispatched, e.g. earlier in the same batch as a
  // guardian's approval. Without applyToApp re-checking periodAlreadyPaid
  // itself, that interleave double-credits the child.
  it('a scheduler payment for the same period landing before applyToApp runs is not double-credited, and entryOutcome reports it was never applied', () => {
    const build = buildGrantDecision(baseApp(), { request: claim('2026-W33', 'r7'), decision: 'allow' }, NOW)!
    expect(build.entry).toBeDefined() // built against a snapshot where nothing was paid yet
    expect(build.entryOutcome?.entryApplied).toBe(false) // not yet dispatched

    // The scheduler's own payment for the SAME period, applied to state
    // AFTER buildGrantDecision's snapshot but BEFORE applyToApp runs.
    const schedulerEntry: Entry = {
      ...creditEntry({ id: 'sched:allowance:kid:acc1:2026-08-21', child: child.pk, createdAt: NOW, author: 'guardian' }, account, cfg.amountMinor, 'allowance'),
      periodKey: '2026-W33',
    }
    const stateWithSchedulerPayment = addEntry(baseApp(), schedulerEntry)

    const next = build.applyToApp(stateWithSchedulerPayment)
    expect(next.entries).toEqual([schedulerEntry]) // no second, grant:-prefixed entry — exactly one payment
    expect(next.requests[0]!.status).toBe('approved') // the request still clears

    // Fix 2 (scoped re-review): entryOutcome is what a caller (Approvals.tsx
    // #submitDecision) actually gates the WIRE send of `build.entry` on —
    // this must stay false so that caller never sends the grant:-prefixed
    // entry after the scheduler's sched:-prefixed one already covered the
    // child (the child's own dedupe is by id, not by period, so it can't
    // collapse the two on its own).
    expect(build.entryOutcome?.entryApplied).toBe(false)
  })

  // Fix 2 (scoped re-review): the positive counterpart to the interleave
  // test above — a CLEAN approval (no interleaving scheduler payment) must
  // still flip entryOutcome.entryApplied to true once applyToApp actually
  // adds the entry, so a caller's `!== false` guard does send it.
  it('a clean allowance approval (no interleave) sets entryOutcome.entryApplied to true once applyToApp runs', () => {
    const build = buildGrantDecision(baseApp(), { request: claim('2026-W33', 'r8'), decision: 'allow' }, NOW)!
    expect(build.entryOutcome?.entryApplied).toBe(false) // not yet dispatched

    const next = build.applyToApp(baseApp())
    expect(next.entries).toEqual([build.entry])
    expect(build.entryOutcome?.entryApplied).toBe(true)
  })

  // Fix 1 (independent review, deterministic grant ids): two builds for the
  // SAME reqId must always produce the SAME entry id, so a racing
  // double-send (screens/Approvals.tsx#submitDecision's own pre-check
  // narrows but cannot fully close this window — see grantEntryId's doc
  // comment) can never land two distinct real entries on the child's side;
  // the child's own addEntry dedupes by id and collapses it to one.
  it('two builds for the same reqId produce the SAME (deterministic) entry id', () => {
    const buildA = buildGrantDecision(baseApp(), { request: claim('2026-W33', 'r9'), decision: 'allow' }, NOW)!
    const buildB = buildGrantDecision(baseApp(), { request: claim('2026-W33', 'r9'), decision: 'allow' }, NOW + 5)!
    expect(buildA.entry!.id).toBe(buildB.entry!.id)
    expect(buildA.entry!.id).toBe('grant:r9')
  })

  // Full round trip (review fix, Task 4 follow-up): guardian denies a
  // scheduler-originated gated claim (reqId never sent by the child, per
  // store/scheduler.ts's own gatedClaim convention) -> the resulting GRANT
  // arrives at the child -> the chores gate must NOT re-raise that period.
  // Exercises all three layers the fix touches: buildGrantDecision's
  // denyOnly (guardian), recordGrantResult's synthetic-row path (child),
  // and choreGateReadyClaims' alreadyClaimed check (the gate itself).
  describe('chores-gate deny round trip (review fix)', () => {
    const dueDay = '2026-08-14' // this describe block's own periodKey fixture, '2026-W33'
    const dailyChore: Chore = { id: 'c1', child: child.pk, name: 'Brush teeth', cadence: 'daily' }
    const periodDays = periodDaysEndingAt(cfg, dueDay)
    const ticks: ChoreTick[] = periodDays.map((day, i) => ({ id: `t${i}`, chore: 'c1', day, at: NOW }))
    const schedulerReqId = `scheduler:${child.pk}:${account.id}:2026-W33`

    it('the denial sticks: the gate does not re-raise the just-denied period, and a simulated reload changes nothing', () => {
      // 1. Guardian denies the scheduler-synthesised claim.
      const build = buildGrantDecision(baseApp(), { request: claim('2026-W33', schedulerReqId), decision: 'deny' }, NOW)!
      expect(build.grant.decision).toBe('deny')

      // 2. The GRANT arrives at the child, whose own state.requests has
      // NOTHING under this reqId (the scheduler's claim never crossed the
      // wire as a REQUEST) — recordGrantResult takes the synthetic-row path.
      const childApp: AppState = { ...emptyState(), role: 'child', self: { pubkey: child.pk, childIndex: 0 } }
      const afterGrant = recordGrantResult(childApp, build.grant, child.pk, NOW + 1)
      const synthetic = afterGrant.requests.find((r) => r.request.reqId === schedulerReqId)
      expect(synthetic?.status).toBe('denied')
      expect((synthetic?.request.params as { periodKey?: string }).periodKey).toBe('2026-W33') // the fix — this used to be undefined

      // 3. The chores gate, seeing the SAME period fully ticked and still
      // "due" (no entry ever paid it), must NOT raise a fresh claim for it —
      // the denial already covers this period.
      const readyAfterDeny = choreGateReadyClaims(cfg, [dailyChore], ticks, [], afterGrant.requests, NOW)
      expect(readyAfterDeny).toEqual([])

      // 4. A "simulated reload" is just re-running the same pure check
      // against the same (now-persisted) requests — nothing about this is
      // time-dependent or session-scoped, so it must still be empty.
      const readyAfterReload = choreGateReadyClaims(cfg, [dailyChore], ticks, [], afterGrant.requests, NOW + 100_000)
      expect(readyAfterReload).toEqual([])
    })

    it('control: WITHOUT the denial on record, the same complete/due period WOULD be raised', () => {
      const readyWithNothingRecorded = choreGateReadyClaims(cfg, [dailyChore], ticks, [], [], NOW)
      expect(readyWithNothingRecorded).toEqual([{ dueDay, periodKey: '2026-W33' }])
    })
  })
})

// ============================================================================
// Ingress replay-resurrection — the REAL wire pipeline, not the pure fold.
//
// state.test.ts already covers upsertRequest/recordRequestDecision's own
// replay-resurrection guarantee directly, against a hand-built
// RequestPayload. This is the belt-and-braces layer above that: a REAL
// signed-and-gift-wrapped REQUEST event, run through sync/ingress.ts's
// actual handleWrap (unwrap, verify, parse, authorPk provenance) — proving
// the wire-authenticated authorPk handleWrap hands back genuinely satisfies
// upsertRequest's own `authorPk === request.child` guard — and specifically
// exercising the case handleWrap's OWN seenEventIds dedupe can't cover on
// its own: seenEventIds is a bounded LRU (MAX_SEEN_EVENT_IDS = 2000,
// ingress.ts) that can genuinely forget an old event id, after which a
// relay redelivering that same stored event would have handleWrap
// reprocess it as if new. The request REGISTRY's own reqId dedupe is what
// still holds the line in that case.
// ============================================================================

describe('ingress replay-resurrection (real wire wrap)', () => {
  it('redelivering the same REQUEST wrap after a decision never resurrects it to pending, even once seenEventIds has forgotten it', () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const requestPayload = buildRequestPayload({
      op: 'spend.request',
      reqId: 'wire-r1',
      nonce: 'wire-n1',
      child: child.pk,
      ts: AT,
      params: { amountMinor: 200, currency: 'GBP', account: 'acc1' },
    })
    const wrap = wrapFor({ innerKind: KIND_REQUEST, payload: requestPayload, authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })

    let state: AppState = {
      ...emptyState(),
      role: 'guardian',
      guardianPubkey: guardian.pk,
      children: [{ pubkey: child.pk, name: 'Kid', index: 0 }],
    }

    // First delivery: the REAL handleWrap pipeline (unwrap/verify/parse)
    // surfaces the 'request' effect with an AUTHENTICATED authorPk —
    // exactly what sync/multi.ts's guardian engine hands to
    // upsertRequest in store.tsx's onEffect wiring.
    const first = handleWrap(state, wrap, guardian.sk, child.pk, AT)
    state = first.state
    const firstEffect = first.effects.find((e) => e.type === 'request')
    expect(firstEffect).toBeDefined()
    if (firstEffect === undefined || firstEffect.type !== 'request') throw new Error('expected a request effect')
    state = upsertRequest(state, firstEffect.payload, firstEffect.authorPk, AT)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]!.status).toBe('pending')

    // The guardian denies it.
    state = recordRequestDecision(state, firstEffect.payload, firstEffect.authorPk, 'denied', AT + 10)
    expect(state.requests[0]!.status).toBe('denied')

    // Force handleWrap to reprocess the SAME wrap — simulating
    // seenEventIds having forgotten this event id (LRU eviction) rather
    // than trusting that layer alone to prevent replay.
    state = { ...state, seenEventIds: [] }

    const second = handleWrap(state, wrap, guardian.sk, child.pk, AT + 20)
    const secondEffect = second.effects.find((e) => e.type === 'request')
    // Proves this test isn't vacuous: handleWrap DID actually reprocess the
    // wrap and re-surface the effect (seenEventIds's own dedupe is not what
    // is protecting the outcome asserted below).
    expect(secondEffect).toBeDefined()
    if (secondEffect === undefined || secondEffect.type !== 'request') throw new Error('expected a request effect')

    const afterReplay = upsertRequest(second.state, secondEffect.payload, secondEffect.authorPk, AT + 20)
    expect(afterReplay.requests).toHaveLength(1) // no second record
    expect(afterReplay.requests[0]!.status).toBe('denied') // never resurrected to pending
  })
})

// ============================================================================
// runSchedulersAndSend
// ============================================================================

describe('runSchedulersAndSend', () => {
  it('applies and sends every due entry', async () => {
    const guardian = newKeypair()
    const child = newKeypair()
    const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
    const cfg: AllowanceConfig = { child: child.pk, account: account.id, amountMinor: 500, cadence: 'weekly', day: 5, tz: 'Europe/London', startDay: '2026-08-01' }
    const now = Date.UTC(2026, 7, 21, 8, 0) / 1000 // Friday 2026-08-21

    const app: AppState = {
      ...emptyState(),
      role: 'guardian',
      docs: { ...emptyState().docs, accounts: { v: 1, issuedAt: 0, accounts: [account] }, allowance: { v: 1, issuedAt: 0, configs: [cfg] } },
    }
    const relay = makeFakeRelay()

    const { app: next, claims, sent } = await runSchedulersAndSend(app, wireOpts(guardian.sk, relay, makeFakeStorage(), now))

    expect(next.entries).toHaveLength(3)
    expect(claims).toEqual([])
    expect(sent).toBe(true)
    expect(relay.events).toHaveLength(3)
  })

  it('nothing due -> no entries, no sends', async () => {
    const guardian = newKeypair()
    const app: AppState = { ...emptyState(), role: 'guardian' }
    const relay = makeFakeRelay()
    const { app: next, sent } = await runSchedulersAndSend(app, wireOpts(guardian.sk, relay, makeFakeStorage(), AT))
    expect(next).toEqual(app)
    expect(sent).toBe(true)
    expect(relay.events).toEqual([])
  })
})

// ============================================================================
// duePayoutsRef accumulation — AppProvider's scheduler effect (store.tsx).
// The ref itself lives inside a React component and can't be exercised
// without a DOM, but the HAZARD it fixes is a pure property of how its
// updater interacts with `storeReducer`: this reproduces that exact updater
// shape (an id-keyed Map fed via `.set(e.id, e)` inside each dispatched
// updater — store.tsx's own scheduler effect, verbatim) directly against
// `storeReducer`, no React/DOM involved. See store.tsx's own comment on this
// same effect for the full "why a plain assignment loses payouts" reasoning.
// ============================================================================

describe('duePayoutsRef accumulation (store.tsx scheduler-effect pattern, reproduced at the reducer level)', () => {
  it('a batched double-dispatch — the second updater finding nothing further due — leaves the accumulated Map still holding the first batch\'s entries', () => {
    const child = newKeypair()
    const account: Account = { id: 'acc1', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
    const cfg: AllowanceConfig = { child: child.pk, account: account.id, amountMinor: 500, cadence: 'weekly', day: 5, tz: 'Europe/London', startDay: '2026-08-01' }
    const now = Date.UTC(2026, 7, 21, 8, 0) / 1000 // Friday 2026-08-21 — one period due

    const app: AppState = {
      ...emptyState(),
      role: 'guardian',
      docs: { ...emptyState().docs, accounts: { v: 1, issuedAt: 0, accounts: [account] }, allowance: { v: 1, issuedAt: 0, configs: [cfg] } },
    }

    // The SAME shape as store.tsx's scheduler effect's `update` closure:
    // accumulate due entries into an id-keyed Map, fold them into `app`.
    const duePayoutsRef = new Map<string, Entry>()
    function runOnce(state: StoreState): StoreState {
      return storeReducer(state, {
        type: 'updateApp',
        update: (a) => {
          const { entries } = runSchedulers(a, now)
          for (const e of entries) duePayoutsRef.set(e.id, e)
          return entries.reduce((acc, e) => addEntry(acc, e), a)
        },
      })
    }

    let state: StoreState = initialStoreState(app)

    // First dispatch (e.g. the 15-minute interval firing): genuinely due
    // entries, folded into `app` and stashed into the Map.
    state = runOnce(state)
    expect(duePayoutsRef.size).toBeGreaterThan(0)
    const afterFirst = new Map(duePayoutsRef)

    // Second dispatch, batched right after the first (e.g. a near-simultaneous
    // `focus` event, or StrictMode's double-invoke) — the reducer hands its
    // updater the state the FIRST call already committed, so runSchedulers
    // correctly finds NOTHING further due (idempotent by periodKey, per
    // scheduler.ts's own module header) and stashes nothing new.
    state = runOnce(state)

    // The Map must still hold the first batch's entries — id-keyed
    // accumulation, unlike a bare `duePayoutsRef.current = entries`
    // assignment, never lets the second (empty) call clobber them.
    expect(duePayoutsRef.size).toBe(afterFirst.size)
    for (const [id, entry] of afterFirst) {
      expect(duePayoutsRef.get(id)).toEqual(entry)
    }
    // And they really were folded into local state either way — this isn't
    // testing a case where the local application itself was ever in doubt,
    // only whether the Map (what the real drain effect actually SENDS from)
    // still reflects them.
    expect(state.app.entries).toHaveLength(afterFirst.size)
  })
})

// ============================================================================
// childSessionReducer — v0.2 spec §2.6. The UI lock and the presence of the
// key are two separate facts now, and this reducer is the whole of the
// difference between them. Tested here rather than through `AppProvider`
// because this project has no React renderer in its test setup; the provider
// does nothing with these but hand them to `wireLock`/`wireKeyWipe` and the
// context.
// ============================================================================

describe('childSessionReducer', () => {
  const sk = new Uint8Array(32).fill(7)

  it('starts with no key and locked', () => {
    expect(initialChildSession).toEqual({ sk: null, locked: true })
  })

  it('unlock sets the key and clears the lock', () => {
    const next = childSessionReducer(initialChildSession, { type: 'unlock', sk })
    expect(next.sk).toBe(sk)
    expect(next.locked).toBe(false)
  })

  it('lockUi locks the screen and KEEPS the key, so sync and notifications carry on', () => {
    const unlocked = childSessionReducer(initialChildSession, { type: 'unlock', sk })
    const next = childSessionReducer(unlocked, { type: 'lockUi' })
    expect(next.locked).toBe(true)
    expect(next.sk).toBe(sk)
  })

  it('wipe drops the key and locks', () => {
    const unlocked = childSessionReducer(initialChildSession, { type: 'unlock', sk })
    const next = childSessionReducer(unlocked, { type: 'wipe' })
    expect(next.sk).toBeNull()
    expect(next.locked).toBe(true)
  })

  it('a wipe after a UI lock leaves nothing behind', () => {
    let s = childSessionReducer(initialChildSession, { type: 'unlock', sk })
    s = childSessionReducer(s, { type: 'lockUi' })
    s = childSessionReducer(s, { type: 'wipe' })
    expect(s).toEqual({ sk: null, locked: true })
  })

  it('unlocking again after a wipe restores a working session', () => {
    let s = childSessionReducer(initialChildSession, { type: 'wipe' })
    s = childSessionReducer(s, { type: 'unlock', sk })
    expect(s).toEqual({ sk, locked: false })
  })
})

// Task E4 (v0.2 spec §3.1/§3.2) — the one piece of the store's notification
// wiring that stays DOM-free and so is testable here: `app` is passed in
// explicitly rather than read off a live ref, exactly like every other pure
// helper above it in store.tsx. The DOM-touching half (reading
// `document.visibilityState`, calling `platform/shell.ts#notify`) is
// `AppProvider`'s own `fireNotification`, left to a real browser per this
// file's header — same as the engine/scheduler effects it sits beside.
describe('notificationContextFor', () => {
  const eurAccount: Account = { id: 'eur-acc', child: 'pk1', name: 'Savings', currency: 'EUR', custody: 'ledger' }
  const app: AppState = {
    ...emptyState(),
    children: [{ pubkey: 'pk1', name: 'Alex', index: 0 }],
    docs: { ...emptyState().docs, accounts: { v: 1, issuedAt: 0, accounts: [eurAccount] } },
  }

  it('carries the role straight through', () => {
    expect(notificationContextFor('guardian', app).role).toBe('guardian')
    expect(notificationContextFor('child', app).role).toBe('child')
  })

  it('childNameFor resolves a known child from app.children', () => {
    expect(notificationContextFor('guardian', app).childNameFor('pk1')).toBe('Alex')
  })

  it('childNameFor is null for an unknown pubkey', () => {
    expect(notificationContextFor('guardian', app).childNameFor('nope')).toBeNull()
  })

  it('formatMoney matches domain/money.ts#formatMinor, in NotificationContext\'s (amountMinor, currency) order', () => {
    expect(notificationContextFor('guardian', app).formatMoney(500, 'GBP')).toBe('£5.00')
  })

  it('formatMoney is total against a currency the wire never validated (wire/payloads.ts only checks it is a non-empty string) — fix round 1: keeps the currency in the fallback', () => {
    const ctx = notificationContextFor('guardian', app)
    expect(() => ctx.formatMoney(500, 'NOTACURRENCY')).not.toThrow()
    expect(ctx.formatMoney(500, 'NOTACURRENCY')).toBe('NOTACURRENCY 500')
  })

  it('formatMoney is total against a non-safe-integer amount', () => {
    const ctx = notificationContextFor('guardian', app)
    expect(() => ctx.formatMoney(1.5, 'GBP')).not.toThrow()
  })

  // Fix round 1 (IMPORTANT 2) — currencyForAccount resolves the audit
  // notification's REAL account currency from app.docs.accounts, rather
  // than notifications.ts's own hard-coded 'GBP' fallback applying
  // unconditionally.
  it('currencyForAccount resolves a known account\'s real currency', () => {
    expect(notificationContextFor('guardian', app).currencyForAccount('eur-acc')).toBe('EUR')
  })

  it('currencyForAccount is null for an unknown/deleted account, leaving notifications.ts\'s own FALLBACK_CURRENCY to apply', () => {
    expect(notificationContextFor('guardian', app).currencyForAccount('does-not-exist')).toBeNull()
  })
})

// ============================================================================
// The Android relay-keepalive service is armed by ROLE, and by nothing else
// (fix round 2, item M1).
//
// It used to be started and stopped inside the two engine effects, whose
// dependency arrays include the peer set and the relay pool. Every roster
// edit and every relay-list edit therefore tore the foreground service down
// and started it again — a visible notification flicker, a dropped wake
// lock, and on Android 15 a fresh dataSync time-box each time. None of that
// has anything to do with what actually decides whether the service should
// run: whether this device has a role at all.
// ============================================================================

describe('shouldRunRelayService (item M1)', () => {
  it('runs for a guardian and for a child', () => {
    expect(shouldRunRelayService('guardian')).toBe(true)
    expect(shouldRunRelayService('child')).toBe(true)
  })

  it('does not run before a role exists — nothing to keep in touch with yet', () => {
    expect(shouldRunRelayService('unset')).toBe(false)
  })
})

describe('grantAwaitsEntry (v0.3 child catch-up)', () => {
  const allow = { v: 1 as const, reqId: 'r1', nonce: 'n', decision: 'allow' as const, ts: 1, params: { amountMinor: 200 } }
  const account: Account = { id: 'acc1', child: 'sam', name: 'Pocket money', currency: 'GBP', custody: 'ledger' }

  it('is true for an allowed spend whose grant: entry is missing, false once it lands', () => {
    expect(grantAwaitsEntry(emptyState(), allow)).toBe(true)
    const entry = creditEntry({ id: 'grant:r1', child: 'sam', createdAt: AT, author: 'guardian' }, account, 200)
    expect(grantAwaitsEntry({ ...emptyState(), entries: [entry] }, allow)).toBe(false)
  })

  it('implies nothing for a deny, or for an allowance claim', () => {
    expect(grantAwaitsEntry(emptyState(), { ...allow, decision: 'deny', params: {} })).toBe(false)
    expect(grantAwaitsEntry(emptyState(), { ...allow, params: { periodKey: '2026-W36' } })).toBe(false)
  })
})

describe('vault publish record (v0.3)', () => {
  it('round-trips through storage and never throws on a blocked one', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
    expect(readVaultPublished(storage)).toBeNull()
    writeVaultPublished('sig', storage)
    expect(readVaultPublished(storage)).toBe('sig')
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readVaultPublished(blocked)).toBeNull()
    expect(() => writeVaultPublished('sig', blocked)).not.toThrow()
  })
})
