import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { guardianNeedsSignet } from './guardianAccess'
import { authorityRequest } from './familyAuthority'
import type { AppState } from '../state/types'

const signetSk = generateSecretKey()
const guardianPk = getPublicKey(generateSecretKey())
const otherGuardianPk = getPublicKey(generateSecretKey())
function bound(guardian = guardianPk): Pick<AppState, 'role' | 'root' | 'guardianPubkey'> {
  return {
    role: 'guardian', guardianPubkey: guardianPk,
    root: { kind: 'signet', pubkey: getPublicKey(signetSk), backedUpAt: null,
      authEvent: finalizeEvent({ ...authorityRequest(guardian, '1'.repeat(64), 1756800000), tags: authorityRequest(guardian, '1'.repeat(64), 1756800000).tags.map(t => t[0] === 'approval' ? ['approval', 'confirmed'] : t) }, signetSk) },
  }
}

describe('mandatory guardian Signet access', () => {
  it('holds existing unbound families, including cancelled word recovery, without changing their identity', () => {
    for (const root of [null, { kind: 'phrase' } as const]) {
      const app = { role: 'guardian' as const, guardianPubkey: guardianPk, root }
      expect(guardianNeedsSignet(app)).toBe(true)
      expect(app.guardianPubkey).toBe(guardianPk)
    }
  })
  it('permits offline operation with a saved verified binding, even before backup publication', () => {
    expect(guardianNeedsSignet(bound())).toBe(false)
  })
  it('rejects forged bindings and bindings to another family', () => {
    expect(guardianNeedsSignet(bound(otherGuardianPk))).toBe(true)
    const app = bound()
    if (app.root?.kind === 'signet') app.root.authEvent = { ...app.root.authEvent, sig: '0'.repeat(128) }
    expect(guardianNeedsSignet(app)).toBe(true)
    expect(guardianNeedsSignet({ ...bound(), guardianPubkey: null })).toBe(true)
  })
  it('does not require Signet for child devices or before a parent has been created', () => {
    expect(guardianNeedsSignet({ role: 'child', root: null, guardianPubkey: guardianPk })).toBe(false)
    expect(guardianNeedsSignet({ role: 'unset', root: null, guardianPubkey: null })).toBe(false)
  })
})
