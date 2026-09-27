import { describe, expect, it } from 'vitest'
import { sasDigits } from './sas'

const GUARDIAN_PK = 'a'.repeat(64)
const TOKEN = 'b'.repeat(32)

describe('sasDigits', () => {
  it('formats as two groups of three digits', async () => {
    const code = await sasDigits(GUARDIAN_PK, TOKEN)
    expect(code).toMatch(/^\d{3} \d{3}$/)
  })

  it('is deterministic for the same inputs', async () => {
    const a = await sasDigits(GUARDIAN_PK, TOKEN)
    const b = await sasDigits(GUARDIAN_PK, TOKEN)
    expect(a).toBe(b)
  })

  it('is case-insensitive on the guardian pubkey', async () => {
    const lower = await sasDigits(GUARDIAN_PK, TOKEN)
    const upper = await sasDigits(GUARDIAN_PK.toUpperCase(), TOKEN)
    expect(upper).toBe(lower)
  })

  it('differs when the token differs', async () => {
    const a = await sasDigits(GUARDIAN_PK, TOKEN)
    const b = await sasDigits(GUARDIAN_PK, 'c'.repeat(32))
    expect(a).not.toBe(b)
  })

  it('differs when the guardian pubkey differs', async () => {
    const a = await sasDigits(GUARDIAN_PK, TOKEN)
    const b = await sasDigits('d'.repeat(64), TOKEN)
    expect(a).not.toBe(b)
  })
})
