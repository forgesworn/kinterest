// Background vault re-seal — the guardian's automatic republish of the
// family vault after a roster change, and weekly so relays that expire
// kind-1059 wraps never hold the only copy.
//
// Sealing needs no signer. The vault is gift-wrapped TO the family's My
// Signet pubkey: the seal is signed with this device's own guardian key and
// the wrap with a fresh ephemeral key, so the stored Signet pubkey is all
// this path reads. It never restores a My Signet session, never opens a
// signer or bunker connection, and never prompts: restoring a session can
// show an extension permission prompt, wipe a stored login when that prompt
// is dismissed, or open a new remote-signer connection. With no stored
// Signet pubkey there is nothing to seal to, so it skips.
//
// The only connection it uses is the app's existing relay pool, through the
// ordinary outbox.

import type { AppState } from '../state/types'
import type { RelayLike } from '../wire/relayClient'
import { outboxEvents, type StorageLike } from '../wire/outbox'
import { sendVault, type PublishResult } from '../sync/publish'
import type { VaultPayload } from '../wire/payloads'
import { vaultPayloadFor, vaultPublishDue, vaultRosterOf, vaultRosterSignature } from '../identity/signetVault'
import { guardianFromMnemonic } from '../identity/derive'

/** Where this device records the roster signature of its last vault publish
 *  that left the outbox. Not a secret: a signature is child names, keys and
 *  relay URLs this device already stores in plain state. */
export const VAULT_PUBLISHED_KEY = 'kinjar.vault.publishedSignature.v1'

// The last signature this process wrote, per storage. A write that fails
// (storage full or blocked) is still remembered here, so the next check does
// not see the change as unpublished and seal yet another vault.
const DEFAULT_STORAGE_KEY = {}
const writtenInMemory = new WeakMap<object, string>()

/** The recorded signature, or null (never recorded, or storage blocked and
 *  nothing written by this process). */
export function readVaultPublished(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): string | null {
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
export function writeVaultPublished(signature: string, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
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
  send?: (payload: VaultPayload, opts: Parameters<typeof sendVault>[1]) => Promise<PublishResult>
}

/**
 * Seals and publishes the vault when `vaultPublishDue` says so. Returns the
 * unix-SECONDS stamp to record as `root.backedUpAt` when a vault left the
 * outbox, else null. Never throws.
 */
export async function republishVaultIfDue(o: RepublishVaultOpts): Promise<number | null> {
  const app = o.getApp()
  const root = app.root
  if (app.role !== 'guardian' || root === null || root.kind !== 'signet' || root.pubkey === '') return null
  const signature = vaultRosterSignature(vaultRosterOf(app))
  const due = vaultPublishDue({
    signature,
    lastPublished: readVaultPublished(o.record),
    inFlight: o.inFlight.current,
    backedUpAt: root.backedUpAt,
    nowSec: o.nowSec,
  })
  if (due === 'none') return null
  if (vaultQueued(root.pubkey, o.storage)) return null
  o.inFlight.current = signature
  try {
    const mnemonic = await o.loadMnemonic()
    if (mnemonic === null) return null
    // Read the roster and root fresh: the family as it stands now is what
    // the vault must carry.
    const fresh = o.getApp()
    const freshRoot = fresh.root
    if (freshRoot === null || freshRoot.kind !== 'signet' || freshRoot.pubkey !== root.pubkey) return null
    const { sent } = await (o.send ?? sendVault)(
      vaultPayloadFor(vaultRosterOf(fresh), mnemonic, guardianFromMnemonic(mnemonic).pk, freshRoot.authEvent, o.nowSec),
      { selfSk: o.guardianSk, peerPk: freshRoot.pubkey, relay: o.relay, storage: o.storage, nowSec: o.nowSec },
    )
    if (!sent) return null
    writeVaultPublished(vaultRosterSignature(vaultRosterOf(fresh)), o.record)
    return o.nowSec
  } catch {
    return null
  } finally {
    if (o.inFlight.current === signature) o.inFlight.current = null
  }
}
