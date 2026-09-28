// NIP-59 gift-wrap of a wire payload — the transport envelope every message
// in this app travels in (see internal plan 2026-08-10-wire-identity-pairing,
// Task 4). Ported from charter's `wire/giftwrap.ts`
// with one deliberate difference: charter's inner is guardian-signed in both
// directions (the device has no real key of its own). Here BOTH the guardian
// and every child device hold real Nostr keypairs, so the inner is signed by
// whichever side is sending — guardian -> child and child -> guardian both
// produce a fully-signed NIP-01 inner event.
//
//   inner  (innerKind) = a FULLY-SIGNED NIP-01 event, authored by the sender
//   seal   13          = sender-authored, nip44(inner) -> the recipient
//   wrap   1059        = ephemeral-authored, nip44(seal) -> the recipient,
//                         p-tagged and MARKER_TAG-tagged for relay filtering
//
// The recipient re-derives the inner id, verifies the inner schnorr
// signature, and binds the inner author to the SEAL author (`inner.pubkey ===
// seal.pubkey`) before trusting anything — without that bind, any past
// recipient of a genuine signed inner could re-seal it under their OWN key
// and hand it to a third party as if the original sender sent it just now
// (verifyEvent alone can't catch this: the inner signature is still valid,
// it's just being replayed by the wrong sealer). When the caller already has
// a pinned peer, `expectedAuthorPk` additionally checks that bound author
// against the pin. `unwrapFrom` is TOTAL: any decrypt, parse, shape, or
// signature failure yields `null`, never a throw.
//
// Per NIP-59 convention, the seal and wrap timestamps are each independently
// backdated by a random amount up to two days (`MAX_WRAP_JITTER_SECS`, as
// charter's Rust transport does) so a relay observer can't correlate
// `created_at` with the real send time; charter's TS layer does not itself
// jitter (it relies on the Rust side), so this is NIP-59 convention, not
// charter-TS parity. The inner event keeps the real `nowSec` — callers need
// its true timestamp for ordering. Receive-side freshness/replay windows are
// deliberately NOT enforced here; that's the sync layer's job (event-id
// dedupe + acceptance window), not the envelope's.

import {
  finalizeEvent,
  generateSecretKey,
  verifyEvent,
  type EventTemplate,
  type NostrEvent,
} from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { MARKER_TAG, SEAL, WRAP } from './kinds'

/** NIP-59 backdating bound, seconds (two days) — mirrors charter's `MAX_WRAP_JITTER_SECS`. */
export const MAX_WRAP_JITTER_SECS = 2 * 24 * 60 * 60

/** A `created_at` for the seal/wrap layers: `nowSec` minus a random amount up
 *  to {@link MAX_WRAP_JITTER_SECS} (never in the future — NIP-59 only backdates). */
function jitteredCreatedAt(nowSec: number): number {
  // From the CSPRNG, not `Math.random`: the jitter is what hides
  // when a wrap was really sent, so it should not be predictable.
  const [r] = crypto.getRandomValues(new Uint32Array(1))
  return nowSec - ((r ?? 0) % MAX_WRAP_JITTER_SECS)
}

export interface WrapForOpts {
  innerKind: number
  payload: unknown
  /** The sender's own secret key — both directions sign with a real key here. */
  authorSk: Uint8Array
  recipientPk: string
  nowSec: number
}

/** Build inner -> seal -> wrap for `payload`, addressed to `recipientPk`. */
export function wrapFor(opts: WrapForOpts): NostrEvent {
  const { innerKind, payload, authorSk, recipientPk, nowSec } = opts

  // 1) Inner — fully signed by the sender (the load-bearing signature).
  const innerTemplate: EventTemplate = {
    kind: innerKind,
    created_at: nowSec,
    tags: [[...MARKER_TAG]],
    content: JSON.stringify(payload),
  }
  const inner = finalizeEvent(innerTemplate, authorSk)

  // 2) Seal (13) — sender-authored, nip44(inner) -> recipient.
  const sealTemplate: EventTemplate = {
    kind: SEAL,
    created_at: jitteredCreatedAt(nowSec),
    tags: [],
    content: nip44.encrypt(
      JSON.stringify(inner),
      nip44.getConversationKey(authorSk, recipientPk),
    ),
  }
  const seal = finalizeEvent(sealTemplate, authorSk)

  // 3) Wrap (1059) — ephemeral-authored, nip44(seal) -> recipient, p-tagged.
  const ephemeralSk = generateSecretKey()
  const wrapTemplate: EventTemplate = {
    kind: WRAP,
    created_at: jitteredCreatedAt(nowSec),
    tags: [['p', recipientPk], [...MARKER_TAG]],
    content: nip44.encrypt(
      JSON.stringify(seal),
      nip44.getConversationKey(ephemeralSk, recipientPk),
    ),
  }
  return finalizeEvent(wrapTemplate, ephemeralSk)
}

export interface UnwrapFromOpts {
  wrap: NostrEvent
  recipientSk: Uint8Array
  /** If given, the unwrap only succeeds when the inner author matches. */
  expectedAuthorPk?: string
}

/**
 * The one thing this module needs from a remote signer (NIP-46 / My Signet):
 * NIP-44 decryption on behalf of a key we do not hold. Async, because the
 * answer comes back over a relay.
 */
export interface Nip44Decrypter {
  /** `peerPubkey` is the other side of the conversation key — the wrap's
   *  ephemeral author for the outer layer, the seal's author for the inner. */
  decrypt(peerPubkey: string, ciphertext: string): Promise<string>
}

export interface UnwrapWithSignerOpts {
  wrap: NostrEvent
  signer: Nip44Decrypter
  /** If given, the unwrap only succeeds when the inner author matches. */
  expectedAuthorPk?: string
}

export interface Unwrapped {
  innerKind: number
  payload: unknown
  authorPk: string
  innerCreatedAt: number
  /** The RAW signed inner event, exactly as its author signed it (v0.2 spec
   *  §1.6/§2.3). Kept so the receiver can store it verbatim in
   *  `AppState.innerEvents` and later hand it on to another device, which
   *  re-verifies the signature for itself rather than trusting our word for
   *  it. Additive — existing callers ignore it. */
  inner: NostrEvent
}

function isNostrEventShape(x: unknown): x is NostrEvent {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.pubkey === 'string' &&
    typeof e.created_at === 'number' &&
    typeof e.kind === 'number' &&
    Array.isArray(e.tags) &&
    typeof e.content === 'string' &&
    typeof e.sig === 'string'
  )
}

/**
 * Reverse of {@link wrapFor} — decrypt wrap -> seal -> inner with the
 * recipient's key, verify the inner signature, and (if `expectedAuthorPk` is
 * given) check the inner author against it. TOTAL: any decrypt/parse/shape/
 * signature failure returns `null`, never throws. Stateless — safe to call
 * more than once on the same wrap.
 */
export function unwrapFrom(opts: UnwrapFromOpts): Unwrapped | null {
  const { wrap, recipientSk, expectedAuthorPk } = opts
  try {
    const sealJson = nip44.decrypt(
      wrap.content,
      nip44.getConversationKey(recipientSk, wrap.pubkey),
    )
    const seal: unknown = JSON.parse(sealJson)
    if (!isNostrEventShape(seal)) return null

    if (seal.kind !== SEAL) return null

    const innerJson = nip44.decrypt(
      seal.content,
      nip44.getConversationKey(recipientSk, seal.pubkey),
    )
    const inner: unknown = JSON.parse(innerJson)
    if (!isNostrEventShape(inner)) return null

    if (!verifyEvent(inner)) return null
    // Bind the inner author to whoever actually sealed it — otherwise any
    // past recipient of a genuine signed inner could re-seal it under their
    // own key and deliver it onward as if the original author sent it now.
    if (inner.pubkey !== seal.pubkey) return null
    if (expectedAuthorPk !== undefined && inner.pubkey !== expectedAuthorPk) return null

    const payload: unknown = JSON.parse(inner.content)
    return {
      innerKind: inner.kind,
      payload,
      authorPk: inner.pubkey,
      innerCreatedAt: inner.created_at,
      inner,
    }
  } catch {
    return null
  }
}

/**
 * Async mirror of {@link unwrapFrom} for a recipient whose secret key this
 * device does not hold — the family's My Signet identity, which decrypts
 * through a NIP-46 signer (v0.2 spec §1.6, the vault recovery path).
 *
 * Every check is `unwrapFrom`'s, in `unwrapFrom`'s order, including the
 * `inner.pubkey === seal.pubkey` re-seal bind: this path is fed by whatever a
 * relay hands back for `{kinds:[1059], '#p':[signetPk]}`, i.e. by anyone at
 * all, so it is if anything MORE exposed than the pinned-peer path.
 *
 * TOTAL: a rejected decrypt promise, a parse failure, a shape failure or a
 * bad signature all resolve to `null`. The whole body is inside one
 * try/catch, so a signer that rejects can never surface as an unhandled
 * rejection in a screen.
 */
export async function unwrapWithSigner(opts: UnwrapWithSignerOpts): Promise<Unwrapped | null> {
  const { wrap, signer, expectedAuthorPk } = opts
  try {
    const sealJson = await signer.decrypt(wrap.pubkey, wrap.content)
    const seal: unknown = JSON.parse(sealJson)
    if (!isNostrEventShape(seal)) return null

    if (seal.kind !== SEAL) return null

    const innerJson = await signer.decrypt(seal.pubkey, seal.content)
    const inner: unknown = JSON.parse(innerJson)
    if (!isNostrEventShape(inner)) return null

    if (!verifyEvent(inner)) return null
    // The re-seal bind — see unwrapFrom.
    if (inner.pubkey !== seal.pubkey) return null
    if (expectedAuthorPk !== undefined && inner.pubkey !== expectedAuthorPk) return null

    const payload: unknown = JSON.parse(inner.content)
    return {
      innerKind: inner.kind,
      payload,
      authorPk: inner.pubkey,
      innerCreatedAt: inner.created_at,
      inner,
    }
  } catch {
    return null
  }
}
