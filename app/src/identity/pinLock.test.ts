// vitest runs in the 'node' environment (see vite.config.ts) — fake-indexeddb
// installs a spec-compliant in-memory IndexedDB so vault.ts's real code
// paths (which this module sits on top of) run unmodified under test.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backoffSecs,
  canAttempt,
  clearBackoffState,
  clearPin,
  isValidPinFormat,
  loadBackoffState,
  nextLockedUntil,
  pinIsSet,
  saveBackoffState,
  setPin,
  unlockWithPin,
  type StorageLike,
} from './pinLock'
import { resetVaultCacheForTests, vaultLoad, vaultStore } from './vault'

const SK = new Uint8Array(32).fill(7)

/** In-memory `StorageLike` fake — mirrors wire/outbox.test.ts's own
 *  `makeFakeStorage`, kept local since pinLock.ts deliberately declares its
 *  own `StorageLike` rather than importing the wire layer's (see that
 *  module's doc comment). A fresh instance simulates a real page reload
 *  (React state is gone; whatever was `setItem`'d is still there) — a
 *  SECOND fake sharing the same backing `Map` simulates persistence across
 *  that reload, which is exactly what the "survives a reload" tests below
 *  check for. */
function makeFakeStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

async function freshProfile() {
  resetVaultCacheForTests()
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('kin-jar-key-vault')
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

beforeEach(freshProfile)
afterEach(freshProfile)

describe('isValidPinFormat', () => {
  it('accepts 4-8 digit numeric PINs', () => {
    expect(isValidPinFormat('1234')).toBe(true)
    expect(isValidPinFormat('12345678')).toBe(true)
    expect(isValidPinFormat('000000')).toBe(true)
  })

  it('rejects too short, too long, non-numeric, and garbage input', () => {
    expect(isValidPinFormat('123')).toBe(false)
    expect(isValidPinFormat('123456789')).toBe(false)
    expect(isValidPinFormat('12a4')).toBe(false)
    expect(isValidPinFormat('')).toBe(false)
    expect(isValidPinFormat(' 1234')).toBe(false)
    expect(isValidPinFormat(undefined as unknown as string)).toBe(false)
    expect(() => isValidPinFormat(undefined as unknown as string)).not.toThrow()
  })
})

describe('pinIsSet', () => {
  it('is false before any PIN has been set', async () => {
    expect(await pinIsSet()).toBe(false)
  })

  it('is true after setPin succeeds', async () => {
    await setPin('4242', SK)
    expect(await pinIsSet()).toBe(true)
  })

  it('stays false if setPin was rejected for a malformed PIN', async () => {
    await setPin('abcd', SK)
    expect(await pinIsSet()).toBe(false)
  })
})

describe('setPin', () => {
  it('rejects a malformed PIN without sealing anything', async () => {
    expect(await setPin('12', SK)).toBe(false)
    expect(await setPin('abcdef', SK)).toBe(false)
    expect(await pinIsSet()).toBe(false)
  })

  it('accepts a well-formed PIN and reports success', async () => {
    expect(await setPin('123456', SK)).toBe(true)
  })

  it('leaves no CHILD_SK_NAME entry — the sk is never written anywhere durable', async () => {
    await setPin('123456', SK)
    expect(await vaultLoad('child-sk')).toBeNull()
  })

  it('deletes a legacy CHILD_SK_NAME entry as migration hygiene (pre-fix builds wrote one)', async () => {
    await vaultStore('child-sk', SK)
    expect(await vaultLoad('child-sk')).toEqual(SK)
    await setPin('123456', SK)
    expect(await vaultLoad('child-sk')).toBeNull()
  })

  it('never stores the PIN itself, or the raw sk, in plaintext in the durable blob', async () => {
    await setPin('123456', SK)
    const raw = await vaultLoad('child-pin-wrap')
    expect(raw).not.toBeNull()
    const text = new TextDecoder().decode(raw!)
    expect(text).not.toContain('123456')
    const hex = Array.from(SK, (b) => b.toString(16).padStart(2, '0')).join('')
    expect(text).not.toContain(hex)
  })
})

describe('unlockWithPin', () => {
  it('returns null when no PIN has ever been set', async () => {
    expect(await unlockWithPin('123456')).toBeNull()
  })

  it('recovers the sk with the correct PIN', async () => {
    await setPin('123456', SK)
    expect(await unlockWithPin('123456')).toEqual(SK)
  })

  it('returns null for the wrong PIN, without throwing', async () => {
    await setPin('123456', SK)
    await expect(unlockWithPin('999999')).resolves.toBeNull()
  })

  it('writes nothing durable on a successful unlock — CHILD_SK_NAME stays absent', async () => {
    await setPin('123456', SK)
    const recovered = await unlockWithPin('123456')
    expect(recovered).toEqual(SK)
    expect(await vaultLoad('child-sk')).toBeNull()
  })

  it('writes nothing durable on a FAILED unlock either', async () => {
    await setPin('123456', SK)
    await unlockWithPin('999999')
    expect(await vaultLoad('child-sk')).toBeNull()
  })

  it('returns null (not a throw) against a corrupted blob', async () => {
    await setPin('123456', SK)
    // Reach past the public API to flip a byte in the stored blob, the way
    // vault.test.ts exercises identity/vault.ts's own tamper detection.
    const req = indexedDB.open('kin-jar-key-vault', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const stored = await new Promise<string>((resolve, reject) => {
      const r = db.transaction('secrets', 'readonly').objectStore('secrets').get('child-pin-wrap')
      r.onsuccess = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
    })
    const flipped = stored.slice(0, -4) + (stored.slice(-4, -3) === 'A' ? 'B' : 'A') + stored.slice(-3)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('secrets', 'readwrite')
      tx.objectStore('secrets').put(flipped, 'child-pin-wrap')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()

    await expect(unlockWithPin('123456')).resolves.toBeNull()
  })
})

describe('loadBackoffState / saveBackoffState / clearBackoffState', () => {
  it('reads the zero state when nothing has ever been saved', () => {
    const storage = makeFakeStorage()
    expect(loadBackoffState(storage)).toEqual({ consecutiveFailures: 0, lockedUntilSec: 0 })
  })

  it('round-trips a saved state', () => {
    const storage = makeFakeStorage()
    saveBackoffState(storage, { consecutiveFailures: 3, lockedUntilSec: 1_015 })
    expect(loadBackoffState(storage)).toEqual({ consecutiveFailures: 3, lockedUntilSec: 1_015 })
  })

  it('survives a simulated reload — a fresh read against the SAME backing storage still sees it', () => {
    // Simulates a page reload: `storage` is the one thing that outlives a
    // reload (real localStorage); `loadBackoffState` is called completely
    // fresh, with no React state/closures carried over, exactly as it would
    // be on ChildLock's next mount.
    const storage = makeFakeStorage()
    saveBackoffState(storage, { consecutiveFailures: 4, lockedUntilSec: 5_000 })
    const reloaded = loadBackoffState(storage)
    expect(reloaded).toEqual({ consecutiveFailures: 4, lockedUntilSec: 5_000 })
    expect(canAttempt(reloaded.lockedUntilSec, 4_999)).toBe(false)
  })

  it('clearBackoffState resets to the zero state', () => {
    const storage = makeFakeStorage()
    saveBackoffState(storage, { consecutiveFailures: 5, lockedUntilSec: 9_999 })
    clearBackoffState(storage)
    expect(loadBackoffState(storage)).toEqual({ consecutiveFailures: 0, lockedUntilSec: 0 })
  })

  it('is total against a corrupted/hand-edited entry, never a throw', () => {
    const storage = makeFakeStorage()
    storage.setItem('kin-jar-child-backoff', 'not json at all')
    expect(() => loadBackoffState(storage)).not.toThrow()
    expect(loadBackoffState(storage)).toEqual({ consecutiveFailures: 0, lockedUntilSec: 0 })
  })

  it('is total against a well-formed-JSON but wrong-shaped entry', () => {
    const storage = makeFakeStorage()
    storage.setItem('kin-jar-child-backoff', JSON.stringify({ consecutiveFailures: 'lots', lockedUntilSec: -1 }))
    expect(loadBackoffState(storage)).toEqual({ consecutiveFailures: 0, lockedUntilSec: 0 })
  })
})

describe('backoffSecs', () => {
  it('has no wait for the first two failures (fat-fingering tolerance)', () => {
    expect(backoffSecs(0)).toBe(0)
    expect(backoffSecs(1)).toBe(0)
    expect(backoffSecs(2)).toBe(5)
  })

  it('escalates monotonically through the table', () => {
    expect(backoffSecs(3)).toBe(15)
    expect(backoffSecs(4)).toBe(30)
    expect(backoffSecs(5)).toBe(60)
  })

  it('caps at the last entry rather than growing unbounded', () => {
    expect(backoffSecs(6)).toBe(60)
    expect(backoffSecs(1000)).toBe(60)
  })

  it('is total against garbage input — non-finite/negative fails open (no wait), never a throw', () => {
    expect(backoffSecs(-1)).toBe(0)
    expect(backoffSecs(NaN)).toBe(0)
    expect(backoffSecs(Infinity)).toBe(0)
    expect(() => backoffSecs(NaN)).not.toThrow()
  })
})

describe('nextLockedUntil / canAttempt', () => {
  it('locks out until now + the backoff for that failure count', () => {
    expect(nextLockedUntil(3, 1_000)).toBe(1_015)
  })

  it('canAttempt is false before the lockout clears and true once it does', () => {
    const until = nextLockedUntil(4, 1_000)
    expect(canAttempt(until, 1_000)).toBe(false)
    expect(canAttempt(until, until - 1)).toBe(false)
    expect(canAttempt(until, until)).toBe(true)
    expect(canAttempt(until, until + 1)).toBe(true)
  })

  it('canAttempt fails open against a non-finite lockedUntilSec, never a throw', () => {
    expect(canAttempt(NaN, 1_000)).toBe(true)
    expect(canAttempt(Infinity, 1_000)).toBe(true)
    expect(() => canAttempt(NaN, 1_000)).not.toThrow()
  })
})

// ============================================================================
// clearPin — v0.2 spec §4.5. The child half of a guardian's "Remove this
// device": everything this module owns on disk goes, so the next launch is
// a genuinely unpaired device rather than one still asking for a PIN that
// unlocks a key nobody will sync with.
// ============================================================================

describe('clearPin', () => {
  it('removes the durable PIN wrap, so no PIN is set afterwards', async () => {
    await setPin('1234', SK)
    expect(await pinIsSet()).toBe(true)
    await clearPin()
    expect(await pinIsSet()).toBe(false)
    expect(await unlockWithPin('1234')).toBeNull()
  })

  it('is idempotent', async () => {
    await setPin('1234', SK)
    await clearPin()
    await clearPin()
    expect(await pinIsSet()).toBe(false)
  })

  it('never throws when nothing was ever set', async () => {
    await expect(clearPin()).resolves.toBeUndefined()
  })

  it('clears the persisted backoff state, so a live lockout does not outlive the pairing', async () => {
    const storage = makeFakeStorage()
    saveBackoffState(storage, { consecutiveFailures: 5, lockedUntilSec: 9_999_999 })
    await setPin('1234', SK)
    await clearPin(storage)
    expect(loadBackoffState(storage)).toEqual({ consecutiveFailures: 0, lockedUntilSec: 0 })
  })

  it('also removes the legacy plaintext session slot a pre-fix build may have left behind', async () => {
    await vaultStore('child-sk', SK)
    await clearPin()
    expect(await vaultLoad('child-sk')).toBeNull()
  })
})
