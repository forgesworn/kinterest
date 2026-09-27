import { describe, expect, it } from 'vitest'
import { initialZoom, nextZoom, scanSourceRect } from './QRScanner'

// Pure-logic coverage only — QRScanner.tsx itself is a thin component over
// getUserMedia/jsQR (camera + DOM side effects, no `environment: 'jsdom'`
// configured for this suite — see vite.config.ts); the geometry/zoom MATH it
// relies on lives in these exported helpers precisely so it's testable
// without a camera or a DOM (same pattern as screens/PairDevice.test.ts's
// pairingRemainingSecs).

describe('scanSourceRect', () => {
  it('is the full frame at zoom 1', () => {
    expect(scanSourceRect(1000, 500, 1)).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 500 })
  })

  it('crops a centred, smaller rectangle at zoom > 1', () => {
    const rect = scanSourceRect(1000, 500, 2)
    expect(rect).toEqual({ sx: 250, sy: 125, sw: 500, sh: 250 })
  })

  it('clamps zoom to the 1..6 range', () => {
    expect(scanSourceRect(1000, 500, 0.1)).toEqual(scanSourceRect(1000, 500, 1))
    expect(scanSourceRect(1000, 500, 100)).toEqual(scanSourceRect(1000, 500, 6))
  })

  it('is total against garbage input — never negative dimensions, never a throw', () => {
    expect(() => scanSourceRect(-10, -10, NaN)).not.toThrow()
    const rect = scanSourceRect(-10, -10, NaN)
    expect(rect.sw).toBeGreaterThanOrEqual(0)
    expect(rect.sh).toBeGreaterThanOrEqual(0)
  })

  it('is total against non-finite zoom', () => {
    expect(scanSourceRect(1000, 500, Infinity)).toEqual(scanSourceRect(1000, 500, 1))
    expect(scanSourceRect(1000, 500, NaN)).toEqual(scanSourceRect(1000, 500, 1))
  })
})

describe('initialZoom', () => {
  it('uses the preferred zoom when no hardware range is known', () => {
    expect(initialZoom(null)).toBeCloseTo(1.6)
  })

  it('clamps the preferred zoom into a hardware range', () => {
    expect(initialZoom({ min: 1, max: 1.3 })).toBe(1.3)
    expect(initialZoom({ min: 2, max: 5 })).toBe(2)
    expect(initialZoom({ min: 1, max: 3 })).toBeCloseTo(1.6)
  })

  it('accepts an explicit preferred value', () => {
    expect(initialZoom({ min: 1, max: 5 }, 3)).toBe(3)
  })
})

describe('nextZoom', () => {
  const range = { min: 1, max: 3, step: 0.1 }

  it('steps up and down by at least the button step', () => {
    expect(nextZoom(1.6, range, 1)).toBeCloseTo(1.8)
    expect(nextZoom(1.6, range, -1)).toBeCloseTo(1.4)
  })

  it('clamps at the range bounds rather than overshooting', () => {
    expect(nextZoom(2.9, range, 1)).toBe(3)
    expect(nextZoom(1.05, range, -1)).toBe(1)
  })

  it('uses at least the button step even when the hardware step is smaller', () => {
    const fineRange = { min: 1, max: 3, step: 0.01 }
    expect(nextZoom(1, fineRange, 1)).toBeCloseTo(1.2)
  })
})
