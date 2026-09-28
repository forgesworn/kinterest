// Only the PURE parts of signetConnect.ts are tested here. The journeys
// themselves reach `signet-login` through `await import()`, so importing this
// module in the vitest node environment loads nothing browser-only — but
// running those functions would, which is why only the mapper is exercised.

import { describe, expect, it } from 'vitest'
import { classifyRecoveryLogin, recoveryMiss } from './signetConnect'

describe('classifyRecoveryLogin', () => {
  it('tells a cancelled picker apart from an auth-only session', () => {
    // Load-bearing: these need different copy. "We could not find a family"
    // for someone who simply changed their mind is a lie, and it sends them
    // hunting for a backup that is sitting there perfectly well.
    expect(classifyRecoveryLogin(null)).toBe('cancelled')
    expect(classifyRecoveryLogin({ full: false })).toBe('needs-full-signer')
  })

  it('passes a full session through', () => {
    expect(classifyRecoveryLogin({ full: true })).toBeNull()
  })
})

// A flooded public inbox is not the same as no backup at all.
describe('recoveryMiss', () => {
  it('says too-many-candidates when wraps went unopened, no-vault otherwise', () => {
    expect(recoveryMiss(true)).toBe('too-many-candidates')
    expect(recoveryMiss(false)).toBe('no-vault')
  })
})
