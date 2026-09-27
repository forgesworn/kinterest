import { describe, expect, it } from 'vitest'
import { pairingRemainingSecs } from './PairDevice'
import { TOKEN_TTL_SECS } from '../pairing/tokens'

// Pure-logic coverage only — PairDevice.tsx itself is a thin screen (React
// component, DOM/vault/relay side effects); the countdown/re-mint MATH it
// relies on lives in this exported helper precisely so it's testable
// without mounting anything (same pattern as components/Money.tsx's
// moneyParts / money.test.ts).
describe('pairingRemainingSecs', () => {
  it('is the full TTL right after minting', () => {
    expect(pairingRemainingSecs(1_000, 1_000)).toBe(TOKEN_TTL_SECS)
  })

  it('counts down as time passes', () => {
    expect(pairingRemainingSecs(1_000, 1_300)).toBe(TOKEN_TTL_SECS - 300)
  })

  it('reaches exactly 0 at the TTL boundary', () => {
    expect(pairingRemainingSecs(1_000, 1_000 + TOKEN_TTL_SECS)).toBe(0)
  })

  it('floors at 0 rather than going negative past expiry', () => {
    expect(pairingRemainingSecs(1_000, 1_000 + TOKEN_TTL_SECS + 500)).toBe(0)
  })
})
