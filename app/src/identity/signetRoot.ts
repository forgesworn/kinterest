// The family's My Signet root, verified (v0.2 spec §1.3).
//
// PURE: no DOM, no I/O, no clock, and — load-bearing — nothing from
// `signet-login`. This module is what the child device, the pairing code and
// the settings screen all reach for, and none of them can afford to drag a
// browser-only package into scope. The one thing that comes out of
// `signet-login` is the auth event itself, which is plain JSON.
//
// We deliberately do NOT use `signet-login/verify`'s `verifyLogin` here: it
// enforces an `expectedOrigin` and a 300-second freshness window, neither of
// which a long-lived attestation verified on someone else's device can meet.
// See `verifyRootAttestation`'s comment for the full reasoning.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from 'nostr-tools/utils'
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure'

/** Domain separator. Name-free (`kin-jar`), versioned. */
export const ROOT_CHALLENGE_PREFIX = 'kin-jar-root:v1:'

/** The Signet auth event kind (spec §1.1). */
const KIND_SIGNET_AUTH = 21236

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

/**
 * The 64-lowercase-hex challenge that binds a Signet login to THIS family's
 * guardian device key. Pure and deterministic.
 *
 * Throws on a non-64-hex `guardianPk`: that is programmer error, not untrusted
 * input — every caller derives it from a real keypair — and `signet-login`
 * itself throws `challenge-must-be-64-hex` on a malformed challenge, so
 * failing here gives a far more legible stack than failing inside the picker.
 * `verifyRootAttestation`, which DOES take untrusted input, catches it.
 */
export function rootChallenge(guardianPk: string): string {
  const pk = guardianPk.toLowerCase()
  if (!HEX64.test(pk)) throw new Error('rootChallenge: guardianPk must be 64 hex')
  return bytesToHex(sha256(new TextEncoder().encode(ROOT_CHALLENGE_PREFIX + pk)))
}

/**
 * Total. True iff `authEvent` is a valid kind-21236 Signet auth event signed
 * by `expectedSignetPk` and carrying `rootChallenge(guardianPk)` in its
 * `challenge` tag. Never throws, for any input at all — it is fed straight
 * from a wire payload on the child's side.
 *
 * Checks, in order, failing closed at each step (spec §1.3):
 *   1. structural — plain object, 64-hex `id`/`pubkey`, 128-hex `sig`, safe
 *      integer `created_at`, array `tags`, string `content`
 *   2. `kind === 21236`
 *   3. `verifyEvent` — recomputes the NIP-01 id and checks the schnorr sig
 *   4. author is `expectedSignetPk`
 *   5. a `['challenge', c]` tag matching `rootChallenge(guardianPk)`
 *
 * DELIBERATELY NOT CHECKED:
 *
 * - **The `origin` tag.** This runs on a CHILD device, which has no idea what
 *   origin the guardian signed from (`https://app.kinjar.local` in the Android
 *   shell, `http://localhost:5173` in dev, a PWA origin later). Checking it
 *   would break pairing across environments, and it buys nothing: the
 *   challenge already binds the attestation to this specific guardian key, so
 *   the same attestation replayed from another origin proves the same fact.
 *   Nor would it defend anything (review R3, reverting audit P5's
 *   allowlist): the requesting site writes the `origin` tag itself and the
 *   signer signs it as given, so a phishing site can simply write ours. A
 *   phished attestation over an attacker's guardian key is instead surfaced
 *   at recovery time — see signetVault.ts's 'conflicting-vaults' outcome.
 * - **Freshness.** The attestation is a long-lived record of "this Signet
 *   identity claimed this guardian device". A 300-second window would make it
 *   unverifiable one minute after the login that produced it.
 *
 * The `guardianPk` argument must always be an AUTHENTICATED key — the seal
 * author of the wrap that carried the offer, never anything read out of the
 * payload. That is what stops a stolen attestation (bound to the real
 * family's guardianPk) from passing check 5 on an impersonator's device.
 */
export function verifyRootAttestation(authEvent: unknown, expectedSignetPk: string, guardianPk: string): boolean {
  try {
    if (typeof authEvent !== 'object' || authEvent === null || Array.isArray(authEvent)) return false
    const ev = authEvent as Record<string, unknown>
    if (typeof ev.id !== 'string' || !HEX64.test(ev.id)) return false
    if (typeof ev.pubkey !== 'string' || !HEX64.test(ev.pubkey)) return false
    if (typeof ev.sig !== 'string' || !HEX128.test(ev.sig)) return false
    if (!Number.isSafeInteger(ev.created_at)) return false
    if (!Array.isArray(ev.tags)) return false
    if (typeof ev.content !== 'string') return false
    if (ev.kind !== KIND_SIGNET_AUTH) return false

    // Verified on a plain COPY, never the caller's object: `verifyEvent`
    // stamps a `Symbol(verified)` cache onto whatever it is handed, and this
    // is routinely called on `AppState.root.authEvent` — a persisted value
    // that must keep comparing equal to itself across a JSON round trip.
    const candidate: NostrEvent = {
      id: ev.id,
      pubkey: ev.pubkey,
      created_at: ev.created_at as number,
      kind: ev.kind,
      tags: ev.tags as string[][],
      content: ev.content,
      sig: ev.sig,
    }
    if (!verifyEvent(candidate)) return false

    if (ev.pubkey.toLowerCase() !== expectedSignetPk.toLowerCase()) return false

    const want = rootChallenge(guardianPk)
    return candidate.tags.some(
      (t) => Array.isArray(t) && t[0] === 'challenge' && typeof t[1] === 'string' && t[1].toLowerCase() === want,
    )
  } catch {
    return false
  }
}
