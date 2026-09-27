// One-time pairing tokens — port of charter's `store/pairTokens.ts` semantics
// (the sibling app's pairing-token store),
// tightened per this plan's explicit security rules (Task 6 / Global
// Constraints): 32 lowercase hex chars, constant-time compare, single-use,
// 600s TTL, and a contested (replayed) presentation must resolve to nobody.
//
// Unlike charter's version — which keeps a durable Set of every live token
// and checks membership — this module is a pure, storage-agnostic pair of
// functions. `mintToken` hands back the token plus its mint time; the caller
// (guardian-side state) is responsible for storing it and, on a *successful*
// `consumeToken`, removing it. That removal is what makes a second
// presentation "contested" and produces the required nobody-wins outcome: a
// replay hands `consumeToken` a `stored` that is no longer there (`null`/
// `undefined`), which fails closed like any other absent token. Keeping the
// storage decision out of this module is deliberate — it mirrors tokens.ts's
// sibling `sas.ts` and `pairing.ts`, which are similarly pure, so the whole
// pairing slice stays testable without a fake localStorage anywhere in this
// file.

import { bytesToHex } from 'nostr-tools/utils'

/** How long a minted token stays claimable — the plan's fixed 600s TTL. */
export const TOKEN_TTL_SECS = 600

/** 128 bits of CSPRNG -> 32 lowercase hex chars. */
const TOKEN_BYTES = 16

export interface MintedToken {
  /** 32 lowercase hex chars. */
  token: string
  mintedAt: number
}

/** Mints a fresh one-time pairing token: 16 CSPRNG bytes, lowercase hex. */
export function mintToken(nowSec: number): MintedToken {
  const bytes = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return { token: bytesToHex(bytes), mintedAt: nowSec }
}

/**
 * Constant-time string compare. Ordinary `===` on secrets leaks a timing
 * signal proportional to the length of the matching prefix; this instead
 * walks every character of both strings unconditionally (no early return)
 * and folds length equality into the same accumulator, so neither "how many
 * leading chars matched" nor "was the length even right" is observable via
 * timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const ca = i < a.length ? a.charCodeAt(i) : 0
    const cb = i < b.length ? b.charCodeAt(i) : 0
    diff |= ca ^ cb
  }
  return diff === 0
}

/**
 * Checks `presented` against the caller's `stored` token: constant-time
 * compare, 600s TTL from `stored.mintedAt`. Does NOT mutate anything —
 * single-use is enforced by the caller removing `stored` from its own state
 * the moment this returns `true` (see this file's header comment); a token
 * presented twice is therefore "contested" simply because the second call
 * necessarily passes a `stored` that is already gone, which fails closed
 * (`false`) like any other absent/expired token — nobody is pinned by a
 * contested token, matching the plan's rule exactly.
 */
export function consumeToken(stored: MintedToken | null | undefined, presented: string, nowSec: number): boolean {
  if (stored === null || stored === undefined) return false
  if (typeof presented !== 'string') return false
  if (nowSec - stored.mintedAt > TOKEN_TTL_SECS) return false
  return timingSafeEqual(stored.token, presented)
}
