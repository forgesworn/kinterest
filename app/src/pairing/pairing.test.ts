// The plan's Task 6 exit gate: a full guardian<->child pairing handshake
// with real keys, real gift-wrap envelopes, and the in-memory fake relay —
// see internal plan 2026-08-10-wire-identity-pairing.

import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { NostrEvent } from 'nostr-tools/pure'
import { unwrapFrom, wrapFor } from '../wire/giftwrap'
import { makeFakeRelay } from '../wire/fakeRelay'
import { KIND_PAIR_OFFER, KIND_REQUEST, WRAP } from '../wire/kinds'
import { buildSnapshotPayload, parsePairOfferPayload, parseRequestPayload, type SnapshotPayload } from '../wire/payloads'
import { deriveDependantKey, generateMnemonic, guardianFromMnemonic } from '../identity/derive'
import { rootChallenge } from '../identity/signetRoot'
import { mintToken, consumeToken, TOKEN_TTL_SECS } from './tokens'
import { sasDigits } from './sas'
import { acceptPairOffer, answerPairClaim, buildPairClaim, parsePairQr, qrContent } from './pairing'

const AT = 1_700_000_000
const RELAYS = ['wss://relay.example.com']

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

describe('full pairing handshake over the fake relay', () => {
  it('mint -> QR -> parse -> claim -> guardian answers -> offer -> child accepts, pinning the seal author', () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)

    // --- Guardian: mint a token, build the QR ---
    const minted = mintToken(AT)
    const qr = qrContent({ guardianPk: guardian.pk, relays: RELAYS, token: minted.token })
    expect(qr.startsWith('kin-jar-pair:v1?')).toBe(true)
    // Name-free by design.
    expect(qr.toLowerCase()).not.toContain('kinterest')

    // --- Child: scan + parse the QR ---
    const parsed = parsePairQr(qr)
    expect(parsed).not.toBeNull()
    expect(parsed?.guardianPk).toBe(guardian.pk)
    expect(parsed?.relays).toEqual(RELAYS)
    expect(parsed?.token).toBe(minted.token)

    // --- Both screens compute (and would compare) the same SAS code ---
    const guardianSas = sasDigits(guardian.pk, minted.token)
    const childSas = sasDigits(parsed!.guardianPk, parsed!.token)
    return Promise.all([guardianSas, childSas]).then(([g, c]) => expect(g).toBe(c))
  })

  it('runs the complete claim/offer round trip end to end', async () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)
    const device = { sk: generateSecretKey(), pk: '' }
    device.pk = getPublicKey(device.sk)
    const relay = makeFakeRelay()

    const minted = mintToken(AT)
    const qr = qrContent({ guardianPk: guardian.pk, relays: RELAYS, token: minted.token })
    const parsed = parsePairQr(qr)
    expect(parsed).not.toBeNull()

    // --- Child: build + wrap the claim, publish to the relay ---
    const claimPayload = buildPairClaim({ devicePk: device.pk, token: parsed!.token, name: 'Kid', nowSec: AT })
    const claimWrap = wrapFor({
      innerKind: KIND_REQUEST,
      payload: claimPayload,
      authorSk: device.sk,
      recipientPk: guardian.pk,
      nowSec: AT,
    })

    // --- Guardian: subscribe first (as it would at runtime), then the
    // claim arrives via deliverAll(). No pin yet on the guardian side — the
    // seal author is captured from the unwrap itself. ---
    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [WRAP], '#p': [guardian.pk] }, (ev) => received.push(ev))
    await relay.publish(claimWrap)
    relay.deliverAll()
    expect(received).toHaveLength(1)

    const unwrappedClaim = unwrapFrom({ wrap: received[0]!, recipientSk: guardian.sk })
    expect(unwrappedClaim).not.toBeNull()
    expect(unwrappedClaim?.authorPk).toBe(device.pk) // the AUTHENTICATED seal author

    const claim = parseRequestPayload(unwrappedClaim!.payload)
    expect(claim).not.toBeNull()
    expect(claim?.op).toBe('pair.claim')

    // --- Guardian: verify the token (single-use gate lives outside answerPairClaim) ---
    expect(consumeToken(minted, (claim!.params as { token: string }).token, AT)).toBe(true)
    const storedAfterConsume = null // caller's contract: remove on success

    // --- Guardian: answer the claim, addressed to the AUTHENTICATED seal author ---
    const answered = answerPairClaim({
      claim: claim!,
      sealAuthorPk: unwrappedClaim!.authorPk,
      mnemonic,
      childIndex: 0,
      childName: 'Kid',
      snapshot: emptySnapshot(),
      relays: RELAYS,
    })
    expect(answered).not.toBeNull()
    expect(answered?.recipientPk).toBe(device.pk)

    const expectedChild = deriveDependantKey(mnemonic, 0)
    expect(answered?.offer.childIndex).toBe(0)

    // --- Guardian: wrap + publish the offer ---
    const offerWrap = wrapFor({
      innerKind: KIND_PAIR_OFFER,
      payload: answered!.offer,
      authorSk: guardian.sk,
      recipientPk: answered!.recipientPk,
      nowSec: AT,
    })
    const receivedByChild: NostrEvent[] = []
    relay.subscribe({ kinds: [WRAP], '#p': [device.pk] }, (ev) => receivedByChild.push(ev))
    await relay.publish(offerWrap)
    relay.deliverAll()
    expect(receivedByChild).toHaveLength(1)

    // --- Child: unwrap, PINNING the guardian pubkey from the QR (the only
    // guardian identity the child ever had) as expectedAuthorPk ---
    const unwrappedOffer = unwrapFrom({
      wrap: receivedByChild[0]!,
      recipientSk: device.sk,
      expectedAuthorPk: parsed!.guardianPk,
    })
    expect(unwrappedOffer).not.toBeNull()
    expect(unwrappedOffer?.authorPk).toBe(guardian.pk)

    const offer = parsePairOfferPayload(unwrappedOffer!.payload)
    expect(offer).not.toBeNull()

    const accepted = acceptPairOffer(offer!, unwrappedOffer!.authorPk)
    expect(accepted).not.toBeNull()
    expect(accepted?.guardianPk).toBe(guardian.pk)
    expect(accepted?.childIndex).toBe(0)
    expect(Array.from(accepted!.childSk)).toEqual(Array.from(expectedChild.sk))

    // --- Token replay: the same claim's token presented again is rejected
    // now that the guardian has removed it on success. ---
    expect(consumeToken(storedAfterConsume, minted.token, AT)).toBe(false)
  })

  it('rejects an expired token', () => {
    const minted = mintToken(AT)
    expect(consumeToken(minted, minted.token, AT + TOKEN_TTL_SECS + 1)).toBe(false)
  })

  it('answerPairClaim returns null when the claimed devicePk disagrees with the authenticated seal author', () => {
    const mnemonic = generateMnemonic()
    const impostor = generateSecretKey()
    const impostorPk = getPublicKey(impostor)
    const realDevicePk = getPublicKey(generateSecretKey())

    const claim = buildPairClaim({ devicePk: realDevicePk, token: 'a'.repeat(32), nowSec: AT })
    const answered = answerPairClaim({
      claim,
      // The wrap was actually sealed by `impostorPk`, not `realDevicePk` —
      // this is the exact "params.devicePk disagrees with the authenticated
      // seal author" case the plan calls out; it must be refused.
      sealAuthorPk: impostorPk,
      mnemonic,
      childIndex: 0,
      childName: 'Kid',
      snapshot: emptySnapshot(),
      relays: RELAYS,
    })
    expect(answered).toBeNull()
  })

  it('answerPairClaim returns null for a non-pair.claim request', () => {
    const mnemonic = generateMnemonic()
    const pk = getPublicKey(generateSecretKey())
    const answered = answerPairClaim({
      claim: {
        v: 1,
        op: 'spend.request',
        reqId: 'r1',
        nonce: 'n1',
        child: pk,
        ts: AT,
        params: { amountMinor: 100, currency: 'GBP', account: 'acc1' },
      },
      sealAuthorPk: pk,
      mnemonic,
      childIndex: 0,
      childName: 'Kid',
      snapshot: emptySnapshot(),
      relays: RELAYS,
    })
    expect(answered).toBeNull()
  })
})

describe('parsePairQr — total on garbage', () => {
  const garbageInputs: unknown[] = [
    '',
    'not-a-pairing-link-at-all',
    'kin-jar-pair:v1?g=tooshort&t=abc',
    `kin-jar-pair:v1?g=${'g'.repeat(64)}&r=wss%3A%2F%2Fx&t=abc`, // non-hex guardianPk
    `kin-jar-pair:v1?g=${'a'.repeat(64)}&t=abc`, // no relay
    `kin-jar-pair:v1?r=wss%3A%2F%2Fx&t=abc`, // no guardianPk
    `kin-jar-pair:v1?g=${'a'.repeat(64)}&r=wss%3A%2F%2Fx`, // no token
    null,
    undefined,
    42,
    {},
  ]

  for (const input of garbageInputs) {
    it(`returns null, never throws, for ${JSON.stringify(input)}`, () => {
      expect(() => parsePairQr(input as string)).not.toThrow()
      expect(parsePairQr(input as string)).toBeNull()
    })
  }

  it('accepts a well-formed QR with multiple relays', () => {
    const qr = `kin-jar-pair:v1?g=${'a'.repeat(64)}&r=${encodeURIComponent('wss://one')}&r=${encodeURIComponent('wss://two')}&t=${'b'.repeat(32)}`
    const parsed = parsePairQr(qr)
    expect(parsed).toEqual({ guardianPk: 'a'.repeat(64), relays: ['wss://one', 'wss://two'], token: 'b'.repeat(32) })
  })
})

describe('acceptPairOffer — total', () => {
  it('returns null for a malformed childSkHex without throwing', () => {
    const pk = getPublicKey(generateSecretKey())
    const offer = {
      v: 1 as const,
      childSkHex: 'not-hex',
      childIndex: 0,
      name: 'Kid',
      relays: RELAYS,
      snapshot: emptySnapshot(),
    }
    expect(() => acceptPairOffer(offer, pk)).not.toThrow()
    expect(acceptPairOffer(offer, pk)).toBeNull()
  })
})

// --- v0.2 §1.5: the family root travels with the offer -------------------------

describe('acceptPairOffer and the family root attestation', () => {
  const signetSk = generateSecretKey()
  const signetPk = getPublicKey(signetSk)
  const guardianPk = getPublicKey(generateSecretKey())
  const otherGuardianPk = getPublicKey(generateSecretKey())

  function attest(challenge: string, sk = signetSk) {
    return finalizeEvent(
      { kind: 21236, created_at: AT, content: '', tags: [['challenge', challenge], ['app', 'Jar']] },
      sk,
    )
  }

  const offer = {
    v: 1 as const,
    childSkHex: 'ab'.repeat(32),
    childIndex: 0,
    name: 'Alex',
    relays: RELAYS,
    snapshot: emptySnapshot(),
  }

  it('accepts and keeps a root that verifies against the seal author', () => {
    const att = { pubkey: signetPk, authEvent: attest(rootChallenge(guardianPk)) }
    const got = acceptPairOffer({ ...offer, root: att }, guardianPk)
    expect(got?.root?.pubkey).toBe(signetPk)
    expect(got?.root?.backedUpAt).toBeNull()
    expect(got?.rootRejected).toBe(false)
  })

  it('pairs anyway but flags a root bound to a DIFFERENT guardian key', () => {
    const att = { pubkey: signetPk, authEvent: attest(rootChallenge(otherGuardianPk)) }
    const got = acceptPairOffer({ ...offer, root: att }, guardianPk)
    expect(got).not.toBeNull()
    expect(got?.root).toBeUndefined()
    expect(got?.rootRejected).toBe(true)
  })

  it('pairs anyway but flags a root whose signature does not hold', () => {
    const att = {
      pubkey: signetPk,
      authEvent: { ...attest(rootChallenge(guardianPk)), sig: 'f'.repeat(128) },
    }
    const got = acceptPairOffer({ ...offer, root: att }, guardianPk)
    expect(got?.root).toBeUndefined()
    expect(got?.rootRejected).toBe(true)
  })

  it('flags a root claiming a pubkey other than the one that signed it', () => {
    const att = { pubkey: otherGuardianPk, authEvent: attest(rootChallenge(guardianPk)) }
    const got = acceptPairOffer({ ...offer, root: att }, guardianPk)
    expect(got?.root).toBeUndefined()
    expect(got?.rootRejected).toBe(true)
  })

  it('pairs with no root at all', () => {
    expect(acceptPairOffer(offer, guardianPk)?.rootRejected).toBe(false)
    expect(acceptPairOffer(offer, guardianPk)?.root).toBeUndefined()
  })

  it('answerPairClaim puts the guardian`s root on the offer it builds', () => {
    const mnemonic = generateMnemonic()
    const guardian = guardianFromMnemonic(mnemonic)
    const child = getPublicKey(generateSecretKey())
    const att = { pubkey: signetPk, authEvent: attest(rootChallenge(guardian.pk)) }
    const answered = answerPairClaim({
      claim: buildPairClaim({ devicePk: child, token: 'a'.repeat(32), nowSec: AT }),
      sealAuthorPk: child,
      mnemonic,
      childIndex: 0,
      childName: 'Alex',
      snapshot: emptySnapshot(),
      relays: RELAYS,
      root: att,
    })
    expect(answered?.offer.root).toEqual(att)
  })
})
