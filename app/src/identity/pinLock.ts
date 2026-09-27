// PIN-at-rest protection for a paired child device's own signing key. Ports
// keystore-kit's PIN pattern
// (its README's "PIN" row —
// PBKDF2-SHA-256 600,000 iterations -> AES-256-GCM, non-extractable derived
// keys) MINIMALLY: this file re-implements just that one primitive directly
// against Web Crypto rather than adding keystore-kit as a dependency, per
// this task's "port the minimal pattern... no new heavy deps" instruction —
// keystore-kit itself is zero-dep, but its biometric/grace machinery is
// dead weight this app never uses.
//
// THE MODEL (rewritten after a security review found the first version
// didn't actually gate the key — see
// .superpowers/sdd/2026-08-11-child-mode/progress.md's Task 2 fix note for
// the full incident):
//   - DURABLE = the PIN-wrapped blob (`CHILD_PIN_WRAP_NAME`) ONLY. This is
//     the one thing on disk that survives the device being locked, and it is
//     genuinely gated by the PIN — nothing else in this module, or anywhere
//     else in the app, persists the raw child sk anywhere.
//   - SESSION = memory only. Once `unlockWithPin` recovers `sk`, custody of
//     it belongs entirely to store.tsx's React state (`childSk`, exactly
//     like `guardianSk`) — this module returns it and forgets it
//     immediately; it is NEVER written to `identity/vault.ts` (IndexedDB),
//     `localStorage`, or `sessionStorage`.
//   - Consequence: EVERY fresh mount of the app — a reload, a restored
//     background tab, a brand new tab, script running via a devtools
//     console — finds `childSk` null and lands on ChildLock, which demands
//     the PIN again. There is no forgeable "already unlocked" flag anywhere
//     for an attacker (or an ordinary mobile tab-restore) to ride in on.
//
// The FIRST version of this module got this wrong: `setPin`/`unlockWithPin`
// both wrote the raw `sk` into `identity/vault.ts`'s existing `CHILD_SK_NAME`
// slot "for the session", gated only by a `sessionStorage` flag that
// store.tsx checked before trusting it. That flag is trivially forgeable
// (anyone with console access on the page can set it) and, more
// fundamentally, `CHILD_SK_NAME`'s vault wrap is device-bound, not
// PIN-bound — `identity/vault.ts#vaultLoad` needs no passphrase at all, so
// the moment ANYTHING durable held the plaintext sk under that name, the PIN
// had stopped gating it. `setPin` now actively deletes any `CHILD_SK_NAME`
// entry as migration hygiene (a device that ran the old code may still have
// one sitting in its vault) rather than ever writing one.
//
// PIN protects against exactly what keystore-kit's own README documents for
// its PIN method and no more: casual/opportunistic reads of the durable blob
// and tampering (the AES-GCM tag), NOT offline brute force of a short
// numeric PIN — 600,000 PBKDF2 iterations slow guessing but cannot make a
// 4-8 digit keyspace strong on their own. That is an accepted, documented
// trade-off for a shared family device's "big friendly number pad", the
// same one keystore-kit itself calls out.

import { vaultDelete, vaultLoad, vaultStore } from './vault'

/** The vault slot a PRE-FIX build of this module used as a plaintext
 *  session cache — see this module's header. Only ever DELETED from here
 *  now (migration hygiene in `setPin`), never written. Matches store.tsx's
 *  own former literal of the same name. */
const CHILD_SK_NAME = 'child-sk'

/** The durable, PIN-protected slot this module owns — see this module's
 *  header ("THE MODEL"). */
const CHILD_PIN_WRAP_NAME = 'child-pin-wrap'

/** OWASP 2023 recommendation — same figure keystore-kit's README documents. */
const PBKDF2_ITERATIONS = 600_000
const SALT_LENGTH = 16
const IV_LENGTH = 12

/** Sealed-blob prefix, so a stored value announces its own format — mirrors
 *  identity/vault.ts's own `SEAL_PREFIX` convention, distinct string so the
 *  two sealed formats can never be confused for one another. */
const SEAL_PREFIX = 'pin-v1'

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length)
  new Uint8Array(out).set(bytes)
  return out
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/** PBKDF2-SHA-256 (600,000 iterations) -> non-extractable AES-256-GCM
 *  `CryptoKey` — identical algorithm/iteration-count to keystore-kit's
 *  `deriveAesKey`. */
async function deriveAesKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** A "big friendly number pad" PIN, not a passphrase: 4-8 numeric digits.
 *  Exported so the onboarding screen and ChildLock both validate identically
 *  rather than each hand-rolling their own regex. Total — never throws on
 *  any input, including non-digit junk. */
export function isValidPinFormat(pin: string): boolean {
  return typeof pin === 'string' && /^[0-9]{4,8}$/.test(pin)
}

/** Has a PIN ever been configured on this device? */
export async function pinIsSet(): Promise<boolean> {
  return (await vaultLoad(CHILD_PIN_WRAP_NAME)) !== null
}

/**
 * Wraps `sk` under `pin` (PBKDF2 600k -> AES-256-GCM) into the durable slot
 * — the ONLY place `sk` is ever persisted (see this module's header). Also
 * deletes any `CHILD_SK_NAME` vault entry as migration hygiene, in case this
 * device previously ran the pre-fix build that wrote one. Rejects a
 * malformed `pin` (see `isValidPinFormat`) without sealing anything —
 * `false`, never a throw. The caller (ChildOnboarding.tsx) is responsible
 * for keeping `sk` in memory (via store.tsx's `unlockChildSk`) for the rest
 * of the CURRENT session — this function does not do that itself.
 */
export async function setPin(pin: string, sk: Uint8Array): Promise<boolean> {
  if (!isValidPinFormat(pin)) return false
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const key = await deriveAesKey(pin, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(iv) }, key, toBuffer(sk)))
  const blob = `${SEAL_PREFIX}:${toB64(salt)}:${toB64(iv)}:${toB64(ct)}`
  await vaultStore(CHILD_PIN_WRAP_NAME, new TextEncoder().encode(blob))
  await vaultDelete(CHILD_SK_NAME)
  return true
}

/**
 * Undoes `setPin` entirely (v0.2 spec §4.5): the durable PIN wrap, the
 * legacy plaintext slot a pre-fix build may have left behind, and the
 * persisted backoff state all go. Called when the guardian revokes this
 * device — leaving a PIN behind would mean a device that still demands a
 * PIN to unlock a key nothing will ever sync with again, and leaving a live
 * lockout behind would outlive the pairing that earned it.
 *
 * Idempotent, and never throws: it is called on a path (store.tsx's
 * `revoked` effect handler) where there is nothing sensible to do with a
 * failure, and a device half-cleared would be worse than one cleared
 * best-effort. `storage` exists only so a test can inject a fake, matching
 * every other storage seam in this file; production callers pass nothing
 * and get `localStorage` where one exists.
 */
export async function clearPin(storage?: StorageLike): Promise<void> {
  try {
    await vaultDelete(CHILD_PIN_WRAP_NAME)
  } catch {
    // best-effort, see this function's own doc comment
  }
  try {
    await vaultDelete(CHILD_SK_NAME)
  } catch {
    // best-effort
  }
  try {
    clearBackoffState(storage ?? defaultBackoffStorage())
  } catch {
    // best-effort
  }
}

/**
 * Recovers `sk` from `pin`, or `null` on any failure — no PIN ever set,
 * wrong PIN, or a corrupt/tampered blob all collapse to the SAME `null`,
 * deliberately: mirrors identity/vault.ts's own `vaultLoad` and keystore-kit
 * itself ("Tampering is detected, not silently accepted... turns that
 * failure into a null return... so callers can't tell 'wrong PIN' from
 * 'corrupted blob'"). Writes NOTHING durable on success or failure — see
 * this module's header; the caller is responsible for holding the returned
 * `sk` in memory only (store.tsx's `unlockChildSk`).
 */
export async function unlockWithPin(pin: string): Promise<Uint8Array | null> {
  const stored = await vaultLoad(CHILD_PIN_WRAP_NAME)
  if (stored === null) return null
  const text = new TextDecoder().decode(stored)
  const parts = text.split(':')
  if (parts.length !== 4 || parts[0] !== SEAL_PREFIX) return null
  try {
    const salt = fromB64(parts[1]!)
    const iv = fromB64(parts[2]!)
    const ct = fromB64(parts[3]!)
    const key = await deriveAesKey(pin, salt)
    const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(iv) }, key, toBuffer(ct)))
    return sk
  } catch {
    // Wrong PIN (GCM tag mismatch) or a tampered/corrupt blob — same `null`
    // either way, see this function's own doc comment.
    return null
  }
}

// --- 5-attempt soft backoff --------------------------------------------------
// The escalation table itself is pure — no timers, no storage, no wall clock
// of its own. `loadBackoffState`/`saveBackoffState`/`clearBackoffState` below
// are the one bit of I/O this module does: persisting the attempt count and
// lockout deadline to a caller-supplied `StorageLike` (localStorage in
// production — ChildLock.tsx) so a page reload can't reset a live lockout
// for free. Kept as an injectable seam (same convention as wire/outbox.ts's
// own `StorageLike`) rather than reaching for `window.localStorage`
// directly, so this module — including the backoff persistence — stays
// testable in vitest's `node` environment with a plain in-memory fake.

/** Minimal Storage surface — see wire/outbox.ts's own `StorageLike` for the
 *  full rationale (DOM-lib-independent, injectable for tests). Structurally
 *  identical (and structurally compatible with `window.localStorage`) but
 *  declared separately rather than imported, so this module stays free of
 *  any dependency on the wire layer for an unrelated concern. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const BACKOFF_STORAGE_KEY = 'kin-jar-child-backoff'

export interface BackoffState {
  consecutiveFailures: number
  lockedUntilSec: number
}

const ZERO_BACKOFF_STATE: BackoffState = { consecutiveFailures: 0, lockedUntilSec: 0 }

/** Reads the persisted backoff state, or the zero state if nothing is
 *  stored, or if what IS stored doesn't parse as one — total against a
 *  cleared/corrupted/hand-edited localStorage entry, never a throw. */
export function loadBackoffState(storage: StorageLike): BackoffState {
  const raw = storage.getItem(BACKOFF_STORAGE_KEY)
  if (raw === null) return ZERO_BACKOFF_STATE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return ZERO_BACKOFF_STATE
    const { consecutiveFailures, lockedUntilSec } = parsed as Record<string, unknown>
    if (typeof consecutiveFailures !== 'number' || !Number.isFinite(consecutiveFailures) || consecutiveFailures < 0)
      return ZERO_BACKOFF_STATE
    if (typeof lockedUntilSec !== 'number' || !Number.isFinite(lockedUntilSec) || lockedUntilSec < 0)
      return ZERO_BACKOFF_STATE
    return { consecutiveFailures: Math.trunc(consecutiveFailures), lockedUntilSec: Math.trunc(lockedUntilSec) }
  } catch {
    return ZERO_BACKOFF_STATE
  }
}

export function saveBackoffState(storage: StorageLike, state: BackoffState): void {
  storage.setItem(BACKOFF_STORAGE_KEY, JSON.stringify(state))
}

/** Clears the persisted backoff state — called after a successful unlock,
 *  so a lockout never outlives the failures that earned it. */
export function clearBackoffState(storage: StorageLike): void {
  storage.removeItem(BACKOFF_STORAGE_KEY)
}

/** The storage `clearPin` reaches for when a caller injects none. vitest
 *  runs in the 'node' environment, where `localStorage` does not exist at
 *  all, so this must be a guarded lookup with an inert fallback rather than
 *  a bare `window.localStorage` — same reasoning as
 *  `state/persist.ts#defaultStorage`. */
function defaultBackoffStorage(): StorageLike {
  const g = globalThis as { localStorage?: StorageLike }
  return (
    g.localStorage ?? {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }
  )
}

/** Seconds to wait before the NEXT attempt, indexed by consecutive failures
 *  so far (index 0 = no failures yet). Escalates gently at first — a
 *  fat-fingering child should not be locked out over one or two typos — then
 *  meaningfully slows a real guessing run, capping at the 5th-and-beyond
 *  failure rather than growing unbounded: a forgotten PIN must stay
 *  recoverable (re-pairing is always available), not an ever-lengthening
 *  lockout with no way out. */
const BACKOFF_SECS: readonly number[] = [0, 0, 5, 15, 30, 60]

/** Seconds a caller must wait before its next attempt is allowed, given
 *  `consecutiveFailures` wrong PINs in a row. Total against garbage input
 *  (NaN/negative/non-finite all read as "no wait"), clamped at the table's
 *  last entry for 5 or more failures. */
export function backoffSecs(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return 0
  const idx = Math.min(Math.trunc(consecutiveFailures), BACKOFF_SECS.length - 1)
  return BACKOFF_SECS[idx]!
}

/** The `lockedUntilSec` a caller should record right after a fresh failure,
 *  given `consecutiveFailures` (already incremented to include that
 *  failure) and the current clock. */
export function nextLockedUntil(consecutiveFailures: number, nowSec: number): number {
  return nowSec + backoffSecs(consecutiveFailures)
}

/** True once `nowSec` has reached a previously-recorded `lockedUntilSec` —
 *  total against garbage input (a non-finite `lockedUntilSec` reads as "not
 *  locked", never throws/hangs the caller). */
export function canAttempt(lockedUntilSec: number, nowSec: number): boolean {
  if (!Number.isFinite(lockedUntilSec)) return true
  return nowSec >= lockedUntilSec
}
