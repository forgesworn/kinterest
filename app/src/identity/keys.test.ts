import { describe, it, expect } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { newKeypair, npubOf, bytesToHex, hexToBytes } from './keys'

describe('newKeypair', () => {
  it('returns a 32-byte secret key and its matching lowercase-hex pubkey', () => {
    const { sk, pk } = newKeypair()
    expect(sk).toHaveLength(32)
    expect(pk).toMatch(/^[0-9a-f]{64}$/)
    expect(pk).toBe(getPublicKey(sk))
  })

  it('generates a different keypair on every call', () => {
    const a = newKeypair()
    const b = newKeypair()
    expect(a.pk).not.toBe(b.pk)
    expect(bytesToHex(a.sk)).not.toBe(bytesToHex(b.sk))
  })
})

describe('npubOf', () => {
  it('bech32-encodes a hex pubkey as npub1…', () => {
    const { pk } = newKeypair()
    const npub = npubOf(pk)
    expect(npub).toMatch(/^npub1[a-z0-9]+$/)
  })

  it('is deterministic for the same pubkey', () => {
    const { pk } = newKeypair()
    expect(npubOf(pk)).toBe(npubOf(pk))
  })
})

describe('hexToBytes/bytesToHex re-exports', () => {
  it('round-trip', () => {
    const { sk } = newKeypair()
    const hex = bytesToHex(sk)
    expect(hexToBytes(hex)).toEqual(sk)
  })
})
