import { describe, it, expect } from 'vitest'
import { newId, ulidTimeMs } from './id'

const fixedRandom = (bytes: number) => new Uint8Array(bytes).fill(7)

describe('newId', () => {
  it('is 26 chars of Crockford base32', () => {
    const id = newId(1754870400000)
    expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/)
  })
  it('orders lexicographically by time', () => {
    const a = newId(1000, fixedRandom)
    const b = newId(2000, fixedRandom)
    expect(a < b).toBe(true)
  })
  it('same time, different randomness → different ids', () => {
    const a = newId(1000)
    const b = newId(1000)
    expect(a).not.toBe(b)
  })
  it('rejects non-integer or negative time', () => {
    expect(() => newId(-1)).toThrow(RangeError)
    expect(() => newId(1.5)).toThrow(RangeError)
  })
})

describe('ulidTimeMs', () => {
  it('round-trips the time newId encodes', () => {
    expect(ulidTimeMs(newId(1_755_000_000_123))).toBe(1_755_000_000_123)
  })
  it('is null for anything that is not a ULID', () => {
    expect(ulidTimeMs('c1')).toBeNull()
    expect(ulidTimeMs('sched:allowance:sam:a:2026-08-07')).toBeNull()
    expect(ulidTimeMs('0'.repeat(25) + 'U')).toBeNull() // U is not Crockford
  })
})
