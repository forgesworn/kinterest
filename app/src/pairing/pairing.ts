// QR content and the claim/offer handshake that pairs a child device to a
// guardian. See internal plan 2026-08-10-wire-identity-pairing,
// Task 6, and this task's brief for the exact interfaces.
//
// THE key security rule this file enforces (Global Constraints: "never pin a
// pubkey read out of a payload — pin the authenticated seal author"):
// `pair.claim`'s `params.devicePk` is whatever the claiming device *says* its
// key is, self-reported inside a payload the guardian has not yet
// authenticated any relationship with. `sealAuthorPk` is the pubkey that
// actually signed the inner event the guardian just unwrapped — verified by
// `wire/giftwrap.ts#unwrapFrom` via a real schnorr signature check. Those two
// values agreeing is not a formality to log and move past; it IS the
// authentication. `answerPairClaim` addresses its offer to `sealAuthorPk`
// and refuses (`null`) the moment they disagree, precisely so a forwarded or
// forged claim — one where the payload's self-reported key doesn't match
// whoever really signed it — can never trick the guardian into handing a
// derived child key to the wrong device.
//
// Token verification (single-use + 600s TTL, see ./tokens.ts) is
// deliberately NOT folded into `answerPairClaim`: that stays the guardian
// ingress layer's job (Task 7), calling `consumeToken` as a gate before ever
// reaching this file. Keeping the concerns apart means a token replay is
// rejected before a `pair.claim` is even looked at, and this file's own
// logic is exactly the identity-binding check above and nothing else.

import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { newId } from '../domain/id'
import { deriveDependantKey } from '../identity/derive'
import { verifyRootAttestation } from '../identity/signetRoot'
import {
  buildPairOfferPayload,
  buildRequestPayload,
  type PairOfferPayload,
  type RequestPayload,
  type RootAttestation,
  type SnapshotPayload,
} from '../wire/payloads'
import type { RootRecord } from '../state/types'

// --- QR content --------------------------------------------------------------

/** Scheme prefix — name-free by design (Global Constraints:
 *  "the pairing QR scheme is `kin-jar-pair:`"). */
const QR_PREFIX = 'kin-jar-pair:v1?'

const HEX64 = /^[0-9a-f]{64}$/

export interface PairQrOpts {
  guardianPk: string
  relays: string[]
  token: string
}

export interface PairQrContent {
  guardianPk: string
  relays: string[]
  token: string
}

/** Builds the guardian's QR/link content: `g=<pubkey>` once, `r=<relay>`
 *  repeated once per relay (URL-encoded), `t=<token>` once. */
export function qrContent(opts: PairQrOpts): string {
  const parts = [
    `g=${opts.guardianPk}`,
    ...opts.relays.map((r) => `r=${encodeURIComponent(r)}`),
    `t=${opts.token}`,
  ]
  return `${QR_PREFIX}${parts.join('&')}`
}

/** Total: any malformed/garbage input (wrong scheme, missing fields, a
 *  guardianPk that isn't 64 lowercase hex chars, zero relays) -> `null`,
 *  never a throw. */
export function parsePairQr(s: string): PairQrContent | null {
  if (typeof s !== 'string' || !s.startsWith(QR_PREFIX)) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(s.slice(QR_PREFIX.length))
  } catch {
    return null
  }
  const guardianPk = params.get('g')
  const token = params.get('t')
  const relays = params.getAll('r')
  if (guardianPk === null || !HEX64.test(guardianPk)) return null
  if (token === null || token.length === 0) return null
  if (relays.length === 0) return null
  return { guardianPk, relays, token }
}

// --- Child side: build the claim ----------------------------------------------

export interface BuildPairClaimOpts {
  devicePk: string
  token: string
  name?: string
  nowSec: number
}

/** The child device's `pair.claim` REQUEST — fresh reqId/nonce every call.
 *  `child` is set to `devicePk`: at claim time no guardian-assigned identity
 *  exists yet, so the claiming device's own key is the only identifier it
 *  has to offer. */
export function buildPairClaim(opts: BuildPairClaimOpts): RequestPayload {
  const reqId = newId(Math.floor(opts.nowSec * 1000))
  const nonceBytes = new Uint8Array(16)
  crypto.getRandomValues(nonceBytes)
  const nonce = bytesToHex(nonceBytes)
  const params: Record<string, unknown> = { token: opts.token, devicePk: opts.devicePk }
  if (opts.name !== undefined) params.name = opts.name
  return buildRequestPayload({
    op: 'pair.claim',
    reqId,
    nonce,
    child: opts.devicePk,
    ts: opts.nowSec,
    params,
  })
}

// --- Guardian side: answer the claim -------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export interface AnswerPairClaimOpts {
  claim: RequestPayload
  /** The AUTHENTICATED author of the seal that carried `claim` — i.e. the
   *  value `wire/giftwrap.ts#unwrapFrom` returned as `authorPk`, never
   *  anything read out of `claim.params` itself. */
  sealAuthorPk: string
  /** The guardian's family mnemonic — deriving a dependant's key needs the
   *  mnemonic root (see identity/derive.ts#deriveDependantKey), not merely
   *  the guardian's own signing key. */
  mnemonic: string
  childIndex: number
  childName: string
  snapshot: SnapshotPayload
  relays: string[]
  /** The family's My Signet root, if it has one (v0.2 spec §1.5) — a
   *  decoration on the offer, never a condition of it. */
  root?: RootAttestation
}

export interface AnsweredPairClaim {
  offer: PairOfferPayload
  /** Always `sealAuthorPk` — see this file's header comment. */
  recipientPk: string
}

/**
 * Builds the guardian's `PAIR_OFFER` in response to a `pair.claim`. THE
 * check: `claim.params.devicePk` (self-reported) must equal `sealAuthorPk`
 * (authenticated) — any disagreement, including a missing/malformed
 * `devicePk`, returns `null`. On success, the offer is addressed to
 * `sealAuthorPk`, never to the payload's own claim about itself.
 */
export function answerPairClaim(opts: AnswerPairClaimOpts): AnsweredPairClaim | null {
  const { claim, sealAuthorPk, mnemonic, childIndex, childName, snapshot, relays } = opts
  if (claim.op !== 'pair.claim') return null
  if (typeof sealAuthorPk !== 'string' || sealAuthorPk.length === 0) return null
  const params = claim.params
  if (!isPlainObject(params)) return null
  const devicePk = params.devicePk
  if (typeof devicePk !== 'string' || devicePk.length === 0) return null
  // THE check — see header comment. A disagreement here means the claim is
  // lying about who it's from (or was forwarded/replayed by someone else);
  // reject outright rather than trusting either value.
  if (devicePk !== sealAuthorPk) return null

  const { sk: childSk } = deriveDependantKey(mnemonic, childIndex)
  const childSkHex = bytesToHex(childSk)
  // The raw bytes are not needed past this point. The hex string
  // cannot be wiped — JS strings are immutable — but the offer must carry it.
  childSk.fill(0)
  const offer = buildPairOfferPayload({
    childSkHex,
    childIndex,
    name: childName,
    relays,
    snapshot,
    ...(opts.root !== undefined ? { root: opts.root } : {}),
  })
  return { offer, recipientPk: sealAuthorPk }
}

// --- Child side: accept the offer ----------------------------------------------

export interface AcceptedPairOffer {
  /** Pinned as the guardian — always the authenticated seal author, never
   *  anything read out of the offer payload (the offer carries no guardian
   *  pubkey field at all; the transport's authenticated author IS the
   *  guardian identity). */
  guardianPk: string
  childSk: Uint8Array
  childIndex: number
  name: string
  relays: string[]
  snapshot: SnapshotPayload
  /** Set ONLY when the offer carried a root that verified against
   *  `sealAuthorPk`. Always built with `backedUpAt: null` — a child never
   *  backs anything up (v0.2 spec §1.5). */
  root?: Extract<RootRecord, { kind: 'signet' }>
  /** True when a root was present but did not verify — the caller surfaces a
   *  notify. Pairing itself is never blocked by it. */
  rootRejected: boolean
}

/**
 * Total: pins `sealAuthorPk` as the guardian and decodes the offer's child
 * key. A malformed `childSkHex` (wrong length/not hex) -> `null` rather than
 * a throw.
 *
 * The family root (v0.2 spec §1.5) is verified against `sealAuthorPk` — the
 * AUTHENTICATED guardian device key this child actually paired with, never
 * anything read out of the payload. That is the whole security property: an
 * impersonator can copy the real family's attestation, but it is bound by
 * challenge to the REAL guardian key, so it fails here on the impersonator's
 * own offer.
 *
 * A root that does not verify sets `rootRejected` and is dropped; the pairing
 * still succeeds. An unverifiable decoration must never cost a family its
 * ability to pair a phone.
 */
export function acceptPairOffer(offer: PairOfferPayload, sealAuthorPk: string): AcceptedPairOffer | null {
  if (typeof sealAuthorPk !== 'string' || sealAuthorPk.length === 0) return null
  if (!isPlainObject(offer) || offer.v !== 1) return null
  let childSk: Uint8Array
  try {
    childSk = hexToBytes(offer.childSkHex)
  } catch {
    return null
  }
  if (childSk.length !== 32) return null

  const claimedRoot = offer.root
  const rootOk = claimedRoot !== undefined && verifyRootAttestation(claimedRoot.authEvent, claimedRoot.pubkey, sealAuthorPk)

  return {
    guardianPk: sealAuthorPk,
    childSk,
    childIndex: offer.childIndex,
    name: offer.name,
    relays: offer.relays,
    snapshot: offer.snapshot,
    ...(rootOk && claimedRoot !== undefined
      ? {
          root: {
            kind: 'signet' as const,
            pubkey: claimedRoot.pubkey,
            authEvent: claimedRoot.authEvent,
            backedUpAt: null,
          },
        }
      : {}),
    rootRejected: claimedRoot !== undefined && !rootOk,
  }
}
