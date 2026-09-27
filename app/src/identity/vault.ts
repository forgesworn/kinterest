// At-rest custody for secret keys — port of charter's
// `apps/charter-app/src/signer/keyVault.ts`, generalised from a single
// guardian slot to a named store so a guardian's family mnemonic (the
// suite's single family backup — see derive.ts) and any derived keys it
// custodies on a shared device can be vaulted side-by-side.
//
// WHAT THIS BUYS, precisely, so nobody over-trusts it (verbatim reasoning
// from charter's keyVault.ts):
//
//   - No plaintext key at rest. What is stored is AES-GCM ciphertext.
//   - The wrapping key is a NON-EXTRACTABLE CryptoKey living in IndexedDB.
//     The browser will hand it to `crypto.subtle.decrypt` and to nothing
//     else — it cannot be read out, serialised, or carried off the device.
//   - It does NOT defeat script already running on this origin after the app
//     has booted: a decrypted copy lives in memory while signing. In a
//     browser, that is unavoidable for any key the page itself uses.
//
// Name-free by design: the database/store names below must
// never leak the product name onto disk.

const DB_NAME = 'kin-jar-key-vault'
const DB_VERSION = 1
const WRAP_STORE = 'wrap'
const SECRETS_STORE = 'secrets'
const WRAP_ID = 'vault-wrap-v1'

/** Sealed-blob prefix, so a stored value announces its own format. */
const SEAL_PREFIX = 'v1'

/** The vault name the guardian's BIP-39 mnemonic is stored under — the
 *  suite's single family backup (see derive.ts). */
export const FAMILY_MNEMONIC_NAME = 'family-mnemonic'

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(WRAP_STORE)) db.createObjectStore(WRAP_STORE)
      if (!db.objectStoreNames.contains(SECRETS_STORE)) db.createObjectStore(SECRETS_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    req.onblocked = () => reject(new Error('indexedDB blocked'))
  })
}

function idbGet(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'))
  })
}

function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB write aborted'))
  })
}

/** Writes `value` under `key` only if nothing is there yet (audit P15).
 *  Resolves 'exists', without writing, when another writer got there first —
 *  a second tab on the same cold vault, which the in-module mutex below
 *  cannot see. */
function idbAddIfAbsent(db: IDBDatabase, store: string, key: string, value: unknown): Promise<'added' | 'exists'> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    const req = tx.objectStore(store).add(value, key)
    let exists = false
    req.onerror = (ev) => {
      if (req.error?.name === 'ConstraintError') {
        exists = true
        // Not a failure: keep the transaction alive, and keep the event from
        // bubbling up to `tx.onerror` as one.
        ev.preventDefault()
        ev.stopPropagation()
      }
    }
    tx.oncomplete = () => resolve(exists ? 'exists' : 'added')
    tx.onerror = () => {
      if (!exists) reject(tx.error ?? new Error('indexedDB write failed'))
    }
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB write aborted'))
  })
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB delete aborted'))
  })
}

/** True when this environment can actually hold a vault. */
export function vaultSupported(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle?.encrypt === 'function'
  )
}

// The wrapping key: AES-GCM 256, **`extractable: false`**, created once and
// kept in IndexedDB, shared by every named secret this vault holds.
// Structured-clone stores the CryptoKey handle itself, so the raw bytes
// never exist anywhere JavaScript can reach them.
//
// `vaultStore`/`vaultLoad` can race on first use (e.g. two concurrent
// callers on a cold vault) — without serialising, both could observe "no
// wrap key yet", each generate and persist their OWN fresh key, and
// whichever `put` lands second silently orphans whatever the other call
// just sealed under the first. `wrapKeyPromise` is an in-module mutex: the
// first caller's in-flight promise is handed to every concurrent caller
// instead of each racing `idbGet`/`generateKey`/`idbPut` independently. A
// failure clears it so the next call gets a clean retry rather than being
// stuck replaying a stale rejection forever.
let wrapKeyPromise: Promise<CryptoKey> | null = null

async function ensureWrapKey(): Promise<CryptoKey> {
  if (!wrapKeyPromise) {
    wrapKeyPromise = (async () => {
      const db = await idbOpen()
      try {
        const existing = await idbGet(db, WRAP_STORE, WRAP_ID)
        if (existing instanceof CryptoKey) return existing
        const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
          'encrypt',
          'decrypt',
        ])
        // `add`, never `put` (audit P15): if another tab created the key
        // since the read above, ITS key stands and this fresh one is thrown
        // away, instead of silently replacing a key that tab has already
        // sealed secrets under.
        await idbAddIfAbsent(db, WRAP_STORE, WRAP_ID, fresh)
        // Read back rather than trusting the write: a vault whose key did
        // not actually persist would seal a secret today and lose it at
        // the next reload, which is the one failure this module must not
        // cause. It is also how the loser of a two-tab race picks up the
        // winner's key.
        const confirmed = await idbGet(db, WRAP_STORE, WRAP_ID)
        if (!(confirmed instanceof CryptoKey)) throw new Error('wrap key did not persist')
        return confirmed
      } finally {
        db.close()
      }
    })()
  }
  try {
    return await wrapKeyPromise
  } catch (err) {
    wrapKeyPromise = null // let the next call retry cleanly
    throw err
  }
}

/** A plain-ArrayBuffer copy — WebCrypto's types reject the SharedArrayBuffer
 *  case that a bare `Uint8Array` leaves open, and callers hand us views from
 *  everywhere. */
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

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Store `secret` under `name`, sealed as AES-GCM ciphertext under the
 * vault's non-extractable wrapping key. Overwrites any existing value at
 * `name`.
 */
export async function vaultStore(name: string, secret: Uint8Array): Promise<void> {
  const key = await ensureWrapKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toBuffer(secret)))
  const blob = `${SEAL_PREFIX}:${toB64(iv)}:${toB64(ct)}`
  const db = await idbOpen()
  try {
    await idbPut(db, SECRETS_STORE, name, blob)
  } finally {
    db.close()
  }
}

/**
 * Load the secret stored under `name`.
 *
 * Returns `null` for two distinct situations, deliberately unified at this
 * signature but distinguished by side effect: nothing was ever stored under
 * `name` (silent — a normal "not paired yet" state), or something IS stored
 * but could not be opened — wrong format, missing/rotated wrap key, failed
 * GCM tag (logged via `console.error`, because a present-but-unreadable
 * secret is corruption a caller should be able to notice, not a routine
 * absence).
 */
export async function vaultLoad(name: string): Promise<Uint8Array | null> {
  const db = await idbOpen()
  let stored: unknown
  try {
    stored = await idbGet(db, SECRETS_STORE, name)
  } finally {
    db.close()
  }
  if (stored === undefined) return null // absent: nothing ever stored here
  if (typeof stored !== 'string') {
    console.error(`vault: entry "${name}" is not a sealed blob`)
    return null
  }
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== SEAL_PREFIX) {
    console.error(`vault: entry "${name}" is not a recognised seal format`)
    return null
  }
  try {
    const iv = fromB64(parts[1]!)
    const ct = fromB64(parts[2]!)
    const key = await ensureWrapKey()
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, toBuffer(ct)))
  } catch (err) {
    // Present but unreadable — corrupt, not absent. Log so a caller
    // watching the console can tell the two apart even though this
    // function's return value cannot.
    console.error(`vault: entry "${name}" could not be opened`, err)
    return null
  }
}

/** Remove the entry stored under `name`, if any. A no-op if nothing was
 *  stored — deleting an absent key is not an error. */
export async function vaultDelete(name: string): Promise<void> {
  const db = await idbOpen()
  try {
    await idbDelete(db, SECRETS_STORE, name)
  } finally {
    db.close()
  }
}

/** Store the guardian's BIP-39 mnemonic — the suite's single family backup
 *  (see derive.ts) — under the vault's well-known {@link FAMILY_MNEMONIC_NAME}. */
export async function storeFamilyMnemonic(mnemonic: string): Promise<void> {
  await vaultStore(FAMILY_MNEMONIC_NAME, new TextEncoder().encode(mnemonic))
}

/** Load the guardian's BIP-39 mnemonic, or `null` if absent/corrupt (see
 *  {@link vaultLoad}). */
export async function loadFamilyMnemonic(): Promise<string | null> {
  const bytes = await vaultLoad(FAMILY_MNEMONIC_NAME)
  if (bytes === null) return null
  return new TextDecoder().decode(bytes)
}

/** Test seam — forget the in-module cached wrap-key promise, as a fresh
 *  page load (new module instance) would. Without this, tests that delete
 *  the underlying IndexedDB database to simulate a fresh profile would
 *  still see the OLD in-memory CryptoKey via {@link ensureWrapKey}'s cache,
 *  silently masking the very race the cache exists to prevent. */
export function resetVaultCacheForTests(): void {
  wrapKeyPromise = null
}
