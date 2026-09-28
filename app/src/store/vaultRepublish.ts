import { familyCheckpointSignature } from '../identity/familyBackup'
import { publishFamilyBackup } from '../identity/familyBackup'
import { dataStorage } from '../platform/dataStorage'
// Republish complete encrypted family checkpoints after changes and weekly.
// Sealing uses the local guardian key and the saved My Signet public key;
// ordinary backup never opens a signer or prompts for consent. A dedicated
// durable job requires every chunk and its manifest on one accepting relay.
// The optional send seam retains legacy identity-vault migration behaviour.

import type { AppState } from '../state/types'
import type { RelayLike } from '../wire/relayClient'
import { outboxEvents, STALE_SWEEP_SECS, type StorageLike } from '../wire/outbox'
import { sendVault, type PublishResult } from '../sync/publish'
import type { VaultPayload } from '../wire/payloads'
import { vaultPayloadFor, vaultPublishDue, vaultRosterOf, vaultRosterSignature } from '../identity/signetVault'
import { guardianFromMnemonic } from '../identity/derive'

/** Signature of the last acknowledged complete checkpoint and roster. */
export const VAULT_PUBLISHED_KEY = 'kinjar.vault.publishedSignature.v1'
export const VAULT_QUEUED_KEY = 'kinjar.vault.queuedPublish.v1'

// The last signature this process wrote, per storage. A write that fails
// (storage full or blocked) is still remembered here, so the next check does
// not see the change as unpublished and seal yet another vault.
const DEFAULT_STORAGE_KEY = {}
const writtenInMemory = new WeakMap<object, string>()

/** The recorded signature, or null (never recorded, or storage blocked and
 *  nothing written by this process). */
export function readVaultPublished(storage: Pick<Storage, 'getItem'> | undefined = dataStorage()): string | null {
  const remembered = writtenInMemory.get(storage ?? DEFAULT_STORAGE_KEY)
  if (remembered !== undefined) return remembered
  try {
    return storage?.getItem(VAULT_PUBLISHED_KEY) ?? null
  } catch {
    return null
  }
}

/** Records a publish that left the outbox. Never throws: a failed durable
 *  write is still remembered for the life of this process. */
export function writeVaultPublished(signature: string, storage: Pick<Storage, 'setItem'> | undefined = dataStorage()): void {
  writtenInMemory.set(storage ?? DEFAULT_STORAGE_KEY, signature)
  try {
    storage?.setItem(VAULT_PUBLISHED_KEY, signature)
  } catch {
    // See the doc comment.
  }
}

/** True when a wrap addressed to `rootPk` (only vaults are) is still in the
 *  outbox: it will go out on the next flush, so sealing another would only
 *  queue a second copy of the family's recovery words. */
export function vaultQueued(rootPk: string, storage: StorageLike): boolean {
  try {
    return outboxEvents(storage).some((e) => e.tags.some((t) => t[0] === 'p' && t[1] === rootPk))
  } catch {
    return false
  }
}

export interface RepublishVaultOpts {
  /** The app as it stands now — read again after every await. */
  getApp: () => AppState
  guardianSk: Uint8Array
  relay: RelayLike
  /** The outbox storage. */
  storage: StorageLike
  /** Where the published signature is recorded. */
  record: Pick<Storage, 'getItem' | 'setItem'> | undefined
  nowSec: number
  loadMnemonic: () => Promise<string | null>
  /** The signature of a publish still under way (shared between calls). */
  inFlight: { current: string | null }
  onError?: (message: string) => void
  send?: (payload: VaultPayload, opts: Parameters<typeof sendVault>[1]) => Promise<PublishResult>
}

/**
 * Seals and publishes the vault when `vaultPublishDue` says so. Returns the
 * unix-SECONDS stamp for `root.backedUpAt` after the current complete
 * checkpoint is acknowledged, else null. Never throws.
 */
export async function republishVaultIfDue(o: RepublishVaultOpts): Promise<number | null> {
  const app = o.getApp()
  const root = app.root
  if (app.role !== 'guardian' || root === null || root.kind !== 'signet' || root.pubkey === '') return null
  const signature = vaultRosterSignature(vaultRosterOf(app))
  // A vault accepted by an unrelated outbox flush still counts as backed
  // up. Reconcile its queued id before deciding to seal another copy. A
  // swept/expired item cannot prove delivery and must be sealed again.
  try {
    const pending = o.send ? JSON.parse(o.record?.getItem(VAULT_QUEUED_KEY) || 'null') : null
    if (pending?.rootPk === root.pubkey && typeof pending.eventId === 'string'
      && typeof pending.signature === 'string' && Number.isSafeInteger(pending.queuedAt)
      && pending.queuedAt <= o.nowSec && !outboxEvents(o.storage).some(e => e.id === pending.eventId)) {
      o.record?.setItem(VAULT_QUEUED_KEY, '')
      if (o.nowSec - pending.queuedAt < STALE_SWEEP_SECS) {
        writeVaultPublished(pending.signature, o.record)
        if (pending.signature === signature) return pending.queuedAt
      }
    }
  } catch { /* Failed metadata reads/writes do not prevent a backup. */ }
  const due = vaultPublishDue({
    signature,
    lastPublished: readVaultPublished(o.record),
    inFlight: o.inFlight.current,
    backedUpAt: root.backedUpAt,
    nowSec: o.nowSec,
  })
  if (o.inFlight.current !== null) return null
  if (due === 'none') return null
  if (o.send && vaultQueued(root.pubkey, o.storage)) return null
  o.inFlight.current = signature
  try {
    const mnemonic = await o.loadMnemonic()
    if (mnemonic === null) return null
    // Read the roster and root fresh: the family as it stands now is what
    // the vault must carry.
    const fresh = o.getApp()
    const freshRoot = fresh.root
    if (freshRoot === null || freshRoot.kind !== 'signet' || freshRoot.pubkey !== root.pubkey) return null
    if (!o.send) {
      for(let attempt=0;attempt<3;attempt++) {
        const current=o.getApp(), currentRoot=current.root
        if(currentRoot?.kind!=='signet' || currentRoot.pubkey!==root.pubkey)return null
        const outcome=await publishFamilyBackup(current,vaultPayloadFor(vaultRosterOf(current),mnemonic,guardianFromMnemonic(mnemonic).pk,currentRoot.authEvent,o.nowSec),{selfSk:o.guardianSk,rootPk:currentRoot.pubkey,relay:o.relay,storage:o.storage,nowSec:o.nowSec})
        if(!outcome.sent)return null
        const latest=o.getApp()
        if(latest.root?.kind!=='signet' || latest.root.pubkey!==root.pubkey)return null
        if(outcome.signature===familyCheckpointSignature(latest)) {
          writeVaultPublished(vaultRosterSignature(vaultRosterOf(latest)),o.record)
          return o.nowSec
        }
        // Drain an older immutable offline job, then capture current data now.
        writeVaultPublished(`checkpoint:${outcome.signature}`,o.record)
      }
      return null
    }
    const { sent, event } = await (o.send ?? sendVault)(
      vaultPayloadFor(vaultRosterOf(fresh), mnemonic, guardianFromMnemonic(mnemonic).pk, freshRoot.authEvent, o.nowSec),
      { selfSk: o.guardianSk, peerPk: freshRoot.pubkey, relay: o.relay, storage: o.storage, nowSec: o.nowSec },
    )
    if (!sent) {
      try {
        if (outboxEvents(o.storage).some(queued => queued.id === event.id))
          o.record?.setItem(VAULT_QUEUED_KEY, JSON.stringify({ eventId: event.id, rootPk: freshRoot.pubkey,
            signature: vaultRosterSignature(vaultRosterOf(fresh)), queuedAt: o.nowSec }))
      } catch { /* The queued encrypted vault itself is still retried. */ }
      return null
    }
    try { o.record?.setItem(VAULT_QUEUED_KEY, '') } catch { /* published signature still remembered */ }
    writeVaultPublished(vaultRosterSignature(vaultRosterOf(fresh)), o.record)
    return o.nowSec
  } catch (error) {
    o.onError?.(error instanceof Error ? error.message : 'The family backup could not be saved. Keep this phone until backup succeeds.')
    return null
  } finally {
    if (o.inFlight.current === signature) o.inFlight.current = null
  }
}
