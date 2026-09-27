// Ingress tests for the v0.2 additions (spec §2.3, §2.4, §4.5): the raw inner
// event corpus, the extracted `dispatchInner`, and the entry/config/revoked
// effects. The pre-existing `handleWrap` dispatch cases (one describe block
// per wire kind) live in `engine.test.ts` section 2 and stay there — this
// file only adds what v0.2 introduces.

import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapFor } from '../wire/giftwrap'
import { KIND_ACK, KIND_CHILD_SIG, KIND_CONFIG, KIND_ENTRY, KIND_GRANT, KIND_SNAPSHOT, KIND_STATUS } from '../wire/kinds'
import {
  buildAckPayload,
  buildChildAuditPayload,
  buildChildTickPayload,
  buildConfigPayload,
  buildEntryPayload,
  buildGrantPayload,
  buildResyncReplyPayload,
  buildResyncRequestPayload,
  buildSnapshotPayload,
  buildStatusPayload,
} from '../wire/payloads'
import { rootChallenge } from '../identity/signetRoot'
import { creditEntry } from '../domain/ledger'
import type { Account } from '../domain/types'
import { emptyState } from '../state/state'
import type { AppState, ConfigDocs } from '../state/types'
import { dispatchInner, handleWrap, retainsInnerEvent, toStoredEvent, MAX_ISSUED_AT_SKEW_SECS } from './ingress'

const AT = 1000

function makeKeypair() {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

const guardian = makeKeypair()
const child = makeKeypair()

const sibling = makeKeypair()

const account: Account = { id: 'a-ledger', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
const siblingAccount: Account = { id: 'a-sibling', child: sibling.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
/** A guardian-authored entry: since audit P1 the only kind any device folds. */
const entryFixture = creditEntry({ id: 'e-ingress-1', child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)

// Both ends hold the family's accounts doc (and the guardian a chores doc):
// audit P1/P8 bind every ENTRY leg and CHILD_SIG to a known account/chore.
const familyDocs = {
  ...emptyState().docs,
  accounts: { v: 1 as const, issuedAt: 1, accounts: [account, siblingAccount] },
}

const guardianBase: AppState = {
  ...emptyState(),
  role: 'guardian',
  guardianPubkey: guardian.pk,
  self: { pubkey: guardian.pk, childIndex: null },
  children: [
    { pubkey: child.pk, name: 'Alex', index: 0 },
    { pubkey: sibling.pk, name: 'Sam', index: 1 },
  ],
  docs: {
    ...familyDocs,
    chores: {
      v: 1,
      issuedAt: 1,
      chores: [
        { id: 'c1', child: child.pk, name: 'Bed', cadence: 'daily' },
        { id: 'c-sibling', child: sibling.pk, name: 'Dishes', cadence: 'daily' },
      ],
    },
  },
}

const childBase: AppState = {
  ...emptyState(),
  role: 'child',
  guardianPubkey: guardian.pk,
  self: { pubkey: child.pk, childIndex: 0 },
  docs: familyDocs,
}

const choresDoc: ConfigDocs['chores'] = { v: 1, issuedAt: 900, chores: [] }

describe('handleWrap records the raw inner event (spec §2.3)', () => {
  it('records the raw signed inner event even when its payload fails to parse', () => {
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload: { v: 99, nonsense: true }, authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const { state } = handleWrap(childBase, wrap, child.sk, guardian.pk, AT)
    expect(Object.values(state.innerEvents)).toHaveLength(1)
    expect(Object.values(state.innerEvents)[0]!.kind).toBe(KIND_ENTRY)
  })

  it('keys the corpus by the inner event id', () => {
    const wrap = wrapFor({ innerKind: KIND_CHILD_SIG, payload: buildChildTickPayload({ id: 't1', chore: 'c1', day: '2026-09-02', at: AT }), authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })
    const { state } = handleWrap(guardianBase, wrap, guardian.sk, child.pk, AT)
    const [id, ev] = Object.entries(state.innerEvents)[0]!
    expect(id).toBe(ev.id)
    expect(ev.kind).toBe(KIND_CHILD_SIG)
  })

  it('does not record kinds outside ENTRY/CONFIG/GRANT/CHILD_SIG', () => {
    const wrap = wrapFor({ innerKind: KIND_ACK, payload: buildAckPayload(entryFixture.id, AT), authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })
    const { state } = handleWrap({ ...guardianBase, entries: [entryFixture] }, wrap, guardian.sk, child.pk, AT)
    expect(state.innerEvents).toEqual({})
    expect(state.acks).toEqual({ [entryFixture.id]: AT })
  })

  // Phase A review follow-up: the corpus must not become a way for a child to
  // park a CONFIG/GRANT on the guardian forever. `dispatchInner`'s direction
  // guard already refuses to APPLY one; without the same guard on retention it
  // would still be stored, and later replayed to a third device by resync.
  it('does not record a CONFIG the direction guard refused (child-authored)', () => {
    const wrap = wrapFor({ innerKind: KIND_CONFIG, payload: buildConfigPayload('chores', choresDoc), authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })
    const { state } = handleWrap(guardianBase, wrap, guardian.sk, child.pk, AT)
    expect(state.innerEvents).toEqual({})
    expect(state.seenEventIds).toEqual([wrap.id])
  })

  it('does not record a GRANT the direction guard refused (child-authored)', () => {
    const wrap = wrapFor({ innerKind: KIND_GRANT, payload: { v: 1, requestId: 'r1', op: 'spend.request', decision: 'approved' }, authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })
    const { state } = handleWrap(guardianBase, wrap, guardian.sk, child.pk, AT)
    expect(state.innerEvents).toEqual({})
  })

  it('still records a correctly authored CONFIG whose payload fails to parse', () => {
    const wrap = wrapFor({ innerKind: KIND_CONFIG, payload: { v: 99, nonsense: true }, authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const { state } = handleWrap(childBase, wrap, child.sk, guardian.pk, AT)
    expect(Object.values(state.innerEvents)).toHaveLength(1)
    expect(Object.values(state.innerEvents)[0]!.kind).toBe(KIND_CONFIG)
  })
})

describe('retainsInnerEvent (spec §2.3 + the direction guard)', () => {
  it('retains a guardian ENTRY and a child CHILD_SIG, and refuses a child-authored ENTRY (audit P1)', () => {
    expect(retainsInnerEvent(childBase, KIND_ENTRY, guardian.pk)).toBe(true)
    expect(retainsInnerEvent(guardianBase, KIND_CHILD_SIG, child.pk)).toBe(true)
    expect(retainsInnerEvent(guardianBase, KIND_ENTRY, child.pk)).toBe(false)
  })

  it('retains a guardian-authored CONFIG/GRANT and refuses a child-authored one', () => {
    expect(retainsInnerEvent(childBase, KIND_CONFIG, guardian.pk)).toBe(true)
    expect(retainsInnerEvent(childBase, KIND_GRANT, guardian.pk)).toBe(true)
    expect(retainsInnerEvent(guardianBase, KIND_CONFIG, child.pk)).toBe(false)
    expect(retainsInnerEvent(guardianBase, KIND_GRANT, child.pk)).toBe(false)
  })

  it('refuses a kind outside the retained set', () => {
    expect(retainsInnerEvent(guardianBase, KIND_ACK, guardian.pk)).toBe(false)
  })
})

describe('toStoredEvent', () => {
  it('keeps the event JSON-plain, so a stored corpus survives a persist round trip', () => {
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload: buildEntryPayload(entryFixture), authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const { state } = handleWrap(childBase, wrap, child.sk, guardian.pk, AT)
    const stored = Object.values(state.innerEvents)[0]!

    // nostr-tools stamps a Symbol(verified) cache onto anything verifyEvent
    // has checked; an object spread would carry it into state, where it
    // would not survive JSON persistence.
    expect(Object.getOwnPropertySymbols(stored)).toEqual([])
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored)
    expect(Object.keys(stored).sort()).toEqual(['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags'])
    expect(toStoredEvent(stored)).toEqual(stored)
  })
})

describe('the additive entry/config/revoked effects', () => {
  it('emits an entry effect alongside the ack', () => {
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload: buildEntryPayload(entryFixture), authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const { effects } = handleWrap(childBase, wrap, child.sk, guardian.pk, AT)
    expect(effects.map((e) => e.type).sort()).toEqual(['ack', 'entry'])
    expect(effects).toContainEqual({ type: 'entry', entry: entryFixture, authorPk: guardian.pk })
  })

  it('emits a config effect when a doc applies', () => {
    const wrap = wrapFor({ innerKind: KIND_CONFIG, payload: buildConfigPayload('chores', choresDoc), authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const { effects } = handleWrap(childBase, wrap, child.sk, guardian.pk, AT)
    expect(effects).toContainEqual({ type: 'config', docKind: 'chores' })
  })

  it('emits no config effect when LWW drops the doc as stale', () => {
    const applied = dispatchInner(childBase, KIND_CONFIG, buildConfigPayload('chores', choresDoc), guardian.pk, AT)
    const stale = dispatchInner(applied.state, KIND_CONFIG, buildConfigPayload('chores', { ...choresDoc, issuedAt: 800 }), guardian.pk, AT)
    expect(stale.effects).toEqual([])
    expect(stale.state).toBe(applied.state)
  })

  it('does not re-fire the entry effect for a duplicate ENTRY (the ack still goes out)', () => {
    const first = dispatchInner(childBase, KIND_ENTRY, buildEntryPayload(entryFixture), guardian.pk, AT)
    expect(first.effects.map((e) => e.type).sort()).toEqual(['ack', 'entry'])
    const again = dispatchInner(first.state, KIND_ENTRY, buildEntryPayload(entryFixture), guardian.pk, AT)
    expect(again.effects).toEqual([{ type: 'ack', entryId: entryFixture.id, authorPk: guardian.pk }])
    expect(again.state.entries).toEqual([entryFixture])
  })

  // REVISED in fix round 1 (this test previously asserted the opposite).
  //
  // The effect is now derived from the APPLIED state, never from the payload,
  // so effect and state can never disagree. The old behaviour — surfacing a
  // revocation carried by a doc the LWW dropped — bricked the device: the
  // store's handler wiped the key and cleared the PIN, while
  // `state.ts#selfRevokedAt` (which reads the APPLIED doc) still said null, so
  // App.tsx routed to ChildShell, which showed ChildLock, which asked for a
  // PIN that no longer existed. No Unpaired screen, no way in, no way out.
  //
  // Nothing is actually lost by this: a stale doc is by definition superseded
  // by one this device has already applied, and if the guardian really has
  // revoked this device, the doc that says so is the newer one and wins.
  it('does NOT emit revoked when the accounts doc carrying it is LWW-dropped as stale', () => {
    const fresh: ConfigDocs['accounts'] = { v: 1, issuedAt: 900, accounts: [], revoked: {} }
    const applied = dispatchInner(childBase, KIND_CONFIG, buildConfigPayload('accounts', fresh), guardian.pk, AT)
    const stale: ConfigDocs['accounts'] = { v: 1, issuedAt: 800, accounts: [], revoked: { [child.pk]: 780 } }
    const dropped = dispatchInner(applied.state, KIND_CONFIG, buildConfigPayload('accounts', stale), guardian.pk, AT)
    expect(dropped.state.docs.accounts).toBe(applied.state.docs.accounts)
    expect(dropped.effects.some((e) => e.type === 'config')).toBe(false)
    expect(dropped.effects.some((e) => e.type === 'revoked')).toBe(false)
  })

  // The other half of "derive it from the applied state": the effect fires
  // whenever the state that RESULTS says this device is revoked, whether or
  // not this particular doc was the one that carried the revocation...
  it('emits revoked whenever the doc that WINS says this device is out', () => {
    const doc: ConfigDocs['accounts'] = { v: 1, issuedAt: 900, accounts: [], revoked: { [child.pk]: 880 } }
    const { state, effects } = dispatchInner(childBase, KIND_CONFIG, buildConfigPayload('accounts', doc), guardian.pk, AT)
    expect(effects).toContainEqual({ type: 'revoked', at: 880 })
    expect(state.docs.accounts.revoked?.[child.pk]).toBe(880)
  })

  // ...but only ONCE. A device already revoked in its own state re-receiving
  // an accounts doc must not re-wipe a key and re-clear a PIN on every later
  // policy change the guardian happens to publish.
  it('does not re-emit revoked for a device that was already revoked before this doc', () => {
    const revoking: ConfigDocs['accounts'] = { v: 1, issuedAt: 900, accounts: [], revoked: { [child.pk]: 880 } }
    const first = dispatchInner(childBase, KIND_CONFIG, buildConfigPayload('accounts', revoking), guardian.pk, AT)
    const later: ConfigDocs['accounts'] = { v: 1, issuedAt: 1000, accounts: [], revoked: { [child.pk]: 880 } }
    const second = dispatchInner(first.state, KIND_CONFIG, buildConfigPayload('accounts', later), guardian.pk, AT)
    expect(second.effects.some((e) => e.type === 'config')).toBe(true)
    expect(second.effects.some((e) => e.type === 'revoked')).toBe(false)
  })

  it('emits a revoked effect on the child whose own pubkey the accounts doc revokes', () => {
    const doc: ConfigDocs['accounts'] = { v: 1, issuedAt: 900, accounts: [], revoked: { [child.pk]: 880 } }
    const { effects } = dispatchInner(childBase, KIND_CONFIG, buildConfigPayload('accounts', doc), guardian.pk, AT)
    expect(effects).toContainEqual({ type: 'revoked', at: 880 })
  })

  it('does not emit a revoked effect for another child, or on the guardian', () => {
    const other = makeKeypair()
    const doc: ConfigDocs['accounts'] = { v: 1, issuedAt: 900, accounts: [], revoked: { [other.pk]: 880 } }
    const onChild = dispatchInner(childBase, KIND_CONFIG, buildConfigPayload('accounts', doc), guardian.pk, AT)
    expect(onChild.effects.some((e) => e.type === 'revoked')).toBe(false)

    const selfRevoking: ConfigDocs['accounts'] = { v: 1, issuedAt: 900, accounts: [], revoked: { [guardian.pk]: 880 } }
    const onGuardian = dispatchInner(
      { ...guardianBase, self: { pubkey: guardian.pk, childIndex: null } },
      KIND_CONFIG,
      buildConfigPayload('accounts', selfRevoking),
      guardian.pk,
      AT,
    )
    expect(onGuardian.effects.some((e) => e.type === 'revoked')).toBe(false)
  })
})

describe('dispatchInner keeps handleWrap`s guards (spec §2.4)', () => {
  it('refuses a CONFIG whose author is not the guardian (direction guard)', () => {
    const result = dispatchInner(guardianBase, KIND_CONFIG, buildConfigPayload('chores', choresDoc), child.pk, AT)
    expect(result.state).toBe(guardianBase)
    expect(result.effects).toEqual([])
  })

  it('refuses a CONFIG doc issued too far in the future (issuedAt clamp)', () => {
    const doc: ConfigDocs['chores'] = { v: 1, issuedAt: AT + MAX_ISSUED_AT_SKEW_SECS + 1, chores: [] }
    const result = dispatchInner(childBase, KIND_CONFIG, buildConfigPayload('chores', doc), guardian.pk, AT)
    expect(result.state).toBe(childBase)
    expect(result.effects).toEqual([])
    expect(result.state.docHighWater.chores).toBeUndefined()
    // Deferred, not dropped (audit P3): the refusal is about our clock.
    expect(result.deferred).toBe(true)
  })

  it('folds an entry with no wrap in sight — one fold path for live traffic and resync alike', () => {
    const result = dispatchInner(childBase, KIND_ENTRY, buildEntryPayload(entryFixture), guardian.pk, AT)
    expect(result.state.entries).toEqual([entryFixture])
    expect(result.effects.map((e) => e.type).sort()).toEqual(['ack', 'entry'])
  })
})

// --- v0.2 §1.5: a snapshot teaches the family root too --------------------------
//
// A child paired BEFORE the guardian connected My Signet has no root, and no
// second pairing ceremony is coming. The snapshot is how it finds out.

describe('the family root arriving on a SNAPSHOT', () => {
  const signetSk = generateSecretKey()
  const signetPk = getPublicKey(signetSk)

  function attest(challenge: string, sk = signetSk) {
    return finalizeEvent(
      { kind: 21236, created_at: AT, content: '', tags: [['challenge', challenge], ['app', 'Jar']] },
      sk,
    )
  }

  function snapshot(root?: { pubkey: string; authEvent: ReturnType<typeof attest> }) {
    return buildSnapshotPayload(
      {
        children: [],
        entries: [],
        docs: {
          accounts: { v: 1, issuedAt: 0, accounts: [] },
          allowance: { v: 1, issuedAt: 0, configs: [] },
          interest: { v: 1, issuedAt: 0, configs: [] },
          chores: { v: 1, issuedAt: 0, chores: [] },
        },
      },
      root,
    )
  }

  it('adopts a root that verifies against the authenticated guardian', () => {
    const payload = snapshot({ pubkey: signetPk, authEvent: attest(rootChallenge(guardian.pk)) })
    const { state } = dispatchInner(childBase, KIND_SNAPSHOT, payload, guardian.pk, AT)
    expect(state.root).toEqual({ kind: 'signet', pubkey: signetPk, authEvent: expect.any(Object), backedUpAt: null })
  })

  it('ignores a root bound to a different guardian key, silently', () => {
    const otherPk = getPublicKey(generateSecretKey())
    const payload = snapshot({ pubkey: signetPk, authEvent: attest(rootChallenge(otherPk)) })
    const { state, effects } = dispatchInner(childBase, KIND_SNAPSHOT, payload, guardian.pk, AT)
    expect(state.root).toBeNull()
    expect(effects).toEqual([])
  })

  it('ignores a root whose signature does not hold', () => {
    const good = attest(rootChallenge(guardian.pk))
    const payload = snapshot({ pubkey: signetPk, authEvent: { ...good, sig: 'f'.repeat(128) } })
    const { state } = dispatchInner(childBase, KIND_SNAPSHOT, payload, guardian.pk, AT)
    expect(state.root).toBeNull()
  })

  it('leaves an existing root alone when the snapshot carries none', () => {
    const existing = { kind: 'signet' as const, pubkey: signetPk, authEvent: attest(rootChallenge(guardian.pk)), backedUpAt: null }
    const { state } = dispatchInner({ ...childBase, root: existing }, KIND_SNAPSHOT, snapshot(), guardian.pk, AT)
    expect(state.root).toBe(existing)
  })

  it('never adopts a root from a snapshot the direction guard refused', () => {
    const payload = snapshot({ pubkey: signetPk, authEvent: attest(rootChallenge(child.pk)) })
    const { state } = dispatchInner(guardianBase, KIND_SNAPSHOT, payload, child.pk, AT)
    expect(state.root).toBeNull()
    expect(state).toBe(guardianBase)
  })
})

// ============================================================================
// KIND_STATUS — the heartbeat/resync effects (spec §2.2). The dispatcher
// never folds any of these into state: a peer's own view of the ledger is a
// CLAIM, and what to do about it belongs to the store (compare, then send a
// snapshot or ask for a replay), not to the fold.
// ============================================================================

describe('dispatchInner: KIND_STATUS (spec §2.2)', () => {
  const status = buildStatusPayload({ at: AT, lastEntryId: 'e5', entryCount: 5, docHighWater: { chores: 10 }, appVersion: '0.2.0' })

  it('surfaces a status heartbeat, leaving state untouched', () => {
    const { state, effects } = dispatchInner(guardianBase, KIND_STATUS, status, child.pk, AT)
    expect(state).toBe(guardianBase)
    expect(effects).toEqual([{ type: 'status', payload: status, authorPk: child.pk }])
  })

  it('surfaces a resync request with its cursor', () => {
    const { state, effects } = dispatchInner(guardianBase, KIND_STATUS, buildResyncRequestPayload('e5'), child.pk, AT)
    expect(state).toBe(guardianBase)
    expect(effects).toEqual([{ type: 'resyncRequest', since: 'e5', authorPk: child.pk }])
  })

  it('surfaces a null-cursor resync request (everything you have)', () => {
    const { effects } = dispatchInner(guardianBase, KIND_STATUS, buildResyncRequestPayload(null), child.pk, AT)
    expect(effects).toEqual([{ type: 'resyncRequest', since: null, authorPk: child.pk }])
  })

  it('surfaces a resync reply WITHOUT ingesting it — verification is resync.ts s job', () => {
    const reply = buildResyncReplyPayload({ events: [], page: 0, more: false })
    const { state, effects } = dispatchInner(childBase, KIND_STATUS, reply, guardian.pk, AT)
    expect(state).toBe(childBase)
    expect(effects).toEqual([{ type: 'resyncReply', payload: reply, authorPk: guardian.pk }])
  })

  it('ignores an unknown status-kind type', () => {
    const { state, effects } = dispatchInner(guardianBase, KIND_STATUS, { v: 1, type: 'gossip' }, child.pk, AT)
    expect(state).toBe(guardianBase)
    expect(effects).toEqual([])
  })

  it('ignores a malformed status payload', () => {
    const { effects } = dispatchInner(guardianBase, KIND_STATUS, { v: 1, type: 'status', entryCount: 'lots' }, child.pk, AT)
    expect(effects).toEqual([])
  })

  it('does not retain a STATUS in the inner-event corpus', () => {
    const wrap = wrapFor({ innerKind: KIND_STATUS, payload: status, authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })
    const { state, effects } = handleWrap(guardianBase, wrap, guardian.sk, child.pk, AT)
    expect(state.innerEvents).toEqual({})
    expect(effects).toEqual([{ type: 'status', payload: status, authorPk: child.pk }])
  })
})

// Review fix (round 1): a CHILD_SIG we already hold must not re-fire its
// effect. Phase D3 hangs notifications off these, and a resync replay of an
// aged-out tick would otherwise buzz a guardian's phone about a chore ticked
// last week. Same rule the ENTRY case already applies to its `entry` effect:
// the fold is idempotent, so the effect must be too.
describe('dispatchInner: CHILD_SIG is idempotent in its effects too', () => {
  const tick = { id: 't-dupe', chore: 'c1', day: '2026-09-02', at: AT }
  const audit = {
    id: 'au-dupe',
    account: 'a-ledger',
    child: child.pk,
    countedMinor: 100,
    expectedMinor: 100,
    deltaMinor: 0,
    at: AT,
    author: 'child' as const,
  }

  it('fires a tick effect once, and not again for an id already held', () => {
    const first = dispatchInner(guardianBase, KIND_CHILD_SIG, buildChildTickPayload(tick), child.pk, AT)
    expect(first.effects).toEqual([{ type: 'tick', tick, authorPk: child.pk }])

    const again = dispatchInner(first.state, KIND_CHILD_SIG, buildChildTickPayload(tick), child.pk, AT)
    expect(again.state).toBe(first.state)
    expect(again.effects).toEqual([])
  })

  it('fires an audit effect once, and not again for an id already held', () => {
    const first = dispatchInner(guardianBase, KIND_CHILD_SIG, buildChildAuditPayload(audit), child.pk, AT)
    expect(first.effects).toEqual([{ type: 'audit', audit, authorPk: child.pk }])
    expect(dispatchInner(first.state, KIND_CHILD_SIG, buildChildAuditPayload(audit), child.pk, AT).effects).toEqual([])
  })
})

// ============================================================================
// ENTRY provenance (audit P1, superseding fix round 2's item I2).
//
// I2 folded an ENTRY when its author was the child it names. That still let a
// child mint a `credit` to itself (labelled `author: 'guardian'`), or name
// itself but put a leg on a SIBLING's account. No production flow has a child
// author an ENTRY (spends go REQUEST -> the guardian's own ENTRY), so ENTRY is
// now guardian-only, and even a guardian entry must bind to the accounts doc.
// A refusal is exactly like an unparseable payload — no state change, no ack,
// no effects — and the resync path counts it as a rejection.
// ============================================================================

describe('ENTRY provenance (audit P1)', () => {
  const siblingEntry = creditEntry({ id: 'e-ingress-sibling', child: sibling.pk, createdAt: AT, author: 'guardian' }, siblingAccount, 500)

  it('refuses a child-signed credit to itself, even labelled author guardian — no minting', () => {
    const forged = { ...entryFixture, id: 'forged-1', legs: [{ account: account.id, currency: 'GBP', amountMinor: 1_000_000 }] }
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload: buildEntryPayload(forged), authorSk: child.sk, recipientPk: guardian.pk, nowSec: AT })
    const { state, effects } = handleWrap(guardianBase, wrap, guardian.sk, child.pk, AT)
    expect(state.entries).toEqual([])
    expect(effects).toEqual([])
    expect(state.innerEvents).toEqual({})
  })

  it('refuses a child-signed transfer naming itself but debiting a sibling account', () => {
    const forged = {
      ...entryFixture,
      id: 'forged-2',
      kind: 'transfer' as const,
      author: 'child' as const,
      legs: [
        { account: siblingAccount.id, currency: 'GBP', amountMinor: -500 },
        { account: account.id, currency: 'GBP', amountMinor: 500 },
      ],
    }
    const r = dispatchInner(guardianBase, KIND_ENTRY, buildEntryPayload(forged), child.pk, AT)
    expect(r.state).toBe(guardianBase)
    expect(r.effects).toEqual([])
  })

  it('refuses even a well-formed child-authored ENTRY for that same child, and does not ack it', () => {
    const own = { ...entryFixture, author: 'child' as const }
    const r = dispatchInner(guardianBase, KIND_ENTRY, buildEntryPayload(own), child.pk, AT)
    expect(r.state).toBe(guardianBase)
    expect(r.effects.map((e) => e.type)).not.toContain('ack')
  })

  it('folds a guardian-authored ENTRY for any child', () => {
    const r = dispatchInner(guardianBase, KIND_ENTRY, buildEntryPayload(siblingEntry), guardian.pk, AT)
    expect(r.state.entries).toEqual([siblingEntry])
    expect(r.effects).toContainEqual({ type: 'entry', entry: siblingEntry, authorPk: guardian.pk })
  })

  it('applies on the child side too — a sibling device cannot author this child s entries', () => {
    const r = dispatchInner(childBase, KIND_ENTRY, buildEntryPayload(entryFixture), sibling.pk, AT)
    expect(r.state).toBe(childBase)
    expect(r.effects).toEqual([])
  })

  it('refuses a guardian ENTRY whose leg is on another child s account, or in the wrong currency', () => {
    const crossChild = { ...entryFixture, id: 'x-child', legs: [{ account: siblingAccount.id, currency: 'GBP', amountMinor: 500 }] }
    const r1 = dispatchInner(childBase, KIND_ENTRY, buildEntryPayload(crossChild), guardian.pk, AT)
    expect(r1.state).toBe(childBase)
    expect(r1.effects).toEqual([])
    const wrongCcy = { ...entryFixture, id: 'x-ccy', legs: [{ account: account.id, currency: 'EUR', amountMinor: 500 }] }
    const r2 = dispatchInner(childBase, KIND_ENTRY, buildEntryPayload(wrongCcy), guardian.pk, AT)
    expect(r2.state).toBe(childBase)
    expect(r2.effects).toEqual([])
  })

  it('defers a guardian ENTRY on an account not yet known, and folds the SAME wrap once the accounts doc arrives', () => {
    const newAccount: Account = { id: 'a-new', child: child.pk, name: 'Savings', currency: 'GBP', custody: 'ledger' }
    const entry = creditEntry({ id: 'e-new-acct', child: child.pk, createdAt: AT, author: 'guardian' }, newAccount, 250)
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload: buildEntryPayload(entry), authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const first = handleWrap(childBase, wrap, child.sk, guardian.pk, AT)
    expect(first.state).toBe(childBase)
    expect(first.state.seenEventIds).not.toContain(wrap.id)

    const withAccount = dispatchInner(
      childBase,
      KIND_CONFIG,
      buildConfigPayload('accounts', { v: 1, issuedAt: 2, accounts: [account, siblingAccount, newAccount] }),
      guardian.pk,
      AT,
    ).state
    const later = handleWrap(withAccount, wrap, child.sk, guardian.pk, AT)
    expect(later.state.entries).toEqual([entry])
    expect(later.state.seenEventIds).toContain(wrap.id)
  })
})

// ============================================================================
// CHILD_SIG binding (audit P8): a child signs for itself only.
// ============================================================================

describe('CHILD_SIG binding (audit P8)', () => {
  it('refuses a tick on a sibling s chore', () => {
    const tick = { id: 't-sib', chore: 'c-sibling', day: '2026-09-02', at: AT }
    const r = dispatchInner(guardianBase, KIND_CHILD_SIG, buildChildTickPayload(tick), child.pk, AT)
    expect(r.state).toBe(guardianBase)
    expect(r.effects).toEqual([])
  })

  it('refuses an audit naming a sibling account, or labelled author guardian', () => {
    const base = { id: 'aud-x', countedMinor: 0, expectedMinor: 0, deltaMinor: 0, at: AT }
    const onSibling = { ...base, account: siblingAccount.id, child: sibling.pk, author: 'child' as const }
    expect(dispatchInner(guardianBase, KIND_CHILD_SIG, buildChildAuditPayload(onSibling), child.pk, AT).state).toBe(guardianBase)
    const selfButSiblingAccount = { ...base, account: siblingAccount.id, child: child.pk, author: 'child' as const }
    expect(dispatchInner(guardianBase, KIND_CHILD_SIG, buildChildAuditPayload(selfButSiblingAccount), child.pk, AT).state).toBe(guardianBase)
    const asGuardian = { ...base, account: account.id, child: child.pk, author: 'guardian' as const }
    expect(dispatchInner(guardianBase, KIND_CHILD_SIG, buildChildAuditPayload(asGuardian), child.pk, AT).state).toBe(guardianBase)
  })

  it('defers a tick on a chore not yet known', () => {
    const tick = { id: 't-unknown', chore: 'c-future', day: '2026-09-02', at: AT }
    const r = dispatchInner(guardianBase, KIND_CHILD_SIG, buildChildTickPayload(tick), child.pk, AT)
    expect(r.deferred).toBe(true)
    expect(r.state).toBe(guardianBase)
  })
})

// ============================================================================
// Clock-skew deferral (audit P3): a CONFIG refused by the issuedAt clamp must
// stay deliverable — the refusal is about the receiver's clock, not the doc.
// ============================================================================

describe('a CONFIG beyond the skew clamp is deferred, not lost (audit P3)', () => {
  it('is not marked seen, and the same wrap applies once the clock has caught up', () => {
    const guardianNow = 10 * MAX_ISSUED_AT_SKEW_SECS
    const childNow = guardianNow - MAX_ISSUED_AT_SKEW_SECS - 600 // child clock slow beyond the window
    const doc: ConfigDocs['chores'] = { v: 1, issuedAt: guardianNow, chores: [] }
    const wrap = wrapFor({ innerKind: KIND_CONFIG, payload: buildConfigPayload('chores', doc), authorSk: guardian.sk, recipientPk: child.pk, nowSec: guardianNow })

    const first = handleWrap(childBase, wrap, child.sk, guardian.pk, childNow)
    expect(first.state.docHighWater.chores ?? 0).toBe(0)
    expect(first.state.seenEventIds).not.toContain(wrap.id)
    expect(first.state.innerEvents).toEqual({})

    const later = handleWrap(first.state, wrap, child.sk, guardian.pk, childNow + 3600)
    expect(later.state.docHighWater.chores).toBe(guardianNow)
    expect(later.effects).toContainEqual({ type: 'config', docKind: 'chores' })
  })
})

// ============================================================================
// Snapshot scoping on the child (audit P6): a child keeps its own ledger only.
// ============================================================================

describe('applySnapshot on a child keeps its own ledger only (audit P6)', () => {
  const siblingEntry = creditEntry({ id: 'e-sibling', child: sibling.pk, createdAt: AT, author: 'guardian' }, siblingAccount, 900)
  const familySnapshot = buildSnapshotPayload({
    children: [
      { pubkey: child.pk, name: 'Alex', index: 0 },
      { pubkey: sibling.pk, name: 'Sam', index: 1 },
    ],
    entries: [entryFixture, siblingEntry],
    docs: familyDocs as ConfigDocs,
  })

  it('does not fold a sibling entry or roster row from an old-style family snapshot', () => {
    const r = dispatchInner(childBase, KIND_SNAPSHOT, familySnapshot, guardian.pk, AT)
    expect(r.state.entries).toEqual([entryFixture])
    expect(r.state.children.map((c) => c.pubkey)).toEqual([child.pk])
  })

  it('drops sibling data a device already holds from an earlier family-wide snapshot', () => {
    const stale: AppState = {
      ...childBase,
      entries: [entryFixture, siblingEntry],
      children: [
        { pubkey: child.pk, name: 'Alex', index: 0 },
        { pubkey: sibling.pk, name: 'Sam', index: 1 },
      ],
    }
    const scoped = buildSnapshotPayload({ children: [{ pubkey: child.pk, name: 'Alex', index: 0 }], entries: [entryFixture], docs: familyDocs as ConfigDocs })
    const r = dispatchInner(stale, KIND_SNAPSHOT, scoped, guardian.pk, AT)
    expect(r.state.entries).toEqual([entryFixture])
    expect(r.state.children.map((c) => c.pubkey)).toEqual([child.pk])
  })
})

// ============================================================================
// v0.3: snapshots heal lost GRANTs, and a child says when it is behind.
// ============================================================================

describe('snapshot GRANTs and the child gap signal (v0.3)', () => {
  const denied = buildGrantPayload({ reqId: 'r-lost', nonce: 'n1', decision: 'deny', ts: AT, params: {} })
  const snapshotWith = (grants: ReturnType<typeof buildGrantPayload>[]) =>
    buildSnapshotPayload({ children: [], entries: [], docs: familyDocs as ConfigDocs }, undefined, grants)

  it('folds a GRANT the child never received into its request list', () => {
    const r = dispatchInner(childBase, KIND_SNAPSHOT, snapshotWith([denied]), guardian.pk, AT)
    expect(r.state.requests.map((q) => [q.request.reqId, q.status])).toEqual([['r-lost', 'denied']])
    // Healed silently: no grant effect, so no notification for old news.
    expect(r.effects).toEqual([])
  })

  it('leaves an already-decided ask untouched', () => {
    const once = dispatchInner(childBase, KIND_SNAPSHOT, snapshotWith([denied]), guardian.pk, AT).state
    const twice = dispatchInner(once, KIND_SNAPSHOT, snapshotWith([{ ...denied, decision: 'allow' }]), guardian.pk, AT + 10).state
    expect(twice.requests).toEqual(once.requests)
  })

  it('raises a gap effect when a child defers a live ENTRY on an unknown account', () => {
    const stranger: Account = { id: 'a-unknown', child: child.pk, name: 'Savings', currency: 'GBP', custody: 'ledger' }
    const entry = creditEntry({ id: 'e-gap', child: child.pk, createdAt: AT, author: 'guardian' }, stranger, 100)
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload: buildEntryPayload(entry), authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const r = handleWrap(childBase, wrap, child.sk, guardian.pk, AT)
    expect(r.state).toBe(childBase)
    expect(r.effects).toEqual([{ type: 'gap', reason: 'entry-deferred' }])
  })
})

// ============================================================================
// Review R5: only an UNKNOWN account defers; a mismatch is refused for good.
// ============================================================================

describe('ENTRY deferral is only for an unknown account (review R5)', () => {
  it('refuses, not defers, a leg on a sibling s account or in the wrong currency', () => {
    const crossChild = { ...entryFixture, id: 'x-r5', legs: [{ account: siblingAccount.id, currency: 'GBP', amountMinor: 500 }] }
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload: buildEntryPayload(crossChild), authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })
    const r = handleWrap(childBase, wrap, child.sk, guardian.pk, AT)
    expect(r.state.entries).toEqual([])
    // Seen, so the same wrap is not decrypted and refused again on every reconnect.
    expect(r.state.seenEventIds).toContain(wrap.id)
    expect(r.effects).toEqual([])
    const wrongCcy = { ...entryFixture, id: 'x-r5-ccy', legs: [{ account: account.id, currency: 'EUR', amountMinor: 500 }] }
    expect(dispatchInner(childBase, KIND_ENTRY, buildEntryPayload(wrongCcy), guardian.pk, AT).deferred).toBeUndefined()
  })
})
