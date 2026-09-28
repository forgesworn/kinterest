import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { authorityRequest, parentPresenceRequest, verifyParentPresence, deviceStatementTemplate, verifyChildConsent, verifyFamilyAuthority } from './familyAuthority'

const rootSk = generateSecretKey(), childSk = generateSecretKey()
const rootPk = getPublicKey(rootSk), childPk = getPublicKey(childSk), family = getPublicKey(generateSecretKey()), device = getPublicKey(generateSecretKey())
const challenge = '1'.repeat(64), now = 1756800000
const confirmed = (template: EventTemplate) => ({ ...template, tags: template.tags.map(t => t[0] === 'approval' ? ['approval', 'confirmed'] : t) })
const request = authorityRequest(family, challenge, now)
const childRequest = authorityRequest(family, challenge, now, { identityPk: childPk, devicePk: device, role: 'child-phone' })
const statement = finalizeEvent(deviceStatementTemplate(family, childPk, device, 'child-phone', now), childSk)
const childConsent = { v: 2, familyPk: family, identityPk: childPk, devicePk: device, name: 'Test child', role: 'child-phone', statement }
const consent = () => finalizeEvent({ ...confirmed(childRequest), content: JSON.stringify(childConsent) }, rootSk)

describe('explicit My Signet family authority', () => {
  it('uses a separate explicit parent PIN reset ceremony and fresh challenge', () => {
    const event = finalizeEvent(confirmed(parentPresenceRequest(family,challenge,now)),rootSk)
    expect(verifyParentPresence(event,rootPk,family,challenge)).toBe(true)
    expect(verifyParentPresence(event,rootPk,family,'2'.repeat(64))).toBe(false)
    expect(verifyFamilyAuthority(event,rootPk,family,challenge)).toBe(false)
  })
  it('rejects an older generic signer which signed the unchanged request', () => {
    expect(verifyFamilyAuthority(finalizeEvent(request, rootSk), rootPk, family, challenge)).toBe(false)
    expect(verifyFamilyAuthority(finalizeEvent(confirmed(request), rootSk), rootPk, family, challenge)).toBe(true)
  })
  it('refuses duplicate singleton tags, substituted signers, families and challenges', () => {
    const good = finalizeEvent(confirmed(request), rootSk)
    expect(verifyFamilyAuthority(good, childPk, family)).toBe(false)
    expect(verifyFamilyAuthority(good, rootPk, childPk)).toBe(false)
    expect(verifyFamilyAuthority(good, rootPk, family, '2'.repeat(64))).toBe(false)
    expect(verifyFamilyAuthority(finalizeEvent({ ...confirmed(request), tags: [...confirmed(request).tags, ['approval', 'confirmed']] }, rootSk), rootPk, family)).toBe(false)
  })
  it('requires the root and child to sign their own distinct bindings', () => {
    expect(verifyChildConsent(consent(), rootPk, family, { challenge, identityPk: childPk, devicePk: device, role: 'child-phone' })?.name).toBe('Test child')
    expect(verifyChildConsent(consent(), childPk, family)).toBeNull()
    expect(verifyChildConsent(consent(), rootPk, family, { challenge, identityPk: childPk, devicePk: childPk, role: 'child-phone' })).toBeNull()
    const forged = finalizeEvent({ ...confirmed(childRequest), content: JSON.stringify({ ...childConsent, statement: finalizeEvent(deviceStatementTemplate(family, childPk, device, 'child-phone', now), rootSk) }) }, rootSk)
    expect(verifyChildConsent(forged, rootPk, family)).toBeNull()
  })
  it('rejects edited signed profiles even if a verification cache was copied with them', () => {
    const good = consent()
    expect(verifyChildConsent(good, rootPk, family)).not.toBeNull()
    expect(verifyChildConsent({ ...good, content: JSON.stringify({ ...childConsent, name: 'Changed' }) }, rootPk, family)).toBeNull()
  })
})
