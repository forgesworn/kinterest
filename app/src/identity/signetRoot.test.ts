// Pure attestation logic (v0.2 spec §1.3). Deliberately imports NOTHING from
// `signet-login` — this file runs in the vitest node environment, where that
// package's root entry touches `document`/`window` at import time.

import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { rootChallenge, verifyRootAttestation } from './signetRoot'

const signetSk = generateSecretKey()
const signetPk = getPublicKey(signetSk)
const guardianPk = getPublicKey(generateSecretKey())
const otherPk = getPublicKey(generateSecretKey())

function attest(challenge: string, sk = signetSk, kind = 21236, createdAt = 1756800000) {
  return finalizeEvent(
    {
      kind,
      created_at: createdAt,
      content: '',
      tags: [
        ['challenge', challenge],
        ['origin', 'https://example.test'],
        ['app', 'Jar'],
      ],
    },
    sk,
  )
}

describe('rootChallenge', () => {
  it('is 64 lowercase hex, deterministic, and key-specific', () => {
    const c = rootChallenge(guardianPk)
    expect(c).toMatch(/^[0-9a-f]{64}$/)
    expect(rootChallenge(guardianPk)).toBe(c)
    expect(rootChallenge(otherPk)).not.toBe(c)
  })
})

describe('verifyRootAttestation', () => {
  it('accepts a well-formed attestation', () => {
    expect(verifyRootAttestation(attest(rootChallenge(guardianPk)), signetPk, guardianPk)).toBe(true)
  })
  it('rejects a wrong signet pubkey, wrong guardian key, wrong kind, wrong challenge', () => {
    const ev = attest(rootChallenge(guardianPk))
    expect(verifyRootAttestation(ev, otherPk, guardianPk)).toBe(false)
    expect(verifyRootAttestation(ev, signetPk, otherPk)).toBe(false)
    expect(verifyRootAttestation(attest(rootChallenge(guardianPk), signetSk, 21237), signetPk, guardianPk)).toBe(false)
    expect(verifyRootAttestation(attest('0'.repeat(64)), signetPk, guardianPk)).toBe(false)
  })
  it('rejects a tampered content or signature', () => {
    expect(verifyRootAttestation({ ...attest(rootChallenge(guardianPk)), content: 'x' }, signetPk, guardianPk)).toBe(false)
    expect(verifyRootAttestation({ ...attest(rootChallenge(guardianPk)), sig: 'f'.repeat(128) }, signetPk, guardianPk)).toBe(false)
  })
  it('deliberately ignores origin and age', () => {
    const old = attest(rootChallenge(guardianPk), signetSk, 21236, 1000000000)
    expect(verifyRootAttestation(old, signetPk, guardianPk)).toBe(true)
  })
  it('is total', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}]) {
      expect(() => verifyRootAttestation(bad, signetPk, guardianPk)).not.toThrow()
      expect(verifyRootAttestation(bad, signetPk, guardianPk)).toBe(false)
    }
  })
})

// The origin tag is written by the requesting site, so checking it
// defends nothing and breaks recovery across origins (PWA vs Android shell).
describe('verifyRootAttestation ignores the origin tag', () => {
  it('verifies an attestation whatever origin it was signed from', () => {
    for (const origin of ['https://shell.example', 'https://pwa.example', 'http://localhost:5173']) {
      const ev = finalizeEvent(
        { kind: 21236, created_at: 1756800000, content: '', tags: [['challenge', rootChallenge(guardianPk)], ['origin', origin]] },
        signetSk,
      )
      expect(verifyRootAttestation(ev, signetPk, guardianPk)).toBe(true)
    }
  })
})
