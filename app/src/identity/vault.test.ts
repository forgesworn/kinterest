// vitest runs in the 'node' environment (see vite.config.ts), which has no
// IndexedDB — fake-indexeddb/auto installs a spec-compliant in-memory
// implementation onto globalThis so vault.ts's real IndexedDB code paths run
// unmodified under test.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  vaultStore,
  vaultLoad,
  vaultDelete,
  vaultSupported,
  storeFamilyMnemonic,
  loadFamilyMnemonic,
  resetVaultCacheForTests,
} from './vault'

const SECRET = new Uint8Array(32).fill(7)

/** Wipe every trace, the way a brand-new browser profile would present. */
async function freshProfile() {
  resetVaultCacheForTests()
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('kin-jar-key-vault')
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

beforeEach(freshProfile)
afterEach(() => vi.restoreAllMocks())

describe('vaultSupported', () => {
  it('is true once fake-indexeddb and WebCrypto are installed', () => {
    expect(vaultSupported()).toBe(true)
  })
})

describe('vaultStore / vaultLoad round-trip', () => {
  it('stores and loads a secret under a name', async () => {
    await vaultStore('guardian', SECRET)
    const loaded = await vaultLoad('guardian')
    expect(loaded).toEqual(SECRET)
  })

  it('keeps different names independent', async () => {
    const other = new Uint8Array(32).fill(9)
    await vaultStore('guardian', SECRET)
    await vaultStore('child-0', other)
    expect(await vaultLoad('guardian')).toEqual(SECRET)
    expect(await vaultLoad('child-0')).toEqual(other)
  })

  it('overwrites an existing value at the same name', async () => {
    const replacement = new Uint8Array(32).fill(3)
    await vaultStore('guardian', SECRET)
    await vaultStore('guardian', replacement)
    expect(await vaultLoad('guardian')).toEqual(replacement)
  })

  it('concurrent first-use stores do not race each other onto conflicting wrap keys', async () => {
    // Both calls hit a cold vault (no wrap key persisted yet) at the same
    // time. Without the in-module mutex, each could generate and persist
    // its OWN wrap key, and whichever `put` lands last would silently
    // orphan whatever the other call sealed under the first (see
    // ensureWrapKey's comment in vault.ts). Both must round-trip.
    const a = new Uint8Array(32).fill(1)
    const b = new Uint8Array(32).fill(2)
    const c = new Uint8Array(32).fill(3)
    await Promise.all([vaultStore('a', a), vaultStore('b', b), vaultStore('c', c)])
    expect(await vaultLoad('a')).toEqual(a)
    expect(await vaultLoad('b')).toEqual(b)
    expect(await vaultLoad('c')).toEqual(c)
  })

  it('shares one wrapping key across multiple stored secrets (survives across loads)', async () => {
    await vaultStore('a', SECRET)
    await vaultStore('b', new Uint8Array(32).fill(1))
    expect(await vaultLoad('a')).toEqual(SECRET)
  })
})

describe('vaultLoad — absent', () => {
  it('returns null for a name that was never stored, without logging', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = await vaultLoad('never-stored')
    expect(loaded).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('vaultLoad — corrupt', () => {
  it('returns null AND logs when the stored blob is not a recognised seal format', async () => {
    // Reach past the public API to plant a malformed blob directly, the way
    // an interrupted write or a hand-edited profile might leave one.
    const req = indexedDB.open('kin-jar-key-vault', 1)
    await new Promise<void>((resolve, reject) => {
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('wrap')) db.createObjectStore('wrap')
        if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets')
      }
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    const db = req.result
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('secrets', 'readwrite')
      tx.objectStore('secrets').put('not-a-sealed-blob', 'guardian')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = await vaultLoad('guardian')
    expect(loaded).toBeNull()
    expect(spy).toHaveBeenCalled()
  })

  it('returns null AND logs when the ciphertext has been tampered with', async () => {
    await vaultStore('guardian', SECRET)

    // Flip a byte in the stored blob's ciphertext so AES-GCM's tag fails.
    const req = indexedDB.open('kin-jar-key-vault', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const stored = await new Promise<string>((resolve, reject) => {
      const r = db.transaction('secrets', 'readonly').objectStore('secrets').get('guardian')
      r.onsuccess = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
    })
    const parts = stored.split(':')
    const flipped = `${parts[0]}:${parts[1]}:${parts[2]![0] === 'A' ? 'B' : 'A'}${parts[2]!.slice(1)}`
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('secrets', 'readwrite')
      tx.objectStore('secrets').put(flipped, 'guardian')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = await vaultLoad('guardian')
    expect(loaded).toBeNull()
    expect(spy).toHaveBeenCalled()
  })
})

describe('vaultDelete', () => {
  it('removes a stored secret', async () => {
    await vaultStore('guardian', SECRET)
    await vaultDelete('guardian')
    expect(await vaultLoad('guardian')).toBeNull()
  })

  it('is a no-op for a name that was never stored', async () => {
    await expect(vaultDelete('never-stored')).resolves.toBeUndefined()
  })

  it('leaves other names untouched', async () => {
    const other = new Uint8Array(32).fill(4)
    await vaultStore('guardian', SECRET)
    await vaultStore('child-0', other)
    await vaultDelete('guardian')
    expect(await vaultLoad('guardian')).toBeNull()
    expect(await vaultLoad('child-0')).toEqual(other)
  })
})

describe('secrecy properties', () => {
  it('never stores the secret in plaintext form in the blob', async () => {
    await vaultStore('guardian', SECRET)
    const req = indexedDB.open('kin-jar-key-vault', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const stored = await new Promise<string>((resolve, reject) => {
      const r = db.transaction('secrets', 'readonly').objectStore('secrets').get('guardian')
      r.onsuccess = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
    })
    db.close()
    const hex = Array.from(SECRET, (b) => b.toString(16).padStart(2, '0')).join('')
    expect(stored).not.toContain(hex)
  })

  it('keeps the wrapping key non-extractable', async () => {
    await vaultStore('guardian', SECRET)
    const req = indexedDB.open('kin-jar-key-vault', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const stored = await new Promise<unknown>((resolve, reject) => {
      const r = db.transaction('wrap', 'readonly').objectStore('wrap').get('vault-wrap-v1')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    db.close()
    expect(stored).toBeInstanceOf(CryptoKey)
    expect((stored as CryptoKey).extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', stored as CryptoKey)).rejects.toThrow()
  })

  it('uses a fresh nonce each time, so sealing the same secret twice differs on disk', async () => {
    await vaultStore('a', SECRET)
    const req = indexedDB.open('kin-jar-key-vault', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const first = await new Promise<string>((resolve, reject) => {
      const r = db.transaction('secrets', 'readonly').objectStore('secrets').get('a')
      r.onsuccess = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
    })
    db.close()
    await vaultStore('a', SECRET)
    const req2 = indexedDB.open('kin-jar-key-vault', 1)
    const db2 = await new Promise<IDBDatabase>((resolve, reject) => {
      req2.onsuccess = () => resolve(req2.result)
      req2.onerror = () => reject(req2.error)
    })
    const second = await new Promise<string>((resolve, reject) => {
      const r = db2.transaction('secrets', 'readonly').objectStore('secrets').get('a')
      r.onsuccess = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
    })
    db2.close()
    expect(first).not.toBe(second)
  })
})

describe('storeFamilyMnemonic / loadFamilyMnemonic', () => {
  const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

  it('round-trips the guardian mnemonic under the well-known vault name', async () => {
    await storeFamilyMnemonic(MNEMONIC)
    expect(await loadFamilyMnemonic()).toBe(MNEMONIC)
  })

  it('is stored under vaultLoad("family-mnemonic") too — same underlying entry', async () => {
    await storeFamilyMnemonic(MNEMONIC)
    const raw = await vaultLoad('family-mnemonic')
    expect(raw).not.toBeNull()
    expect(new TextDecoder().decode(raw!)).toBe(MNEMONIC)
  })

  it('returns null when no mnemonic has been stored', async () => {
    expect(await loadFamilyMnemonic()).toBeNull()
  })
})
