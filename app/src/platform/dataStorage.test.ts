import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDataStorage, openDataStorage, type DataStorage } from './dataStorage'

function legacy(values: Record<string, string> = {}): DataStorage {
  const map = new Map(Object.entries(values))
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value) }, removeItem: key => { map.delete(key) } }
}

describe('IndexedDB data storage', () => {
  it('migrates the ledger, sealed outbox and quarantine before removing legacy copies', async () => {
    const factory = new IDBFactory()
    const old = legacy({ 'kinjar.state.v1': '{"v":1}', 'kinjar.outbox.v1': '["sealed"]', 'kinjar.quarantine.v1': '["bad"]', 'kinjar.pin.backoff.v1': 'keep' })
    const storage = await openDataStorage(factory, old)
    expect(storage.getItem('kinjar.state.v1')).toBe('{"v":1}')
    expect(storage.getItem('kinjar.outbox.v1')).toBe('["sealed"]')
    expect(old.getItem('kinjar.state.v1')).toBeNull()
    expect(old.getItem('kinjar.pin.backoff.v1')).toBe('keep')
    expect((await openDataStorage(factory)).getItem('kinjar.quarantine.v1')).toBe('["bad"]')
  })
  it('does not resurrect old data after migration, including after Start again', async () => {
    const factory = new IDBFactory()
    const old = legacy({ 'kinjar.state.v1': 'old', 'kinjar.outbox.v1': 'old wraps' })
    const storage = await openDataStorage(factory, old)
    storage.removeItem('kinjar.state.v1'); storage.removeItem('kinjar.outbox.v1')
    expect(await storage.flush()).toBe(true)
    old.setItem('kinjar.state.v1', 'stale older build'); old.setItem('kinjar.outbox.v1', 'stale wraps')
    const reopened = await openDataStorage(factory, old)
    expect(reopened.getItem('kinjar.state.v1')).toBeNull()
    expect(reopened.getItem('kinjar.outbox.v1')).toBeNull()
  })
  it('keeps the newest update and deletion when writes overlap', async () => {
    const factory = new IDBFactory()
    const storage = await openDataStorage(factory)
    storage.setItem('kinjar.state.v1', 'first'); storage.setItem('kinjar.state.v1', 'newest')
    storage.setItem('kinjar.outbox.v1', 'queued'); storage.removeItem('kinjar.outbox.v1')
    expect(await storage.flush()).toBe(true)
    const reopened = await openDataStorage(factory)
    expect(reopened.getItem('kinjar.state.v1')).toBe('newest')
    expect(reopened.getItem('kinjar.outbox.v1')).toBeNull()
  })
  it('retains dirty writes and reports failure until a retry commits', async () => {
    const factory = new IDBFactory()
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = factory.open('failure-test', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('records')
      request.onsuccess = () => resolve(request.result)
    })
    const storage = new IndexedDataStorage(db, new Map())
    const listener = vi.fn(); storage.subscribe(listener)
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw new Error('quota') })
    storage.setItem('kinjar.state.v1', 'newest')
    expect(await storage.flush()).toBe(false)
    expect(storage.hasError).toBe(true)
    expect(storage.getItem('kinjar.state.v1')).toBe('newest')
    transaction.mockRestore()
    expect(await storage.flush()).toBe(true)
    expect(storage.hasError).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    const stored = await new Promise(resolve => {
      const request = db.transaction('records').objectStore('records').get('kinjar.state.v1')
      request.onsuccess = () => resolve(request.result)
    })
    expect(stored).toBe('newest')
  })
  it('keeps legacy storage intact when migration aborts', async () => {
    const factory = new IDBFactory()
    const old = legacy({ 'kinjar.state.v1': 'ledger' })
    await expect(openDataStorage(factory, { ...old, getItem: () => { throw new Error('read denied') } })).rejects.toThrow()
    expect(old.getItem('kinjar.state.v1')).toBe('ledger')
    expect((await openDataStorage(factory, old)).getItem('kinjar.state.v1')).toBe('ledger')
  })
})

it('does not need legacy storage once a completed migration exists', async () => {
  const factory = new IDBFactory()
  const initial = await openDataStorage(factory, legacy({ 'kinjar.state.v1': 'ledger' }))
  initial.setItem('kinjar.state.v1', 'current ledger')
  await initial.flush()
  const inaccessible = { getItem: () => { throw new Error('denied') }, setItem: () => {}, removeItem: () => { throw new Error('denied') } }
  expect((await openDataStorage(factory, inaccessible)).getItem('kinjar.state.v1')).toBe('current ledger')
})

it('allows only one writer and admits another tab after the owner releases', async () => {
  const { acquireDataStorageLock, DataStorageOpenElsewhere } = await import('./dataStorage')
  let held = false
  const locks = { request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
    if (held) return callback(null)
    held = true
    try { await callback({}) } finally { held = false }
  } } as unknown as LockManager
  const release = await acquireDataStorageLock(locks)
  await expect(acquireDataStorageLock(locks)).rejects.toBeInstanceOf(DataStorageOpenElsewhere)
  release()
  await Promise.resolve(); await Promise.resolve()
  const nextRelease = await acquireDataStorageLock(locks)
  nextRelease()
})
