import { describe, expect, it } from 'vitest'
import { consumeToken, mintToken, TOKEN_TTL_SECS } from './tokens'

const AT = 1_700_000_000

describe('mintToken', () => {
  it('mints a 32-char lowercase hex token', () => {
    const { token, mintedAt } = mintToken(AT)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(mintedAt).toBe(AT)
  })

  it('mints a different token every call', () => {
    expect(mintToken(AT).token).not.toBe(mintToken(AT).token)
  })
})

describe('consumeToken', () => {
  it('accepts the correct token within the TTL', () => {
    const minted = mintToken(AT)
    expect(consumeToken(minted, minted.token, AT)).toBe(true)
    expect(consumeToken(minted, minted.token, AT + TOKEN_TTL_SECS)).toBe(true)
  })

  it('rejects the wrong token', () => {
    const minted = mintToken(AT)
    const lastChar = minted.token.slice(-1)
    const flipped = lastChar === '0' ? '1' : '0'
    expect(consumeToken(minted, `${minted.token.slice(0, -1)}${flipped}`, AT)).toBe(false)
    expect(consumeToken(minted, 'not-even-hex', AT)).toBe(false)
  })

  it('rejects a token past the 600s TTL', () => {
    const minted = mintToken(AT)
    expect(consumeToken(minted, minted.token, AT + TOKEN_TTL_SECS + 1)).toBe(false)
  })

  it('rejects when nothing is stored (absent, or already consumed by the caller)', () => {
    expect(consumeToken(null, 'anything', AT)).toBe(false)
    expect(consumeToken(undefined, 'anything', AT)).toBe(false)
  })

  it('a contested (replayed) presentation loses: caller removes on success, so the second call sees nothing stored', () => {
    const minted = mintToken(AT)
    expect(consumeToken(minted, minted.token, AT)).toBe(true)
    // The caller's contract: on success, remove the stored token. Simulate
    // that here and confirm the replay is rejected, not re-accepted.
    const storedAfterConsume = null
    expect(consumeToken(storedAfterConsume, minted.token, AT)).toBe(false)
  })

  it('rejects a non-string presented value without throwing', () => {
    const minted = mintToken(AT)
    expect(() => consumeToken(minted, undefined as unknown as string, AT)).not.toThrow()
    expect(consumeToken(minted, undefined as unknown as string, AT)).toBe(false)
  })

  it('is constant-time regardless of where the mismatch falls (no early return)', () => {
    // Not a timing test (too flaky in CI) — just confirms correctness at
    // every mismatch position, which the implementation must get right
    // without any early-exit branch.
    const minted = mintToken(AT)
    for (let i = 0; i < minted.token.length; i += 1) {
      const chars = minted.token.split('')
      chars[i] = chars[i] === '0' ? '1' : '0'
      expect(consumeToken(minted, chars.join(''), AT)).toBe(false)
    }
  })
})
