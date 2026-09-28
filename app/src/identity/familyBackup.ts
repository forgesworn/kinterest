import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from 'nostr-tools/utils'
import { getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import type { AppState } from '../state/types'
import { emptyState } from '../state/state'
import { loadState, type StorageLike } from '../state/persist'
import { assertEntryAgainst, assertReversalOf, balances } from '../domain/ledger'
import { appendCorrection } from '../domain/corrections'
import { wrapFor, unwrapFrom } from '../wire/giftwrap'
import { KIND_VAULT, WRAP } from '../wire/kinds'
import type { RelayLike } from '../wire/relayClient'
import { parseSnapshotPayload } from '../wire/payloads'
import { validDevice } from './devices'
import { wireEvent, verifyChildConsent } from './familyAuthority'
import type { VaultPayload } from '../wire/payloads'
import { IndexedDataStorage, flushDataStorage } from '../platform/dataStorage'

export const BACKUP_CHUNK_BYTES = 16 * 1024
export const MAX_BACKUP_CHUNKS = 256
const JOB_KEY = 'kinjar.familyBackup.job.v2', REVISION_KEY = 'kinjar.familyBackup.revision.v2'
export interface BackupReference { v:2; id:string; revision:number; bytes:number; sha256:string; chunkIds:string[] }
interface Chunk { v:2; type:'family-backup-chunk'; backupId:string; guardianPk:string; index:number; count:number; data:string }
interface Job { v:2; rootPk:string; signature:string; revision:number; chunks:NostrEvent[]; manifest:NostrEvent }
const HEX = /^[0-9a-f]{64}$/
const encoder = new TextEncoder()
/** Includes local-only activity, policy, immutable aliases and revocations. */
export function familyCheckpoint(app: AppState): Partial<AppState> {
  const { children,entries,docs,ticks,audits,requests,docHighWater,docChildHighWater,matchEvaluations,relays,innerEvents,pendingCorrections } = app
  return { v:1,children,entries,docs,ticks,audits,requests,docHighWater,docChildHighWater,matchEvaluations,relays,innerEvents,pendingCorrections }
}
export function familyCheckpointSignature(app: AppState): string { return bytesToHex(sha256(encoder.encode(JSON.stringify(familyCheckpoint(app))))) }
export function isBackupReference(x: unknown): x is BackupReference {
  if (!x || typeof x !== 'object') return false
  const r = x as BackupReference
  return r.v === 2 && HEX.test(r.id) && HEX.test(r.sha256) && Number.isSafeInteger(r.revision) && r.revision > 0 && Number.isSafeInteger(r.bytes) && r.bytes > 0 && r.bytes <= BACKUP_CHUNK_BYTES * MAX_BACKUP_CHUNKS && Array.isArray(r.chunkIds) && r.chunkIds.length > 0 && r.chunkIds.length <= MAX_BACKUP_CHUNKS && new Set(r.chunkIds).size === r.chunkIds.length && r.chunkIds.every(id => HEX.test(id)) && r.chunkIds.length === Math.ceil(r.bytes / BACKUP_CHUNK_BYTES)
}
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)) }
function unbase64(text: string): Uint8Array { return Uint8Array.from(atob(text),c => c.charCodeAt(0)) }

export function prepareFamilyBackup(app: AppState, vault: VaultPayload, sk: Uint8Array, rootPk: string, revision:number, nowSec:number): Job {
  if (getPublicKey(sk) !== vault.guardianPk || app.guardianPubkey !== vault.guardianPk || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid family backup identity')
  const bytes = encoder.encode(JSON.stringify(familyCheckpoint(app)))
  if (bytes.length > BACKUP_CHUNK_BYTES * MAX_BACKUP_CHUNKS) throw new Error('This family backup is too large to save. Keep this phone and export your family before replacing it.')
  const id = bytesToHex(crypto.getRandomValues(new Uint8Array(32))), count = Math.ceil(bytes.length/BACKUP_CHUNK_BYTES)
  const chunks = Array.from({length:count},(_,index) => wrapFor({innerKind:KIND_VAULT,payload:{v:2,type:'family-backup-chunk',backupId:id,guardianPk:vault.guardianPk,index,count,data:base64(bytes.slice(index*BACKUP_CHUNK_BYTES,(index+1)*BACKUP_CHUNK_BYTES))} satisfies Chunk,authorSk:sk,recipientPk:vault.guardianPk,nowSec}))
  const checkpoint: BackupReference = {v:2,id,revision,bytes:bytes.length,sha256:bytesToHex(sha256(bytes)),chunkIds:chunks.map(c=>c.id)}
  const { devices: _devices,deviceRevision:_revision,revokedDevices:_revoked,...minimal } = vault
  const manifest = wrapFor({innerKind:KIND_VAULT,payload:{...minimal,children:[],checkpoint},authorSk:sk,recipientPk:rootPk,nowSec})
  if ([...chunks,manifest].some(e=>encoder.encode(JSON.stringify(e)).length > 60*1024)) throw new Error('Family backup exceeds its message limit')
  return {v:2,rootPk,signature:familyCheckpointSignature(app),revision,chunks,manifest}
}
function validSavedJob(input: unknown, rootPk: string): input is Job {
  if (!input || typeof input !== 'object') return false
  const job = input as Job
  if (job.v !== 2 || job.rootPk !== rootPk || !HEX.test(job.signature) ||
    !Number.isSafeInteger(job.revision) || job.revision < 1 || !Array.isArray(job.chunks) ||
    job.chunks.length < 1 || job.chunks.length > MAX_BACKUP_CHUNKS) return false
  const events = [...job.chunks, job.manifest]
  if (new Set(events.map(e => e?.id)).size !== events.length) return false
  return events.every((event, index) => {
    if (!event || encoder.encode(JSON.stringify(event)).length > 60 * 1024) return false
    const checked = wireEvent(event)
    return checked?.kind === WRAP && (index !== job.chunks.length || checked.tags.some(t => t[0] === 'p' && t[1] === rootPk))
  })
}

/** Durable encrypted job. Manifest is published only after every chunk is acknowledged.
 * No completion is ever inferred from an outbox sweep or missing local event. */
async function performFamilyBackup(app:AppState,vault:VaultPayload,opts:{selfSk:Uint8Array;rootPk:string;relay:RelayLike;storage:StorageLike;nowSec:number}):Promise<{sent:boolean;signature:string;revision:number}> {
  let job:Job | null = null
  try { const saved = JSON.parse(opts.storage.getItem(JOB_KEY) ?? 'null') as Job; if (validSavedJob(saved, opts.rootPk)) job=saved } catch { /* build a fresh job */ }
  if (!job) {
    const last = Number(opts.storage.getItem(REVISION_KEY) ?? 0)
    const revision = Math.max(Number.isSafeInteger(last) ? last : 0, app.backupRevision ?? 0) + 1
    job = prepareFamilyBackup(app,vault,opts.selfSk,opts.rootPk,revision,opts.nowSec)
    opts.storage.setItem(REVISION_KEY,String(revision)); opts.storage.setItem(JOB_KEY,JSON.stringify(job))
  }
  if (opts.storage instanceof IndexedDataStorage && !await flushDataStorage(opts.storage)) throw new Error('The encrypted family backup could not be saved yet')
  let sent: boolean
  if (opts.relay.publishBackup) sent = await opts.relay.publishBackup(job.chunks,job.manifest)
  else {
    // Single-relay transports and deterministic test doubles.
    for (const chunk of job.chunks) if (await opts.relay.publish(chunk).catch(()=> 'rejected' as const) !== 'accepted') return {sent:false,signature:job.signature,revision:job.revision}
    sent = await opts.relay.publish(job.manifest).catch(()=> 'rejected' as const) === 'accepted'
  }
  if (sent) { if (JSON.parse(opts.storage.getItem(JOB_KEY) ?? 'null')?.manifest?.id === job.manifest.id) opts.storage.removeItem(JOB_KEY); if (opts.storage instanceof IndexedDataStorage) await flushDataStorage(opts.storage) }
  return {sent,signature:job.signature,revision:job.revision}
}

const deliveries = new WeakMap<StorageLike,Promise<unknown>>()
export function publishFamilyBackup(app:AppState,vault:VaultPayload,opts:Parameters<typeof performFamilyBackup>[2]):ReturnType<typeof performFamilyBackup> {
  const previous=deliveries.get(opts.storage) ?? Promise.resolve()
  const next=previous.then(()=>performFamilyBackup(app,vault,opts),()=>performFamilyBackup(app,vault,opts))
  deliveries.set(opts.storage,next.catch(()=>{}))
  return next
}

/** Read every referenced ciphertext by exact id, with local guardian decryption. */
export async function recoverFamilyCheckpoint(reference:BackupReference,guardianSk:Uint8Array,relay:RelayLike,timeoutMs=20_000,rootPk?:string):Promise<Partial<AppState> | null> {
  if (!isBackupReference(reference)) return null
  const guardian = getPublicKey(guardianSk), wanted = new Map(reference.chunkIds.map((id,index)=>[id,index]))
  const parts = new Map<number,Uint8Array>()
  return new Promise(resolve=>{
    let stop:(()=>void)|null=null,finished=false
    const finish=(result:Partial<AppState>|null)=>{if(finished)return;finished=true;clearTimeout(timer);stop?.();resolve(result)}
    const timer=setTimeout(()=>finish(null),timeoutMs)
    try { stop=relay.subscribe({kinds:[WRAP],ids:reference.chunkIds},wrap=>{
      if (finished) return
      const index=wanted.get(wrap.id)
      if(index===undefined || parts.has(index))return
      const checked=wireEvent(wrap)
      if(!checked)return
      const u=unwrapFrom({wrap:checked,recipientSk:guardianSk,expectedAuthorPk:guardian})
      const c=u?.payload as Chunk | undefined
      if(u?.innerKind!==KIND_VAULT || !c || c.v!==2 || c.type!=='family-backup-chunk' || c.backupId!==reference.id || c.guardianPk!==guardian || c.index!==index || c.count!==reference.chunkIds.length || typeof c.data!=='string' || c.data.length > 4*Math.ceil(BACKUP_CHUNK_BYTES/3))return
      try {
        const bytes=unbase64(c.data),expected=Math.min(BACKUP_CHUNK_BYTES,reference.bytes-index*BACKUP_CHUNK_BYTES)
        if(bytes.length!==expected)return
        parts.set(index,bytes)
        if(parts.size!==wanted.size)return
        const data=new Uint8Array(reference.bytes)
        for(const [i,part] of parts)data.set(part,i*BACKUP_CHUNK_BYTES)
        if(bytesToHex(sha256(data))!==reference.sha256){finish(null);return}
        const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)) as Partial<AppState>
        if(!parseSnapshotPayload({v:1,kind:'snapshot',state:raw}))throw new Error('Invalid checkpoint policy or ledger')
        const serial=JSON.stringify({...emptyState(),...raw,role:'guardian',guardianPubkey:guardian,self:{pubkey:guardian,childIndex:null}})
        const restored=loadState({getItem:key=>key==='kinjar.state.v1'?serial:null,setItem:()=>{},removeItem:()=>{}},0)
        if(raw.v!==1 || !Array.isArray(raw.entries) || restored.entries.length!==raw.entries.length || !raw.docs || !Array.isArray(raw.children) || restored.children.length!==raw.children.length || !Array.isArray(raw.ticks) || restored.ticks.length!==raw.ticks.length || !Array.isArray(raw.audits) || restored.audits.length!==raw.audits.length || !Array.isArray(raw.requests) || restored.requests.length!==raw.requests.length)throw new Error('Invalid family checkpoint')
        const accounts=restored.docs.accounts.accounts
        if(new Set(restored.entries.map(e=>e.id)).size!==restored.entries.length || new Set(restored.children.map(c=>c.pubkey)).size!==restored.children.length || new Set(restored.requests.map(r=>r.request.reqId)).size!==restored.requests.length || new Set(accounts.map(a=>a.id)).size!==accounts.length)throw new Error('Duplicate checkpoint records')
        if(Object.entries(raw.docs.accounts.revoked ?? {}).some(([key,time])=>!HEX.test(key)||!Number.isSafeInteger(time)||time<0))throw new Error('Invalid revocation')
        for(const profile of restored.children)if(profile.signet){const consent=rootPk && verifyChildConsent(profile.signet.selectionProof,rootPk,guardian);if(!consent || consent.identityPk!==profile.signet.identityPk)throw new Error('Invalid child identity')}
        for(const d of restored.docs.accounts.devices ?? [])if(!rootPk || !validDevice(d,guardian,rootPk) || !restored.children.some(c=>c.pubkey===d.child && c.signet?.identityPk===d.identityPk))throw new Error('Invalid device grant')
        for(const cfg of [...restored.docs.allowance.configs,...restored.docs.interest.configs])if(!accounts.some(a=>a.id===cfg.account && a.child===cfg.child))throw new Error('Invalid policy account')
        for(const account of accounts)if(!restored.children.some(c=>c.pubkey===account.child))throw new Error('Unknown child account')
        for(const r of restored.requests)if(!restored.children.some(c=>c.pubkey===r.request.child))throw new Error('Unknown request child')
        for(const e of restored.entries){assertEntryAgainst(restored.docs.accounts.accounts,e);if(e.reverses){const o=restored.entries.find(x=>x.id===e.reverses);if(!o)throw new Error('Missing original');assertReversalOf(o,e)}}
        for(const e of restored.entries.filter(e=>e.correctionGroup && e.reverses))appendCorrection(restored.entries.filter(row=>row.correctionGroup!==e.correctionGroup),restored.docs.accounts.accounts,restored.entries.filter(row=>row.correctionGroup===e.correctionGroup))
        balances(restored.entries)
        finish({...familyCheckpoint(restored),backupRevision:reference.revision})
      }catch{finish(null)}
    }); if(finished)stop() }catch{finish(null)}
  })
}
