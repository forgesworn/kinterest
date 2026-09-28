import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { guardianFromMnemonic, generateMnemonic } from './derive'
import { authorityRequest } from './familyAuthority'
import { prepareFamilyBackup, publishFamilyBackup, recoverFamilyCheckpoint, familyCheckpointSignature } from './familyBackup'
import { vaultPayloadFor, vaultRosterOf, pickFamilyVault } from './signetVault'
import { emptyState } from '../state/state'
import { creditEntry, balances } from '../domain/ledger'
import { correctionEntries, appendCorrection } from '../domain/corrections'
import { makeFakeRelay } from '../wire/fakeRelay'
import { unwrapFrom } from '../wire/giftwrap'
import { parseVaultPayload } from '../wire/payloads'
import { saveState, loadState, type StorageLike } from '../state/persist'
import { republishVaultIfDue, readVaultPublished } from '../store/vaultRepublish'
const now = 1756800000
function storage():StorageLike { const data=new Map<string,string>();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>{data.set(k,v)},removeItem:k=>{data.delete(k)}} }
function fixture() {
  const mnemonic=generateMnemonic(),guardian=guardianFromMnemonic(mnemonic),rootSk=generateSecretKey(),root=getPublicKey(rootSk),child=getPublicKey(generateSecretKey())
  const template=authorityRequest(guardian.pk,'1'.repeat(64),now)
  const auth=finalizeEvent({...template,tags:template.tags.map(t=>t[0]==='approval'?['approval','confirmed']:t)},rootSk)
  const account={id:'a',child,name:'Pot',currency:'GBP',custody:'ledger' as const}
  const original=creditEntry({id:'e',child,author:'guardian',createdAt:now},account,500)
  const bundle=correctionEntries(original,{id:'fix',child,author:'guardian',createdAt:now+1},'Wrong amount',[350])
  const app={...emptyState(),role:'guardian' as const,guardianPubkey:guardian.pk,self:{pubkey:guardian.pk,childIndex:null},root:{kind:'signet' as const,pubkey:root,authEvent:auth,backedUpAt:null},children:[{pubkey:child,name:'Test child',index:0}],entries:appendCorrection([original],[account],bundle),pendingCorrections:[bundle]}
  app.docs.accounts={v:1,issuedAt:now,accounts:[account],revoked:{[getPublicKey(generateSecretKey())]:now}}
  app.docHighWater.accounts=now
  const vault=vaultPayloadFor(vaultRosterOf(app),mnemonic,guardian.pk,auth,now)
  return {app,vault,guardian,rootSk,root}
}
describe('complete family checkpoints',()=>{
  it('recovers phone-less money, corrections, policy and delivery intents after parent loss',async()=>{
    const {app,vault,guardian,root,rootSk}=fixture(),relay=makeFakeRelay(),mem=storage()
    const sent=await publishFamilyBackup(app,vault,{selfSk:guardian.sk,rootPk:root,relay,storage:mem,nowSec:now})
    expect(sent.sent).toBe(true)
    const opened=unwrapFrom({wrap:relay.events.at(-1)!,recipientSk:rootSk,expectedAuthorPk:guardian.pk})!
    const manifest=parseVaultPayload(opened.payload)!
    expect(manifest.children).toEqual([])
    expect(manifest.checkpoint).toBeDefined()
    expect(pickFamilyVault([{payload:opened.payload,createdAt:now,authorPk:root}],root,()=>true,()=>guardian.pk).kind).toBe('none')
    const restored=await recoverFamilyCheckpoint(manifest.checkpoint!,guardian.sk,relay,100,root)
    expect(restored?.entries).toEqual(app.entries)
    expect(restored?.pendingCorrections).toEqual(app.pendingCorrections)
    expect(restored?.docs).toEqual(app.docs)
    expect(balances(restored!.entries!).get('a')).toBe(350)
  })
  it('publishes the manifest after all chunks, retaining immutable encrypted jobs offline',async()=>{
    const {app,vault,guardian,root}=fixture(),relay=makeFakeRelay(),mem=storage()
    relay.goOffline()
    const opts={selfSk:guardian.sk,rootPk:root,relay,storage:mem,nowSec:now}
    expect((await publishFamilyBackup(app,vault,opts)).sent).toBe(false)
    const job=mem.getItem('kinjar.familyBackup.job.v2')!
    expect(job).not.toContain(vault.mnemonic)
    expect(relay.events).toHaveLength(0)
    const changed={...app,entries:[...app.entries,creditEntry({id:'next',child:app.children[0]!.pubkey,author:'guardian',createdAt:now+2},app.docs.accounts.accounts[0]!,100)]}
    relay.goOnline()
    const retry=await publishFamilyBackup(changed,vault,opts)
    expect(retry.signature).toBe(familyCheckpointSignature(app))
    expect(retry.signature).not.toBe(familyCheckpointSignature(changed))
    const old=JSON.parse(job)
    expect(relay.events.map(e=>e.id)).toEqual([...old.chunks.map((e:{id:string})=>e.id),old.manifest.id])
    const next=await publishFamilyBackup(changed,vault,opts)
    expect(next.revision).toBe(retry.revision+1)
    expect(next.signature).toBe(familyCheckpointSignature(changed))
  })
  it('bounds envelopes and recovers a multi-chunk checkpoint',async()=>{
    const {app,vault,guardian,root,rootSk}=fixture()
    app.children[0]!.name='A'.repeat(20000)
    const job=prepareFamilyBackup(app,vault,guardian.sk,root,2,now),relay=makeFakeRelay()
    expect(job.chunks.length).toBeGreaterThan(1)
    for(const e of [...job.chunks,job.manifest]){expect(new TextEncoder().encode(JSON.stringify(e)).length).toBeLessThan(60*1024);await relay.publish(e)}
    const manifest=parseVaultPayload(unwrapFrom({wrap:job.manifest,recipientSk:rootSk})!.payload)!
    expect((await recoverFamilyCheckpoint(manifest.checkpoint!,guardian.sk,relay,100,root))?.children).toEqual(app.children)
    const missing=makeFakeRelay();await missing.publish(job.chunks[0]!)
    expect(await recoverFamilyCheckpoint(manifest.checkpoint!,guardian.sk,missing,10,root)).toBeNull()
    expect(await recoverFamilyCheckpoint({...manifest.checkpoint!,sha256:'0'.repeat(64)},guardian.sk,relay,100,root)).toBeNull()
  })
  it('keeps a committed correction publish intent through a restart before its first send',()=>{
    const {app}=fixture(),mem=storage();saveState(app,mem)
    const restored=loadState(mem,now)
    expect(restored.pendingCorrections).toEqual(app.pendingCorrections)
    expect(balances(restored.entries).get('a')).toBe(350)
  })
})


it('drains an older offline checkpoint and backs up the current balance in the same production retry', async () => {
  const { app, vault, guardian, root, rootSk } = fixture(), relay = makeFakeRelay(), mem = storage()
  relay.goOffline()
  await publishFamilyBackup(app, vault, { selfSk: guardian.sk, rootPk: root, relay, storage: mem, nowSec: now })
  const current = { ...app, entries: [...app.entries, creditEntry({ id: 'later', child: app.children[0]!.pubkey, author: 'guardian', createdAt: now + 2 }, app.docs.accounts.accounts[0]!, 100)] }
  relay.goOnline()
  expect(await republishVaultIfDue({ getApp: () => current, guardianSk: guardian.sk, relay, storage: mem,
    record: mem, nowSec: now + 3, loadMnemonic: async () => vault.mnemonic, inFlight: { current: null } })).toBe(now + 3)
  expect(readVaultPublished(mem)).not.toBeNull()
  const manifest = parseVaultPayload(unwrapFrom({ wrap: relay.events.at(-1)!, recipientSk: rootSk })!.payload)!
  const recovered = await recoverFamilyCheckpoint(manifest.checkpoint!, guardian.sk, relay, 100, root)
  expect(balances(recovered!.entries!).get('a')).toBe(450)
})

it('serialises concurrent backup calls without losing a newer encrypted job', async () => {
  const { app, vault, guardian, root } = fixture(), relay = makeFakeRelay(), mem = storage()
  const changed = { ...app, entries: [...app.entries, creditEntry({ id: 'later', child: app.children[0]!.pubkey, author: 'guardian', createdAt: now + 2 }, app.docs.accounts.accounts[0]!, 100)] }
  const opts = { selfSk: guardian.sk, rootPk: root, relay, storage: mem, nowSec: now }
  const [first, second] = await Promise.all([publishFamilyBackup(app, vault, opts), publishFamilyBackup(changed, vault, opts)])
  expect(first.sent && second.sent).toBe(true)
  expect(second.revision).toBe(first.revision + 1)
  expect(second.signature).toBe(familyCheckpointSignature(changed))
  expect(mem.getItem('kinjar.familyBackup.job.v2')).toBeNull()
})
