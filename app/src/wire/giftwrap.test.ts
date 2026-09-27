import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { nip44, type EventTemplate, type NostrEvent } from 'nostr-tools'
import { KIND_ENTRY, MARKER_TAG, SEAL, WRAP } from './kinds'
import { MAX_WRAP_JITTER_SECS, unwrapFrom, unwrapWithSigner, wrapFor } from './giftwrap'

const AT = 1_700_000_000

function makeKeypair() {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  return { sk, pk }
}

// Peels a wrap down to the decrypted seal/inner without going through
// unwrapFrom — used only to build a deliberately-tampered wrap for the
// "bad inner signature" test below.
function decryptToSeal(wrap: NostrEvent, recipientSk: Uint8Array): NostrEvent {
  return JSON.parse(
    nip44.decrypt(wrap.content, nip44.getConversationKey(recipientSk, wrap.pubkey)),
  ) as NostrEvent
}
function decryptToInner(seal: NostrEvent, recipientSk: Uint8Array): NostrEvent {
  return JSON.parse(
    nip44.decrypt(seal.content, nip44.getConversationKey(recipientSk, seal.pubkey)),
  ) as NostrEvent
}

// Re-seals + re-wraps an already-built (possibly tampered) inner event —
// mirrors wrapFor's internals so the test can inject an inner whose sig no
// longer matches its content, without duplicating wrapFor's export surface.
function reseal(inner: NostrEvent, authorSk: Uint8Array, recipientPk: string, nowSec: number): NostrEvent {
  const sealTemplate: EventTemplate = {
    kind: SEAL,
    created_at: nowSec,
    tags: [],
    content: nip44.encrypt(JSON.stringify(inner), nip44.getConversationKey(authorSk, recipientPk)),
  }
  const seal = finalizeEvent(sealTemplate, authorSk)
  const ephemeralSk = generateSecretKey()
  const wrapTemplate: EventTemplate = {
    kind: WRAP,
    created_at: nowSec,
    tags: [['p', recipientPk], [...MARKER_TAG]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(ephemeralSk, recipientPk)),
  }
  return finalizeEvent(wrapTemplate, ephemeralSk)
}

describe('wrapFor / unwrapFrom', () => {
  it('round-trips guardian -> child (signed inner, author == guardian)', () => {
    const guardian = makeKeypair()
    const child = makeKeypair()
    const payload = { v: 1, entry: { id: 'e1', amountMinor: 500 } }

    const wrap = wrapFor({
      innerKind: KIND_ENTRY,
      payload,
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })

    expect(wrap.kind).toBe(WRAP)
    expect(wrap.pubkey).not.toBe(guardian.pk) // ephemeral wrap author
    expect(wrap.tags).toContainEqual(['p', child.pk])
    expect(wrap.tags).toContainEqual([...MARKER_TAG])

    const got = unwrapFrom({ wrap, recipientSk: child.sk, expectedAuthorPk: guardian.pk })
    expect(got).not.toBeNull()
    expect(got?.innerKind).toBe(KIND_ENTRY)
    expect(got?.authorPk).toBe(guardian.pk)
    expect(got?.innerCreatedAt).toBe(AT)
    expect(got?.payload).toEqual(payload)
  })

  it('round-trips child -> guardian (signed inner, author == child)', () => {
    const guardian = makeKeypair()
    const child = makeKeypair()
    const payload = { v: 1, op: 'spend.request', reqId: 'r1' }

    const wrap = wrapFor({
      innerKind: KIND_ENTRY,
      payload,
      authorSk: child.sk,
      recipientPk: guardian.pk,
      nowSec: AT,
    })

    const got = unwrapFrom({ wrap, recipientSk: guardian.sk, expectedAuthorPk: child.pk })
    expect(got).not.toBeNull()
    expect(got?.authorPk).toBe(child.pk)
    expect(got?.payload).toEqual(payload)
  })

  it('a tampered inner signature is rejected', () => {
    const guardian = makeKeypair()
    const child = makeKeypair()
    const wrap = wrapFor({
      innerKind: KIND_ENTRY,
      payload: { v: 1 },
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })

    const seal = decryptToSeal(wrap, child.sk)
    const inner = decryptToInner(seal, child.sk)
    // Mutate content after signing without re-signing: id/sig no longer match.
    const tamperedInner: NostrEvent = { ...inner, content: JSON.stringify({ v: 1, hacked: true }) }
    const tamperedWrap = reseal(tamperedInner, guardian.sk, child.pk, AT)

    expect(unwrapFrom({ wrap: tamperedWrap, recipientSk: child.sk })).toBeNull()
  })

  it('the wrong recipient key cannot open the wrap', () => {
    const guardian = makeKeypair()
    const child = makeKeypair()
    const stranger = makeKeypair()
    const wrap = wrapFor({
      innerKind: KIND_ENTRY,
      payload: { v: 1 },
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })

    expect(unwrapFrom({ wrap, recipientSk: stranger.sk })).toBeNull()
  })

  it('an expectedAuthorPk mismatch is rejected', () => {
    const guardian = makeKeypair()
    const child = makeKeypair()
    const impostor = makeKeypair()
    const wrap = wrapFor({
      innerKind: KIND_ENTRY,
      payload: { v: 1 },
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })

    const got = unwrapFrom({ wrap, recipientSk: child.sk, expectedAuthorPk: impostor.pk })
    expect(got).toBeNull()
  })

  it('unwrapping the same wrap twice is stateless and yields the same result', () => {
    const guardian = makeKeypair()
    const child = makeKeypair()
    const wrap = wrapFor({
      innerKind: KIND_ENTRY,
      payload: { v: 1, n: 42 },
      authorSk: guardian.sk,
      recipientPk: child.pk,
      nowSec: AT,
    })

    const first = unwrapFrom({ wrap, recipientSk: child.sk })
    const second = unwrapFrom({ wrap, recipientSk: child.sk })
    expect(first).not.toBeNull()
    expect(second).toEqual(first)
  })

  it('rejects a re-seal attack: B re-seals a genuine A->B inner and forwards it to C', () => {
    const a = makeKeypair()
    const b = makeKeypair()
    const c = makeKeypair()

    // A genuinely sends a signed inner to B.
    const wrapToB = wrapFor({
      innerKind: KIND_ENTRY,
      payload: { v: 1, from: 'A' },
      authorSk: a.sk,
      recipientPk: b.pk,
      nowSec: AT,
    })
    // B decrypts both layers with nostr-tools directly (not via unwrapFrom)
    // to extract A's still-validly-signed inner event.
    const sealAtB = decryptToSeal(wrapToB, b.sk)
    const innerFromA = decryptToInner(sealAtB, b.sk)

    // B re-seals + re-wraps that same (untouched, still A-signed) inner under
    // B's OWN key, addressed to C — as if A were sending to C right now.
    const forgedWrapToC = reseal(innerFromA, b.sk, c.pk, AT)

    // The inner signature still verifies (it's genuinely A's), and even a
    // pin of expectedAuthorPk = A matches inner.pubkey — but the seal author
    // is B, not A, so this must be rejected.
    expect(unwrapFrom({ wrap: forgedWrapToC, recipientSk: c.sk })).toBeNull()
    expect(unwrapFrom({ wrap: forgedWrapToC, recipientSk: c.sk, expectedAuthorPk: a.pk })).toBeNull()
  })

  it('a seal with the wrong kind is rejected', () => {
    const guardian = makeKeypair()
    const child = makeKeypair()

    // Build a legitimate inner, then hand-roll a seal with kind 1 (not 13)
    // around it, and wrap that.
    const innerTemplate: EventTemplate = {
      kind: KIND_ENTRY,
      created_at: AT,
      tags: [[...MARKER_TAG]],
      content: JSON.stringify({ v: 1 }),
    }
    const inner = finalizeEvent(innerTemplate, guardian.sk)
    const badSealTemplate: EventTemplate = {
      kind: 1, // wrong — should be SEAL (13)
      created_at: AT,
      tags: [],
      content: nip44.encrypt(JSON.stringify(inner), nip44.getConversationKey(guardian.sk, child.pk)),
    }
    const badSeal = finalizeEvent(badSealTemplate, guardian.sk)
    const ephemeralSk = generateSecretKey()
    const wrapTemplate: EventTemplate = {
      kind: WRAP,
      created_at: AT,
      tags: [['p', child.pk], [...MARKER_TAG]],
      content: nip44.encrypt(JSON.stringify(badSeal), nip44.getConversationKey(ephemeralSk, child.pk)),
    }
    const badWrap = finalizeEvent(wrapTemplate, ephemeralSk)

    expect(unwrapFrom({ wrap: badWrap, recipientSk: child.sk })).toBeNull()
  })

  it('never throws on a garbage wrap (total)', () => {
    const child = makeKeypair()
    const garbage = {
      id: 'x',
      pubkey: 'y',
      created_at: AT,
      kind: WRAP,
      tags: [],
      content: 'not-nip44-ciphertext',
      sig: 'z',
    } as unknown as NostrEvent
    expect(() => unwrapFrom({ wrap: garbage, recipientSk: child.sk })).not.toThrow()
    expect(unwrapFrom({ wrap: garbage, recipientSk: child.sk })).toBeNull()
  })
})

// --- v0.2: the raw inner event travels back out with the unwrap ----------------

describe('unwrapFrom exposes the raw signed inner event', () => {
  it('hands back the inner event itself — verifiable, re-sendable, bound to the seal author', () => {
    const guardian = makeKeypair()
    const child = makeKeypair()
    const payload = { v: 1, hello: 'world' }
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload, authorSk: guardian.sk, recipientPk: child.pk, nowSec: AT })

    const unwrapped = unwrapFrom({ wrap, recipientSk: child.sk })!

    expect(unwrapped.inner.kind).toBe(KIND_ENTRY)
    expect(unwrapped.inner.id).toMatch(/^[0-9a-f]{64}$/)
    // The point of carrying it: a peer can replay this event to a third
    // device and that device can re-verify it for itself (spec §2.4).
    expect(verifyEvent(unwrapped.inner)).toBe(true)
    expect(unwrapped.inner.pubkey).toBe(unwrapped.authorPk)
    expect(unwrapped.inner.created_at).toBe(unwrapped.innerCreatedAt)
    expect(JSON.parse(unwrapped.inner.content)).toEqual(payload)
  })
})

// --- v0.2 §1.6: unwrapping for a recipient whose secret key we do not hold ---

describe('unwrapWithSigner', () => {
  const alice = makeKeypair()
  const bob = makeKeypair()
  const mal = makeKeypair()
  const { sk: aliceSk, pk: alicePk } = alice
  const { sk: bobSk, pk: bobPk } = bob
  const { sk: malSk } = mal

  /** A stand-in for a Signet NIP-46 signer: decrypts with a raw sk we hold. */
  function fakeSigner(sk: Uint8Array) {
    return { decrypt: async (peerPk: string, ct: string) => nip44.decrypt(ct, nip44.getConversationKey(sk, peerPk)) }
  }

  it('unwrapWithSigner round-trips a wrapFor', async () => {
    const wrap = wrapFor({ innerKind: 31125, payload: { hello: 1 }, authorSk: aliceSk, recipientPk: bobPk, nowSec: 1000 })
    const out = await unwrapWithSigner({ wrap, signer: fakeSigner(bobSk) })
    expect(out?.payload).toEqual({ hello: 1 })
    expect(out?.authorPk).toBe(alicePk)
    expect(out?.inner.kind).toBe(31125)
  })

  it('returns null on a decrypt rejection', async () => {
    const wrap = wrapFor({ innerKind: 31125, payload: {}, authorSk: aliceSk, recipientPk: bobPk, nowSec: 1000 })
    expect(
      await unwrapWithSigner({
        wrap,
        signer: {
          decrypt: async () => {
            throw new Error('nope')
          },
        },
      }),
    ).toBeNull()
  })

  it('returns null on a mismatched expectedAuthorPk', async () => {
    const wrap = wrapFor({ innerKind: 31125, payload: {}, authorSk: aliceSk, recipientPk: bobPk, nowSec: 1000 })
    expect(await unwrapWithSigner({ wrap, signer: fakeSigner(bobSk), expectedAuthorPk: bobPk })).toBeNull()
  })

  it('returns null when the inner author is not the sealer (re-seal replay)', async () => {
    const inner = finalizeEvent({ kind: 31125, created_at: 1000, tags: [], content: '{}' }, aliceSk)
    const seal = finalizeEvent(
      {
        kind: 13,
        created_at: 1000,
        tags: [],
        content: nip44.encrypt(JSON.stringify(inner), nip44.getConversationKey(malSk, bobPk)),
      },
      malSk,
    )
    const eph = generateSecretKey()
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 1000,
        tags: [['p', bobPk]],
        content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(eph, bobPk)),
      },
      eph,
    )
    expect(await unwrapWithSigner({ wrap, signer: fakeSigner(bobSk) })).toBeNull()
  })
})

describe('wrap jitter (audit P17)', () => {
  it('draws the backdating from the CSPRNG and stays within the NIP-59 bound', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues')
    const wrap = wrapFor({ innerKind: KIND_ENTRY, payload: { v: 1 }, authorSk: generateSecretKey(), recipientPk: getPublicKey(generateSecretKey()), nowSec: 10_000_000 })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    expect(wrap.created_at).toBeLessThanOrEqual(10_000_000)
    expect(wrap.created_at).toBeGreaterThan(10_000_000 - MAX_WRAP_JITTER_SECS)
  })
})
