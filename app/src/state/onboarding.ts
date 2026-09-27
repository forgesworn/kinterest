// The onboarding state machine: the three ways an AppState acquires an
// identity. See internal plan 2026-08-10-wire-identity-pairing,
// Task 8, and this task's brief.
//
// Deliberately thin, like sync/engine.ts: vault storage of secrets (the
// mnemonic, under name 'family-mnemonic'; the guardian's or a paired
// child's own sk) is the CALLER's job (Plans 3-4's onboarding UI). Every
// function here is a pure state transition — it returns whatever secret key
// material the caller needs to go and store, but never stores anything
// itself, and never writes a secret key into AppState (which is plain JSON
// persisted via state/persist.ts, not the vault).

import { getPublicKey } from 'nostr-tools/pure'
import { deriveDependantKey, guardianFromMnemonic, validateMnemonic } from '../identity/derive'
import { acceptPairOffer } from '../pairing/pairing'
import type { PairOfferPayload } from '../wire/payloads'
import { applySnapshot } from '../sync/ingress'
import type { AppState, ChildProfile } from './types'

export interface StartAsGuardianResult {
  state: AppState
  guardianSk: Uint8Array
}

/**
 * Starts a fresh family as its guardian. `mnemonic` comes from
 * `generateMnemonic()` for a new family or a user-supplied import for a
 * restore; the guardian's signing keypair is derived from it via
 * `guardianFromMnemonic` — never a raw `generateSecretKey()` (the mnemonic
 * is the suite's single family backup; see identity/derive.ts). Returns the
 * derived sk for the caller to store in the vault alongside the mnemonic
 * itself — this function does not touch the vault.
 *
 * Total with respect to `mnemonic`: Plan 3's restore flow feeds this a
 * user-typed import, which is exactly the kind of input this suite's other
 * boundaries fail closed on rather than trust. `validateMnemonic` is
 * checked first; a bad mnemonic (wrong word count, checksum failure, words
 * outside the wordlist) returns `null` instead of letting
 * `guardianFromMnemonic`/nsec-tree throw uncaught.
 */
export function startAsGuardian(state: AppState, mnemonic: string): StartAsGuardianResult | null {
  if (!validateMnemonic(mnemonic)) return null
  const { sk, pk } = guardianFromMnemonic(mnemonic)
  const next: AppState = {
    ...state,
    role: 'guardian',
    guardianPubkey: pk,
    self: { pubkey: pk, childIndex: null },
  }
  return { state: next, guardianSk: sk }
}

/**
 * Completes pairing on a child device from a received `PAIR_OFFER`.
 * `sealAuthorPk` must be the AUTHENTICATED author of the seal that carried
 * the offer (wire/giftwrap.ts's `unwrapFrom` return value), never anything
 * read out of the offer payload — `acceptPairOffer` (pairing.ts) is what
 * enforces this pin; it is the guardian identity, since the offer itself
 * carries no guardian pubkey field at all. On success: role='child', the
 * guardian is pinned, this device's own identity fields are set, the
 * offer's relay list replaces `state.relays`, and the offer's snapshot is
 * folded in with the same merge semantics `sync/ingress.ts` uses for a live
 * SNAPSHOT (append-dedupe entries, anti-rollback LWW docs, additive-union
 * children) — so accepting an offer twice, or one already superseded by
 * live sync traffic, is always a safe no-op rather than a rollback.
 *
 * Total: a malformed offer (bad `childSkHex`) or an empty `sealAuthorPk`
 * -> `null`, never a throw. Does not return the child's sk: the caller
 * already has it (this is the same `offer.childSkHex` it presumably
 * unwrapped to get here), or can re-derive it via `acceptPairOffer`
 * directly if it needs it for vault storage.
 *
 * `nowSec` is threaded straight into `applySnapshot`'s issuedAt clamp (the
 * same `MAX_ISSUED_AT_SKEW_SECS` window `sync/ingress.ts#handleWrap` applies
 * to a live CONFIG/SNAPSHOT) — this closes the Plan 2 residual where the
 * very first snapshot a child ever accepts was clamped against `Infinity`
 * instead of the receiving device's real clock, letting a doc with a
 * far-future `issuedAt` poison `docHighWater` permanently before the child
 * had even finished pairing.
 */
export interface StartedAsChild {
  state: AppState
  /** The offer carried a family root that would not verify against the
   *  guardian this device actually paired with (v0.2 spec §1.5). Pairing
   *  succeeded regardless; the caller surfaces a notify. */
  rootRejected: boolean
}

export function startAsChildFromOffer(
  state: AppState,
  offer: PairOfferPayload,
  sealAuthorPk: string,
  nowSec: number,
): StartedAsChild | null {
  const accepted = acceptPairOffer(offer, sealAuthorPk)
  if (accepted === null) return null

  const childPk = getPublicKey(accepted.childSk)

  let next: AppState = {
    ...state,
    role: 'child',
    guardianPubkey: accepted.guardianPk,
    self: { pubkey: childPk, childIndex: accepted.childIndex },
    relays: accepted.relays.length > 0 ? [...accepted.relays] : state.relays,
    // Only a VERIFIED root is kept (acceptPairOffer's check against the
    // authenticated seal author); an unverifiable one leaves the existing
    // record exactly as it was rather than half-setting it.
    ...(accepted.root !== undefined ? { root: accepted.root } : {}),
  }
  next = applySnapshot(next, accepted.snapshot, nowSec)

  return { state: next, rootRejected: accepted.rootRejected }
}

export interface AddChildResult {
  state: AppState
  child: ChildProfile
}

/** The next unused dependant derivation index — strictly greater than every
 *  index already present, so a child list seeded out of order (e.g. merged
 *  in from a snapshot) never causes a later `addChild` to collide with an
 *  existing index. */
function nextFreeChildIndex(children: ChildProfile[]): number {
  let max = -1
  for (const c of children) if (c.index > max) max = c.index
  return max + 1
}

/**
 * Guardian-side: registers a new child. Derives the child's keypair from
 * `mnemonic` at the next free dependant index via `deriveDependantKey` —
 * purely to compute the public key for the new `ChildProfile`; the derived
 * secret key is used and discarded here, never stored on the guardian
 * device outside the vault (a paired child device re-derives its own sk
 * from the same mnemonic at claim time, via `pairing.ts#answerPairClaim`).
 */
export function addChild(state: AppState, mnemonic: string, name: string): AddChildResult {
  const index = nextFreeChildIndex(state.children)
  const { pk } = deriveDependantKey(mnemonic, index)
  const child: ChildProfile = { pubkey: pk, name, index }
  const next: AppState = { ...state, children: [...state.children, child] }
  return { state: next, child }
}
