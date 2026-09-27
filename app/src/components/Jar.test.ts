import { describe, expect, it } from 'vitest'
import { jarFill } from './Jar'

// Pure-logic coverage only — Jar.tsx's SVG half is not exercised by an
// automated DOM runner (this suite has none — see Task 2's precedent on
// QRScanner.tsx/ChildOnboarding.tsx).

describe('jarFill', () => {
  it('a zero balance is a low ember glow, never literally empty/black', () => {
    const fill = jarFill(0, 10_000)
    expect(fill).toBeGreaterThan(0)
    expect(fill).toBeLessThan(0.1)
  })

  it('a negative balance floors at the same ember glow as zero', () => {
    expect(jarFill(-500, 10_000)).toBe(jarFill(0, 10_000))
  })

  it('a fresh jar with no history at all (highWater 0) still glows for a positive balance', () => {
    expect(jarFill(100, 0)).toBeGreaterThan(0)
  })

  it('is monotonic (non-decreasing) in balance, holding highWater fixed', () => {
    const highWater = 10_000
    const balances = [0, 500, 1_000, 5_000, 9_000, 10_000, 15_000]
    const fills = balances.map((b) => jarFill(b, highWater))
    for (let i = 1; i < fills.length; i++) {
      expect(fills[i]!).toBeGreaterThanOrEqual(fills[i - 1]!)
    }
  })

  it('is monotonic (non-increasing) in highWater, holding balance fixed — a bigger soft target dilutes the same balance\'s share', () => {
    const balance = 5_000
    const highWaters = [5_000, 10_000, 20_000, 50_000]
    const fills = highWaters.map((h) => jarFill(balance, h))
    for (let i = 1; i < fills.length; i++) {
      expect(fills[i]!).toBeLessThanOrEqual(fills[i - 1]!)
    }
  })

  it('a balance exactly at the historical high-water mark reads as nearly-but-not-quite full (soft target headroom)', () => {
    const fill = jarFill(10_000, 10_000)
    expect(fill).toBeCloseTo(1 / 1.2, 5)
    expect(fill).toBeLessThan(1)
  })

  it('never exceeds 1, even if a caller passes a stale highWater below the current balance', () => {
    expect(jarFill(100_000, 1_000)).toBe(1)
  })

  it('is total against non-finite input — never throws, degrades to the ember floor', () => {
    expect(() => jarFill(Number.NaN, 10_000)).not.toThrow()
    expect(jarFill(Number.NaN, 10_000)).toBeGreaterThan(0)
    expect(() => jarFill(500, Number.POSITIVE_INFINITY)).not.toThrow()
  })

  it('always returns a finite number in [ember floor, 1]', () => {
    for (const b of [0, 1, 250, 10_000, 999_999]) {
      for (const h of [0, 1, 10_000, 500_000]) {
        const fill = jarFill(b, h)
        expect(Number.isFinite(fill)).toBe(true)
        expect(fill).toBeGreaterThan(0)
        expect(fill).toBeLessThanOrEqual(1)
      }
    }
  })
})
