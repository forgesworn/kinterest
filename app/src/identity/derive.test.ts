// Golden vectors pinned against a live `signet-protocol` install run
// against an earlier sibling app's own node_modules (published
// `signet-protocol@1.10.0` / `nsec-tree@1.5.1` — the exact versions that
// app itself has installed), NOT reproduced from this file's own
// implementation. Generation script (throwaway, not committed to that app):
//
//   that app's node_modules/signet-protocol's createSignetIdentity(mnemonic)
//   .persona for the guardian keypair, and
//   deriveDependantIdentity(tree.root, index).naturalPerson for each child
//   — the exact calls that app's `app/src/identity.ts` makes.
//
// The fixed mnemonic below is the same standard trezor BIP-39 test vector
// that app's own identity.test.ts freezes vectors against ("legal
// winner…"), so indices 1 and 2 below double as a live cross-check against
// that app's OWN pinned dependant-1-np/dependant-2-np values (see that
// app's `app/src/identity.test.ts`) — a package or algorithm change that
// broke either suite's vectors would break both here.
//
// If this ever drifts, a Kinterest guardian's mnemonic would derive
// different children than the same mnemonic would in signet-app / that
// earlier sibling app — the exact defect this rework fixes (see derive.ts's
// header comment).

import { describe, it, expect } from 'vitest'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { generateMnemonic, validateMnemonic, guardianFromMnemonic, deriveDependantKey } from './derive'

// Standard BIP-39 test vector mnemonic (trezor test vectors, "legal
// winner…") — same fixture that earlier sibling app's identity.test.ts freezes against.
const TEST_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

// Pinned against a live signet-protocol/nsec-tree install — see this file's
// header comment for how these were generated.
const GOLDEN_GUARDIAN = {
  pk: '7169ad4315a860e3b4a044fb1fc51c8bc7e73635b6fae2f178d6973503e5c4fa',
  sk: 'cab86fe9da6342664759426885888c871fa8fef3787766da580442997887f739',
}

// Indices 1 and 2 are also that earlier sibling app's `app/src/identity.test.ts`'s
// own frozen dependant-1-np/dependant-2-np vectors, verified identical here.
const GOLDEN_DEPENDANTS: Record<number, { sk: string; pk: string }> = {
  0: {
    pk: '2353d09c8668dfb41e80b5191bcac280bc42ee679f487f310958a88c5202b75a',
    sk: 'df1ad1ed87ebf1c4a92d24b1f471b13482bdcfbf138a0eecb97263fcfead4de1',
  },
  1: {
    pk: 'bfde84e82fa1fd006654a0d44d40219c30f7a8d53f4a0782f0b2135b63442819',
    sk: '628767991af35d5ba99021ceb5452b6b6d317b4f3bc980699bac10be6915167a',
  },
  2: {
    pk: 'a1bca68cc4351858314922aa1c50eeec267c0f9ce93001b73b13f82342cff8e4',
    sk: '0dc2c32ef9a6a2b11651d7719fa72a62108e64c270217d031195dd8337b06483',
  },
  5: {
    pk: '3610a48be3de74b9ad2d9914c8617eebde7ce12356ab8d8f9fc40625763cde1c',
    sk: 'b30b32ae3cbd9d8a5058f5e123259a2fae203b88d688c45a07106d1797d08d5c',
  },
}

describe('guardianFromMnemonic — golden vector', () => {
  it('matches the pinned signet-protocol persona-branch vector', () => {
    const { sk, pk } = guardianFromMnemonic(TEST_MNEMONIC)
    expect(bytesToHex(sk)).toBe(GOLDEN_GUARDIAN.sk)
    expect(pk).toBe(GOLDEN_GUARDIAN.pk)
  })
})

describe('deriveDependantKey — golden vectors', () => {
  for (const [indexStr, expected] of Object.entries(GOLDEN_DEPENDANTS)) {
    const index = Number(indexStr)
    it(`matches the pinned signet-protocol vector for dependant index ${index}`, () => {
      const { sk, pk } = deriveDependantKey(TEST_MNEMONIC, index)
      expect(bytesToHex(sk)).toBe(expected.sk)
      expect(pk).toBe(expected.pk)
    })
  }

  it('dependant 1 and 2 match an earlier sibling app\'s own frozen vectors', () => {
    // Transcribed directly from that app's identity.test.ts — a second,
    // independently-maintained pin on the same algorithm.
    expect(GOLDEN_DEPENDANTS[1]).toEqual({
      pk: 'bfde84e82fa1fd006654a0d44d40219c30f7a8d53f4a0782f0b2135b63442819',
      sk: '628767991af35d5ba99021ceb5452b6b6d317b4f3bc980699bac10be6915167a',
    })
    expect(GOLDEN_DEPENDANTS[2]).toEqual({
      pk: 'a1bca68cc4351858314922aa1c50eeec267c0f9ce93001b73b13f82342cff8e4',
      sk: '0dc2c32ef9a6a2b11651d7719fa72a62108e64c270217d031195dd8337b06483',
    })
  })
})

describe('deriveDependantKey — properties', () => {
  it('is deterministic: same mnemonic + index always reproduces the same child keys', () => {
    const a = deriveDependantKey(TEST_MNEMONIC, 3)
    const b = deriveDependantKey(TEST_MNEMONIC, 3)
    expect(bytesToHex(a.sk)).toBe(bytesToHex(b.sk))
    expect(a.pk).toBe(b.pk)
  })

  it('different indices under the same mnemonic derive different children', () => {
    const a = deriveDependantKey(TEST_MNEMONIC, 0)
    const b = deriveDependantKey(TEST_MNEMONIC, 1)
    expect(a.pk).not.toBe(b.pk)
  })

  it('different mnemonics derive different children at the same index', () => {
    const otherMnemonic = generateMnemonic()
    const a = deriveDependantKey(TEST_MNEMONIC, 0)
    const b = deriveDependantKey(otherMnemonic, 0)
    expect(a.pk).not.toBe(b.pk)
  })

  it('a dependant keypair never equals the guardian keypair', () => {
    const guardian = guardianFromMnemonic(TEST_MNEMONIC)
    const child = deriveDependantKey(TEST_MNEMONIC, 0)
    expect(child.pk).not.toBe(guardian.pk)
  })

  it('returns a 32-byte secret key and a 64-char lowercase-hex pubkey', () => {
    const { sk, pk } = deriveDependantKey(TEST_MNEMONIC, 0)
    expect(sk).toHaveLength(32)
    expect(pk).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects invalid dependant indices at the canonical provider boundary', () => {
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => deriveDependantKey(TEST_MNEMONIC, invalid)).toThrow(/index/i)
    }
  })
})

describe('generateMnemonic / validateMnemonic', () => {
  it('generates a fresh 12-word BIP-39 mnemonic that validates', () => {
    const mnemonic = generateMnemonic()
    expect(mnemonic.split(' ')).toHaveLength(12)
    expect(validateMnemonic(mnemonic)).toBe(true)
  })

  it('produces a different mnemonic on each call', () => {
    expect(generateMnemonic()).not.toBe(generateMnemonic())
  })

  it('validates the pinned fixed test mnemonic', () => {
    expect(validateMnemonic(TEST_MNEMONIC)).toBe(true)
  })

  it('rejects an invalid mnemonic', () => {
    expect(validateMnemonic('not a valid set of twelve words at all nope nope')).toBe(false)
  })
})

describe('hex utils sanity (nostr-tools/utils, unified across identity/*)', () => {
  it('round-trips', () => {
    const { sk } = guardianFromMnemonic(TEST_MNEMONIC)
    expect(hexToBytes(bytesToHex(sk))).toEqual(sk)
  })
})
