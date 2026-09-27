import { describe, it, expect } from 'vitest'
import type { Account, Entry } from './types'
import { balances, creditEntry, debitEntry, transferEntry, reverseEntry } from './ledger'
import { interestMinor } from './interest'

// Deterministic seeded PRNG (mulberry32) — no Math.random in tests.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const a: Account = { id: 'A', child: 'kid', name: 'With Mum & Dad', currency: 'GBP', custody: 'ledger' }
const b: Account = { id: 'B', child: 'kid', name: 'Money box', currency: 'GBP', custody: 'physical' }

function randomEntries(seed: number, n: number): Entry[] {
  const rand = rng(seed)
  const out: Entry[] = []
  for (let i = 0; i < n; i++) {
    const meta = { id: `e${i}`, child: 'kid', createdAt: i, author: 'guardian' as const }
    const amount = 1 + Math.floor(rand() * 10000)
    const pick = rand()
    if (pick < 0.4) out.push(creditEntry(meta, rand() < 0.5 ? a : b, amount))
    else if (pick < 0.8) out.push(debitEntry(meta, rand() < 0.5 ? a : b, amount))
    else out.push(rand() < 0.5 ? transferEntry(meta, a, b, amount) : transferEntry(meta, b, a, amount))
  }
  return out
}

function shuffled<T>(xs: T[], seed: number): T[] {
  const rand = rng(seed)
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('fold commutativity — replicas converge regardless of arrival order', () => {
  it('holds across 20 seeds × 200 entries', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const entries = randomEntries(seed, 200)
      const reference = balances(entries)
      expect(balances(shuffled(entries, seed * 31))).toEqual(reference)
    }
  })
})

describe('reversal cancellation — a reversal exactly undoes its original', () => {
  it('holds for every entry in a random ledger', () => {
    const entries = randomEntries(42, 100)
    const reference = balances(entries)
    for (const e of entries.slice(0, 25)) {
      const reversal = reverseEntry(e, { id: `${e.id}-rev`, child: e.child, createdAt: 9999, author: 'guardian' })
      const undone = balances([...entries, e, reversal]) // add a duplicate + its reversal
      expect(undone).toEqual(reference)
    }
  })
})

describe('interest never decreases a balance and is integer-safe', () => {
  it('holds across a sweep of balances and rates', () => {
    const rand = rng(7)
    for (let i = 0; i < 500; i++) {
      const balance = Math.floor(rand() * 1_000_000)
      const rate = Math.floor(rand() * 2000)
      const interest = interestMinor(balance, rate)
      expect(Number.isSafeInteger(interest)).toBe(true)
      expect(interest).toBeGreaterThanOrEqual(0)
      if (balance > 0 && rate > 0) expect(interest).toBeGreaterThanOrEqual(1)
    }
  })
})
