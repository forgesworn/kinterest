import { beforeEach, describe, expect, it, vi } from 'vitest'
const storage = vi.hoisted(() => new Map<string, Uint8Array>())
vi.mock('./vault', () => ({ vaultLoad: async (slot: string) => storage.get(slot)?.slice() ?? null, vaultStore: async (slot: string, bytes: Uint8Array) => { storage.set(slot,bytes.slice()) } }))
import { parentPinIsSet, setParentPin, unlockParent } from './parentPin'
beforeEach(() => storage.clear())
describe('separate parent PIN', () => {
  it('does not confuse a child PIN with a parent lock', async () => {
    storage.set('child-pin',new Uint8Array([1]))
    expect(await parentPinIsSet()).toBe(false)
    expect(await unlockParent('1234',100)).toEqual({unlocked:false,lockedUntilSec:0})
    expect(await setParentPin('bad')).toBe(false)
    expect(await setParentPin('1234')).toBe(true)
    expect((await unlockParent('1234',100)).unlocked).toBe(true)
    expect(storage.get('child-pin')).toEqual(new Uint8Array([1]))
  })
  it('serialises concurrent failures, persists lockout, then unlocks after expiry', async () => {
    await setParentPin('1234')
    await Promise.all(Array.from({length:5}, () => unlockParent('9999',100)))
    const saved = JSON.parse(new TextDecoder().decode(storage.get('parent-pin-v1')))
    expect(saved.failures).toBe(2)
    expect(saved.lockedUntilSec).toBeGreaterThan(100)
    expect((await unlockParent('1234',100)).unlocked).toBe(false)
    expect((await unlockParent('1234',saved.lockedUntilSec)).unlocked).toBe(true)
  })
  it('fails closed on corrupt storage and resets through the explicit setup operation', async () => {
    storage.set('parent-pin-v1',new TextEncoder().encode('{}'))
    await expect(parentPinIsSet()).rejects.toThrow()
    await expect(unlockParent('1234',100)).rejects.toThrow()
    await setParentPin('5678')
    expect((await unlockParent('1234',100)).unlocked).toBe(false)
    expect((await unlockParent('5678',100)).unlocked).toBe(true)
  })
})
