// Task 8: the onboarding state machine — turning emptyState() into a
// guardian or a paired child, and a guardian adding a new child. See
// internal plan 2026-08-10-wire-identity-pairing, Task 8, and
// this task's brief.

import { describe, it, expect } from 'vitest'
import { bytesToHex } from 'nostr-tools/utils'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import type { Entry } from '../domain/types'
import { deriveDependantKey, generateMnemonic, guardianFromMnemonic } from '../identity/derive'
import { rootChallenge } from '../identity/signetRoot'
import { buildPairOfferPayload, buildSnapshotPayload, type SnapshotPayload } from '../wire/payloads'
import { emptyState } from './state'
import type { AppState, ChildProfile } from './types'
import { addChild, startAsChildFromOffer, startAsGuardian } from './onboarding'

const TEST_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const RELAYS = ['wss://relay.example.com']
const AT = 1_700_000_000

const entry = (id: string, overrides: Partial<Entry> = {}): Entry => ({
  v: 1,
  id,
  child: 'sam',
  kind: 'credit',
  createdAt: 1000,
  author: 'guardian',
  legs: [{ account: 'a-ledger', currency: 'GBP', amountMinor: 500 }],
  ...overrides,
})

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

describe('startAsGuardian', () => {
  it('sets role, pubkey and self fields, and returns the derived guardian sk', () => {
    const guardian = guardianFromMnemonic(TEST_MNEMONIC)
    const result = startAsGuardian(emptyState(), TEST_MNEMONIC)
    expect(result).not.toBeNull()
    const { state, guardianSk } = result!

    expect(state.role).toBe('guardian')
    expect(state.guardianPubkey).toBe(guardian.pk)
    expect(state.self).toEqual({ pubkey: guardian.pk, childIndex: null })
    expect(bytesToHex(guardianSk)).toBe(bytesToHex(guardian.sk))
  })

  it('is deterministic: the same mnemonic always yields the same guardian identity', () => {
    const a = startAsGuardian(emptyState(), TEST_MNEMONIC)
    const b = startAsGuardian(emptyState(), TEST_MNEMONIC)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.state.guardianPubkey).toBe(b!.state.guardianPubkey)
    expect(bytesToHex(a!.guardianSk)).toBe(bytesToHex(b!.guardianSk))
  })

  it('leaves unrelated state fields untouched', () => {
    const seeded: AppState = { ...emptyState(), relays: ['wss://custom.example'] }
    const result = startAsGuardian(seeded, TEST_MNEMONIC)
    expect(result).not.toBeNull()
    const { state } = result!
    expect(state.relays).toEqual(['wss://custom.example'])
    expect(state.children).toEqual([])
    expect(state.entries).toEqual([])
  })

  it('does not mutate the input state', () => {
    const before = emptyState()
    const snapshot = JSON.parse(JSON.stringify(before))
    startAsGuardian(before, TEST_MNEMONIC)
    expect(before).toEqual(snapshot)
  })

  it('fails closed on an invalid mnemonic, without throwing (Plan 3 restore flow feeds user input here)', () => {
    expect(startAsGuardian(emptyState(), 'not a valid mnemonic at all')).toBeNull()
  })

  it('still works for a freshly generated, valid mnemonic', () => {
    const mnemonic = generateMnemonic()
    const result = startAsGuardian(emptyState(), mnemonic)
    expect(result).not.toBeNull()
    expect(result!.state.role).toBe('guardian')
  })
})

describe('startAsChildFromOffer', () => {
  it('pins the guardian to the authenticated seal author, never a value from the offer payload', () => {
    const { sk: childSk, pk: childPk } = deriveDependantKey(TEST_MNEMONIC, 0)
    const offer = buildPairOfferPayload({
      childSkHex: bytesToHex(childSk),
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot: emptySnapshot(),
    })
    const sealAuthorPk = guardianFromMnemonic(TEST_MNEMONIC).pk

    const next = startAsChildFromOffer(emptyState(), offer, sealAuthorPk, AT)?.state ?? null

    expect(next).not.toBeNull()
    expect(next?.role).toBe('child')
    expect(next?.guardianPubkey).toBe(sealAuthorPk)
    expect(next?.self).toEqual({ pubkey: childPk, childIndex: 0 })
    expect(next?.self.pubkey).toBe(getPublicKey(childSk))
    expect(next?.relays).toEqual(RELAYS)
  })

  it('merges the offer snapshot (entries, config docs, children) into state', () => {
    const { sk: childSk } = deriveDependantKey(TEST_MNEMONIC, 0)
    const sibling: ChildProfile = { pubkey: 'a'.repeat(64), name: 'Robin', index: 1 }
    const snapshot = buildSnapshotPayload({
      children: [sibling],
      entries: [entry('e1')],
      docs: {
        accounts: { v: 1, issuedAt: 5, accounts: [] },
        allowance: { v: 1, issuedAt: 0, configs: [] },
        interest: { v: 1, issuedAt: 0, configs: [] },
        chores: { v: 1, issuedAt: 0, chores: [] },
      },
    })
    const offer = buildPairOfferPayload({
      childSkHex: bytesToHex(childSk),
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot,
    })
    const sealAuthorPk = guardianFromMnemonic(TEST_MNEMONIC).pk

    const next = startAsChildFromOffer(emptyState(), offer, sealAuthorPk, AT)?.state ?? null

    expect(next?.entries).toEqual([entry('e1')])
    expect(next?.docs.accounts.issuedAt).toBe(5)
    expect(next?.children).toEqual([sibling])
  })

  it('clamps a far-future doc against the caller-supplied nowSec (closes the Plan 2 residual: no longer unclamped against Infinity)', () => {
    const { sk: childSk } = deriveDependantKey(TEST_MNEMONIC, 0)
    const snapshot = buildSnapshotPayload({
      children: [],
      entries: [],
      docs: {
        accounts: { v: 1, issuedAt: Number.MAX_SAFE_INTEGER, accounts: [] }, // far future -> must be skipped
        allowance: { v: 1, issuedAt: AT, configs: [] }, // normal -> still applied
        interest: { v: 1, issuedAt: 0, configs: [] },
        chores: { v: 1, issuedAt: 0, chores: [] },
      },
    })
    const offer = buildPairOfferPayload({
      childSkHex: bytesToHex(childSk),
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot,
    })
    const sealAuthorPk = guardianFromMnemonic(TEST_MNEMONIC).pk

    const next = startAsChildFromOffer(emptyState(), offer, sealAuthorPk, AT)?.state ?? null

    expect(next?.docs.accounts).toEqual(emptyState().docs.accounts) // skipped, never poisoned
    expect(next?.docHighWater.accounts).toBeUndefined()
    expect(next?.docs.allowance.issuedAt).toBe(AT) // unaffected, still merges
  })

  it('returns null for a malformed offer (bad childSkHex)', () => {
    const badOffer = buildPairOfferPayload({
      childSkHex: 'not-hex',
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot: emptySnapshot(),
    })
    const sealAuthorPk = guardianFromMnemonic(TEST_MNEMONIC).pk
    expect(startAsChildFromOffer(emptyState(), badOffer, sealAuthorPk, AT)).toBeNull()
  })

  it('returns null when sealAuthorPk is empty', () => {
    const { sk: childSk } = deriveDependantKey(TEST_MNEMONIC, 0)
    const offer = buildPairOfferPayload({
      childSkHex: bytesToHex(childSk),
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot: emptySnapshot(),
    })
    expect(startAsChildFromOffer(emptyState(), offer, '', AT)).toBeNull()
  })

  it('does not mutate the input state', () => {
    const { sk: childSk } = deriveDependantKey(TEST_MNEMONIC, 0)
    const offer = buildPairOfferPayload({
      childSkHex: bytesToHex(childSk),
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot: emptySnapshot(),
    })
    const sealAuthorPk = guardianFromMnemonic(TEST_MNEMONIC).pk
    const before = emptyState()
    const snapshot = JSON.parse(JSON.stringify(before))
    startAsChildFromOffer(before, offer, sealAuthorPk, AT)
    expect(before).toEqual(snapshot)
  })
})

describe('addChild', () => {
  it('assigns index 0 to the first child, deriving its pubkey from the mnemonic', () => {
    const { state, child } = addChild(emptyState(), TEST_MNEMONIC, 'Sam')
    const expected = deriveDependantKey(TEST_MNEMONIC, 0)
    expect(child).toEqual({ pubkey: expected.pk, name: 'Sam', index: 0 })
    expect(state.children).toEqual([child])
  })

  it('assigns the next free index on successive calls', () => {
    const first = addChild(emptyState(), TEST_MNEMONIC, 'Sam')
    const second = addChild(first.state, TEST_MNEMONIC, 'Robin')
    expect(first.child.index).toBe(0)
    expect(second.child.index).toBe(1)
    expect(second.state.children.map((c) => c.index)).toEqual([0, 1])
  })

  it('skips past the highest existing index even if it was not assigned by addChild itself', () => {
    const seeded: AppState = {
      ...emptyState(),
      children: [{ pubkey: 'a'.repeat(64), name: 'Existing', index: 2 }],
    }
    const { child } = addChild(seeded, TEST_MNEMONIC, 'New')
    expect(child.index).toBe(3)
  })

  it('never stores the derived child secret key anywhere in state', () => {
    const { state } = addChild(emptyState(), TEST_MNEMONIC, 'Sam')
    expect(JSON.stringify(state)).not.toContain(bytesToHex(deriveDependantKey(TEST_MNEMONIC, 0).sk))
  })

  it('does not mutate the input state', () => {
    const before = emptyState()
    const snapshot = JSON.parse(JSON.stringify(before))
    addChild(before, TEST_MNEMONIC, 'Sam')
    expect(before).toEqual(snapshot)
  })

  it('different mnemonics derive different child keys at the same index', () => {
    const other = generateMnemonic()
    const a = addChild(emptyState(), TEST_MNEMONIC, 'Sam')
    const b = addChild(emptyState(), other, 'Sam')
    expect(a.child.pubkey).not.toBe(b.child.pubkey)
  })
})

// --- v0.2 §1.5: the family root arrives with the offer -------------------------

describe('startAsChildFromOffer and the family root', () => {
  const signetSk = generateSecretKey()
  const signetPk = getPublicKey(signetSk)

  function attest(challenge: string) {
    return finalizeEvent(
      { kind: 21236, created_at: AT, content: '', tags: [['challenge', challenge], ['app', 'Jar']] },
      signetSk,
    )
  }

  function offerWith(root?: { pubkey: string; authEvent: NostrEvent }) {
    const { sk: childSk } = deriveDependantKey(TEST_MNEMONIC, 0)
    return buildPairOfferPayload({
      childSkHex: bytesToHex(childSk),
      childIndex: 0,
      name: 'Sam',
      relays: RELAYS,
      snapshot: emptySnapshot(),
      ...(root !== undefined ? { root } : {}),
    })
  }

  const sealAuthorPk = guardianFromMnemonic(TEST_MNEMONIC).pk

  it('stores a verified root on the child, never backed up', () => {
    const got = startAsChildFromOffer(emptyState(), offerWith({ pubkey: signetPk, authEvent: attest(rootChallenge(sealAuthorPk)) }), sealAuthorPk, AT)
    expect(got?.rootRejected).toBe(false)
    expect(got?.state.root).toEqual({ kind: 'signet', pubkey: signetPk, authEvent: expect.any(Object), backedUpAt: null })
  })

  it('pairs without a root and leaves the record alone', () => {
    const got = startAsChildFromOffer(emptyState(), offerWith(), sealAuthorPk, AT)
    expect(got?.rootRejected).toBe(false)
    expect(got?.state.root).toBeNull()
    expect(got?.state.role).toBe('child')
  })

  it('pairs but flags a root bound to another guardian key', () => {
    const otherPk = getPublicKey(generateSecretKey())
    const got = startAsChildFromOffer(emptyState(), offerWith({ pubkey: signetPk, authEvent: attest(rootChallenge(otherPk)) }), sealAuthorPk, AT)
    expect(got?.rootRejected).toBe(true)
    expect(got?.state.role).toBe('child')
    expect(got?.state.root).toBeNull()
  })
})
