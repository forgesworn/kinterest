/** IndexedDB-backed storage for the ledger, outbox and recovery metadata.
 * The synchronous mirror keeps existing folds/outbox operations atomic within
 * this page. Writes commit together asynchronously; failed writes stay dirty
 * for retry and are reported to the app. Boot must await initialiseDataStorage.
 */
export interface DataStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const DB_NAME = 'kin-jar-data'
const STORE = 'records'
const MIGRATED = 'migrated-v1'
const LEGACY_KEYS = [
  'kinjar.state.v1', 'kinjar.outbox.v1', 'kinjar.quarantine.v1',
  'kinjar.vault.publishedSignature.v1', 'kinjar.vault.queuedPublish.v1',
]

export class IndexedDataStorage implements DataStorage {
  private dirty = new Map<string, string | null>()
  private pending: Promise<boolean> | null = null
  private failed = false
  private listeners = new Set<() => void>()

  constructor(private db: IDBDatabase, private values: Map<string, string>) {
    db.onversionchange = () => { db.close(); this.report(true) }
  }

  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
    this.dirty.set(key, value)
    void this.flush()
  }
  removeItem(key: string): void {
    this.values.delete(key)
    this.dirty.set(key, null)
    void this.flush()
  }
  get hasError(): boolean { return this.failed }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private report(failed: boolean): void {
    if (this.failed === failed) return
    this.failed = failed
    for (const listener of this.listeners) listener()
  }

  /** Includes writes made while an earlier transaction was pending. */
  async flush(): Promise<boolean> {
    if (this.pending) {
      if (!await this.pending) return false
      return this.flush()
    }
    if (this.dirty.size === 0) return !this.failed
    const writes = new Map(this.dirty)
    this.dirty.clear()
    // Defer creation so pending is assigned even if transaction() throws.
    this.pending = Promise.resolve().then(() => new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      for (const [key, value] of writes) {
        if (value === null) store.delete(key)
        else store.put(value, key)
      }
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'))
      tx.onerror = () => { /* onabort reports the final transaction result */ }
    })).then(() => {
      this.report(false)
      return true
    }, () => {
      // Keep newer writes; restore only keys not changed in the meantime.
      for (const [key, value] of writes) if (!this.dirty.has(key)) this.dirty.set(key, value)
      this.report(true)
      return false
    })
    const ok = await this.pending
    this.pending = null
    return ok ? this.flush() : false
  }
}

export async function openDataStorage(factory: IDBFactory, legacy?: DataStorage): Promise<IndexedDataStorage> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Storage unavailable'))
    request.onblocked = () => reject(new Error('Storage upgrade blocked'))
  })
  try {
    // Read and migrate in one transaction: another tab cannot overwrite a
    // completed migration with its stale localStorage copy.
    const values = await new Promise<Map<string, string>>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const values = new Map<string, string>()
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          if (typeof cursor.value === 'string') values.set(String(cursor.key), cursor.value)
          cursor.continue()
          return
        }
        try {
          if (!values.has(MIGRATED)) {
            for (const key of LEGACY_KEYS) {
              const value = legacy?.getItem(key) ?? null
              if (value !== null && !values.has(key)) { values.set(key, value); store.put(value, key) }
            }
            values.set(MIGRATED, '1')
            store.put('1', MIGRATED)
          }
        } catch { tx.abort() }
      }
      tx.oncomplete = () => resolve(values)
      tx.onabort = () => reject(tx.error ?? new Error('Storage migration failed'))
      tx.onerror = () => { /* transaction abort rejects */ }
    })
    // Only after commit. The marker prevents re-import even if cleanup fails
    // or an older installed build later writes another legacy copy.
    for (const key of LEGACY_KEYS) { try { legacy?.removeItem(key) } catch { /* committed copy stands */ } }
    return new IndexedDataStorage(db, values)
  } catch (error) { db.close(); throw error }
}

export class DataStorageOpenElsewhere extends Error {}
export class DataStorageUnsupported extends Error {}

/** Hold one writer for this origin until the page closes. Ledger folds and
 * the synchronous outbox mirror must never race another tab's stale copy. */
export function acquireDataStorageLock(locks: LockManager): Promise<() => void> {
  return new Promise((resolve, reject) => {
    void locks.request('kin-jar-data-writer', { ifAvailable: true }, async lock => {
      if (!lock) { reject(new DataStorageOpenElsewhere()); return }
      await new Promise<void>(release => resolve(release))
    }).catch(reject)
  })
}

let active: IndexedDataStorage | null = null
let opening: Promise<void> | null = null
const memory = new Map<string, string>()
const fallback: DataStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => { memory.set(key, value) },
  removeItem: key => { memory.delete(key) },
}

/** Non-browser callers/tests can still inject their own synchronous storage. */
export function dataStorage(): DataStorage {
  if (active) return active
  try { return globalThis.localStorage ?? fallback } catch { return fallback }
}

export function initialiseDataStorage(): Promise<void> {
  if (active) return Promise.resolve()
  if (!opening) opening = (async () => {
    if (!navigator.locks) throw new DataStorageUnsupported()
    const release = await acquireDataStorageLock(navigator.locks)
    try {
      let legacy: DataStorage | undefined
      try { legacy = globalThis.localStorage } catch {
        // An already-migrated database does not need the legacy read. On a
        // first migration, fail closed rather than mark an unread family empty.
        legacy = { getItem: () => { throw new Error('Legacy storage is unavailable') }, setItem: () => {}, removeItem: () => {} }
      }
      active = await openDataStorage(indexedDB, legacy)
    } catch (error) { release(); throw error }
  })().catch(error => { opening = null; throw error })
  return opening
}

export function flushDataStorage(storage: DataStorage = dataStorage()): Promise<boolean> {
  return storage instanceof IndexedDataStorage ? storage.flush() : Promise.resolve(true)
}
export function dataStorageHasError(): boolean { return active?.hasError ?? false }
export function onDataStorageError(listener: () => void): () => void {
  return active?.subscribe(listener) ?? (() => {})
}
