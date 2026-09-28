import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { emptyState, mergeConfigDoc } from '../state/state'
import { authorityRequest, deviceStatementTemplate } from './familyAuthority'
import { admitSignetChild, childForDevice, deviceGrant, historicalChildForDevice, replaceChildPhone, validDevice } from './devices'
import { scopeSnapshotState, grantsFor } from '../sync/snapshot'
import { applySnapshot, dispatchInner } from '../sync/ingress'
import { buildSnapshotPayload } from '../wire/payloads'
import { KIND_REQUEST } from '../wire/kinds'
import { startAsChildFromOffer } from '../state/onboarding'

const guardianSk = generateSecretKey(), rootSk = generateSecretKey(), childSk = generateSecretKey()
const guardian = getPublicKey(guardianSk), root = getPublicKey(rootSk), identity = getPublicKey(childSk)
const now = 1756800000
function consent(devicePk: string, role: 'shared-phone' | 'child-phone', signer = rootSk) {
  const t = authorityRequest(guardian, '1'.repeat(64), now, { identityPk: identity, devicePk, role })
  return finalizeEvent({ ...t, tags: t.tags.map(t => t[0] === 'approval' ? ['approval', 'confirmed'] : t), content: JSON.stringify({ v: 2, familyPk: guardian, identityPk: identity, devicePk, role, name: 'Test child', statement: finalizeEvent(deviceStatementTemplate(guardian, identity, devicePk, role, now), childSk) }) }, signer)
}
function family() {
  const auth = authorityRequest(guardian, '2'.repeat(64), now)
  return { ...emptyState(), role: 'guardian' as const, guardianPubkey: guardian, root: { kind: 'signet' as const, pubkey: root, backedUpAt:null, authEvent: finalizeEvent({ ...auth, tags: auth.tags.map(t => t[0] === 'approval' ? ['approval','confirmed'] : t) }, rootSk) } }
}
function linked() { const shared = getPublicKey(generateSecretKey()); return { app: admitSignetChild(family(), consent(shared, 'shared-phone'), guardianSk, now), shared } }
describe('stable child identities and operational devices', () => {
  it('maps an explicit legacy alias without changing money or history', () => {
    const legacy = getPublicKey(generateSecretKey()), shared = getPublicKey(generateSecretKey())
    const old = { ...family(), children: [{ pubkey: legacy, name: 'Saved child', index: 3 }], entries: [{ v: 1 as const, id: 'e', child: legacy, kind: 'credit' as const, author: 'guardian' as const, createdAt: now, legs: [{ account: 'a', currency: 'GBP', amountMinor: 425 }] }] }
    const app = admitSignetChild(old, consent(shared,'shared-phone'), guardianSk, now, legacy)
    expect(app.entries).toBe(old.entries)
    expect(app.children[0]?.pubkey).toBe(legacy)
    expect(app.children[0]?.index).toBe(3)
    expect(childForDevice(app, legacy)).toBeNull()
    expect(childForDevice(app, shared)).toBe(legacy)
    expect(historicalChildForDevice(app, legacy, now - 1)).toBe(legacy)
    expect(() => admitSignetChild(app, consent(shared,'shared-phone'), guardianSk, now)).toThrow()
  })
  it('replaces a phone while retaining child identity, shared access and revocation', () => {
    const { app, shared } = linked(), first = getPublicKey(generateSecretKey()), second = getPublicKey(generateSecretKey())
    const one = replaceChildPhone(app, identity, consent(first,'child-phone'), guardianSk, now + 1)
    const two = replaceChildPhone(one, identity, consent(second,'child-phone'), guardianSk, now + 10)
    expect(childForDevice(two, first)).toBeNull()
    expect(childForDevice(two, second)).toBe(identity)
    expect(childForDevice(two, shared)).toBe(identity)
    expect(two.docs.accounts.deviceRevision).toBe(3)
    expect(historicalChildForDevice(two,first,now + 2)).toBe(identity)
    expect(historicalChildForDevice(two,first,now + 10)).toBeNull()
    expect(() => replaceChildPhone(two, identity, consent(first,'child-phone'), guardianSk,now + 11)).toThrow()
  })
  it('rejects unrelated consent, altered grants and duplicate credentials', () => {
    const { app, shared } = linked()
    const d = app.docs.accounts.devices![0]!
    expect(validDevice(d,guardian,root)).toBe(true)
    expect(validDevice({ ...d,child:root },guardian,root)).toBe(false)
    expect(() => deviceGrant(identity,consent(shared,'child-phone',childSk),guardianSk,root,1,now)).toThrow()
    expect(childForDevice({ ...app,docs:{...app.docs, accounts:{...app.docs.accounts,devices:[d,d]}} },shared)).toBeNull()
  })
  it('recovers device-only updates at an equal doc timestamp and never unrevokes', () => {
    const { app } = linked()
    const older = { ...app, docs: { ...app.docs, accounts: { ...app.docs.accounts, devices: [], deviceRevision: 0 } } }
    expect(mergeConfigDoc(older,'accounts',app.docs.accounts).docs.accounts.devices).toHaveLength(1)
    const removed = { ...app, docs: { ...app.docs, accounts: { ...app.docs.accounts, revoked: { [app.docs.accounts.devices![0]!.devicePk]: now } } } }
    expect(mergeConfigDoc(removed,'accounts',app.docs.accounts).docs.accounts.revoked).toEqual(removed.docs.accounts.revoked)
  })
  it('blocks sibling asks before effects or notifications can be raised', () => {
    const { app, shared } = linked()
    const r = { v:1,op:'spend.request',reqId:'req',nonce:'nonce',child:root,ts:now,params:{account:'a',currency:'GBP',amountMinor:1} }
    expect(dispatchInner(app,KIND_REQUEST,r,shared,now).effects).toEqual([])
    expect(dispatchInner(app,KIND_REQUEST,{...r,child:identity},shared,now).effects).toHaveLength(1)
  })
  it('carries scoped historical activity and decisions on a replacement snapshot', () => {
    const { app, shared } = linked()
    app.docs.chores.issuedAt = now
    app.docs.chores.chores = [{ id:'job',child:identity,name:'Test job',cadence:'daily' }]
    app.docs.accounts.accounts = [{ id:'a',child:identity,name:'Pot',currency:'GBP',custody:'physical' }]
    app.ticks = [{ id:'t',chore:'job',day:'2026-09-02',at:now }]
    app.audits = [{ id:'audit',child:identity,account:'a',author:'child',countedMinor:1,expectedMinor:0,deltaMinor:1,at:now }]
    app.requests = [{ request:{v:1,op:'spend.request',reqId:'req',nonce:'nonce',child:identity,ts:now,params:{}},authorPk:shared,status:'denied',createdAt:now }]
    const snapshot = scopeSnapshotState(app,shared)
    expect(snapshot.ticks).toEqual(app.ticks)
    expect(snapshot.audits).toEqual(app.audits)
    expect(grantsFor(app,identity)).toHaveLength(1)
    const restored = applySnapshot({ ...emptyState(),role:'child',self:{pubkey:identity,childIndex:0} },buildSnapshotPayload(snapshot),now)
    expect(restored.ticks).toEqual(app.ticks)
    expect(restored.audits).toEqual(app.audits)
  })
  it('never accepts a replacement into a different saved family', () => {
    const { app } = linked(), sk = generateSecretKey(), device = getPublicKey(sk)
    const paired = replaceChildPhone(app,identity,consent(device,'child-phone'),guardianSk,now)
    const offer = { v:1 as const,childSkHex:'',childIndex:0,name:'Test child',relays:[],device:paired.docs.accounts.devices!.at(-1)!,snapshot:buildSnapshotPayload(scopeSnapshotState(paired,identity)),root:{pubkey:root,authEvent:app.root?.kind === 'signet' ? app.root.authEvent : (() => { throw new Error('Expected root') })()} }
    const old = { ...emptyState(),role:'child' as const,guardianPubkey:root,self:{pubkey:identity,childIndex:0} }
    expect(startAsChildFromOffer(old,offer,guardian,now,sk)).toBeNull()
  })
})


it('retries a completed new-child admission without duplicating identity or grants', () => {
  const device = getPublicKey(generateSecretKey()), proof = consent(device, 'shared-phone')
  const app = admitSignetChild(family(), proof, guardianSk, now)
  expect(admitSignetChild(app, proof, guardianSk, now + 1)).toBe(app)
})
