// Choosing which family backup to restore from (v0.2 spec §1.6, step 4).
//
// PURE: the relay subscription, the NIP-46 signer and the clock all stay in
// the caller (a screen). What is left here is the one decision that must be
// right — which of the vaults sitting in a My Signet inbox is the family — and
// it is decided the same way whether it came off a relay or out of a test.
//
// Nothing in this file imports `signet-login`.

import type { NostrEvent } from 'nostr-tools/pure'
import { buildVaultPayload, parseVaultPayload, type VaultPayload } from '../wire/payloads'
import { verifyRootAttestation } from './signetRoot'
import { KIND_VAULT, MARKER_TAG, WRAP } from '../wire/kinds'
import type { RelayLike } from '../wire/relayClient'
import type { AppState, ChildProfile } from '../state/types'

/** One candidate as it comes off the wire: the decrypted inner payload plus
 *  the inner event's own `created_at` (unix SECONDS). */
export interface VaultCandidate {
  payload: unknown
  /** unix SECONDS — the inner event's `created_at`. */
  createdAt: number
}

/**
 * The newest AUTHENTIC, parseable, self-consistent vault payload, or `null`.
 *
 * Candidates are tried newest first and each must clear four independent
 * gates:
 *   1. `parseVaultPayload` — shape, including a present, well-formed
 *      kind-21236 attestation.
 *   2. `verifyRootAttestation(payload.authEvent, signetPk, payload.guardianPk)`
 *      — AUTHENTICITY. See below; this is the load-bearing one.
 *   3. `validate(mnemonic)` — the BIP-39 checksum, injected so this module
 *      stays free of the wordlist and of any I/O.
 *   4. `guardianPkFor(mnemonic) === payload.guardianPk` — self-consistency.
 *      This is the gate that catches a truncated, swapped or half-written
 *      vault: a mnemonic that no longer derives the guardian key it claims is
 *      one that would silently recover a family into the WRONG identity, with
 *      every child unreachable and no error anywhere to explain it.
 *
 * Gate 2 exists because gates 1, 3 and 4 are all satisfiable by an ATTACKER
 * (fix round 2, item C1). The inbox this reads is the public relay filter
 * `{kinds:[1059], '#p':[signetPk]}` — anyone at all can gift-wrap an event
 * to a Signet pubkey, and the unwrap cannot pin an expected author because
 * the guardian key is precisely what is not yet known. So a stranger could
 * publish a vault holding their own mnemonic and their own guardian key: it
 * parses, its checksum is fine, and it derives exactly the key it claims.
 * Being newer than the family's real backup, it would then WIN, and the
 * guardian recovering from a lost phone would commit the attacker's family.
 *
 * The attestation is the one part an attacker cannot supply: it is signed by
 * the very Signet identity this recovery is logging in as (`signetPk`, the
 * session pubkey — never anything read out of the payload) over a challenge
 * bound to the vault's OWN `guardianPk`. Nobody without that Signet key can
 * mint one, and the family's genuine attestation cannot be reused for a
 * different vault, because it binds the genuine guardian key.
 *
 * There is deliberately NO tolerance for a vault that predates the
 * attestation: no vault has ever shipped, and "accept it if it has no
 * attestation" is the whole hole restored.
 *
 * A candidate that fails any gate is skipped, not fatal — so one corrupt or
 * one planted backup in the inbox never buries a good older one. Both
 * injected functions are treated as untrusted: a throw from either is a
 * skipped candidate.
 *
 * Pure and total.
 */
export function pickNewestVault(
  candidates: VaultCandidate[],
  /** The My Signet pubkey this recovery is logging in AS. */
  signetPk: string,
  validate: (mnemonic: string) => boolean,
  guardianPkFor: (mnemonic: string) => string,
): VaultPayload | null {
  return authenticVaults(candidates, signetPk, validate, guardianPkFor)[0] ?? null
}

/** Every candidate that clears all four of `pickNewestVault`'s gates, newest
 *  first. Pure and total. */
function authenticVaults(
  candidates: VaultCandidate[],
  signetPk: string,
  validate: (mnemonic: string) => boolean,
  guardianPkFor: (mnemonic: string) => string,
): VaultPayload[] {
  const newestFirst = [...candidates].sort((a, b) => b.createdAt - a.createdAt)
  const out: VaultPayload[] = []
  for (const candidate of newestFirst) {
    const parsed = parseVaultPayload(candidate.payload)
    if (parsed === null) continue
    // Before the mnemonic is so much as looked at: an unauthentic vault is
    // not a vault, whatever else about it is well formed.
    if (!verifyRootAttestation(parsed.authEvent, signetPk, parsed.guardianPk)) continue
    try {
      if (!validate(parsed.mnemonic)) continue
      if (guardianPkFor(parsed.mnemonic) !== parsed.guardianPk) continue
    } catch {
      continue
    }
    out.push(parsed)
  }
  return out
}

/** One family among conflicting vaults: its guardian key and the unix
 *  SECONDS `createdAt` of its newest authentic vault. */
export interface ConflictingFamily {
  guardianPk: string
  newestAt: number
}

export type FamilyVaultPick =
  | { kind: 'vault'; vault: VaultPayload }
  | { kind: 'conflicting-vaults'; families: ConflictingFamily[] }
  | { kind: 'none' }

/**
 * Which family to recover, refusing to guess.
 *
 * `pickNewestVault`'s attestation gate proves a vault was vouched for by
 * this Signet identity, but a kind-21236 attestation is a generic Signet
 * LOGIN: a phishing site the user signed in to can obtain one over an
 * attacker's guardian key (it writes the challenge and the `origin` tag
 * itself), then plant a newer vault that would silently win. So when the
 * authentic vaults name more than one distinct guardian key, nothing is
 * picked: the caller gets every family (newest first) and must send the
 * user to their recovery words instead. Several vaults for ONE guardian key
 * are ordinary re-publishes; the newest wins as before.
 *
 * Pure and total.
 */
export function pickFamilyVault(
  candidates: VaultCandidate[],
  /** The My Signet pubkey this recovery is logging in AS. */
  signetPk: string,
  validate: (mnemonic: string) => boolean,
  guardianPkFor: (mnemonic: string) => string,
): FamilyVaultPick {
  const vaults = authenticVaults(candidates, signetPk, validate, guardianPkFor)
  if (vaults.length === 0) return { kind: 'none' }
  const families: ConflictingFamily[] = []
  for (const v of vaults) {
    if (!families.some((f) => f.guardianPk === v.guardianPk)) families.push({ guardianPk: v.guardianPk, newestAt: v.createdAt })
  }
  if (families.length > 1) return { kind: 'conflicting-vaults', families }
  return { kind: 'vault', vault: vaults[0]! }
}

// --- publishing a vault ------------------------------------------------------

/** Just the two `AppState` fields a vault carries beyond the mnemonic —
 *  taken as a narrow structural type so this module never depends on the
 *  whole of `AppState`. */
export interface VaultRoster {
  children: ChildProfile[]
  relays: string[]
  /** `AppState['docs']['accounts']['revoked']` — child pubkey -> the unix
   *  SECONDS the guardian revoked that device (v0.2 spec §4.5).
   *
   *  REQUIRED, though it may be `undefined`: making it optional would let a
   *  caller pass an `AppState` straight in (which has `children` and `relays`
   *  at the top level but keeps `revoked` down on the accounts doc) and get a
   *  silently unfiltered roster. Requiring the property makes that a type
   *  error instead. */
  revoked: Record<string, number> | undefined
}

/** The one place `AppState`'s shape is mapped onto a `VaultRoster` — the
 *  revocation map lives on the accounts DOC, not at the top of the state, so
 *  every call site that skipped this used to get an unfiltered roster. Pure. */
export function vaultRosterOf(app: AppState): VaultRoster {
  return { children: app.children, relays: app.relays, revoked: app.docs.accounts.revoked }
}

/** The roster minus anyone revoked — what both the payload and the signature
 *  below are built from, so they can never disagree about who is in the
 *  family. */
function activeRoster(roster: VaultRoster): ChildProfile[] {
  const revoked = roster.revoked
  if (revoked === undefined) return roster.children
  return roster.children.filter((c) => revoked[c.pubkey] === undefined)
}

/** Pure. The vault payload for a family as it stands at `nowSec` (unix
 *  SECONDS). `buildVaultPayload` filters the relay list to what the parser
 *  will accept again at recovery.
 *
 *  `children` is the ACTIVE roster, never the full one (fix round 1 ruling).
 *  The vault is what a recovering guardian rebuilds its family from, and
 *  `identity/signetVault.ts`'s own recovery path restores `state.children`
 *  wholesale — so a revoked device left in here would be quietly re-admitted
 *  on the new device: resubscribed to, and sent every family config doc
 *  again. A revocation that a recovery can undo is not a revocation. The
 *  removed child's HISTORY is not lost by this; it lives in the ledger
 *  entries the vault's own resync brings back. */
export function vaultPayloadFor(
  roster: VaultRoster,
  mnemonic: string,
  guardianPk: string,
  /** The guardian's own `AppState.root.authEvent` — the kind-21236 Signet
   *  attestation binding this family's My Signet identity to `guardianPk`.
   *  Required (item C1): a vault without it is one a recovering guardian
   *  cannot tell from a stranger's, so there is nowhere for a caller that
   *  has not got one to go. There always is one — the root is connected and
   *  verified before any vault is ever published (spec §1.8). */
  authEvent: NostrEvent,
  nowSec: number,
): VaultPayload {
  return buildVaultPayload({
    mnemonic,
    guardianPk,
    authEvent,
    children: activeRoster(roster),
    relays: roster.relays,
    createdAt: nowSec,
  })
}

/**
 * A cheap, stable string that changes exactly when a published vault would
 * become out of date: a child added, renamed, re-indexed or revoked, or the
 * relay list edited (the guardian re-publishes on any of those,
 * not only at first backup). Pure.
 *
 * Deliberately NOT a hash: it is compared against the last-published value
 * held in memory, never stored or put on the wire, so legibility in a
 * debugger beats compactness.
 */
export function vaultRosterSignature(roster: VaultRoster): string {
  // Over `activeRoster`, exactly what the PAYLOAD carries — so a revoke drops
  // the child out of the signature and the vault is republished without them,
  // and so the signature can never claim a vault is current when the payload
  // it would produce has changed. A revocation TIMESTAMP moving is invisible
  // here, correctly: it changes nothing the vault carries.
  const children = activeRoster(roster)
    .map((c) => `${c.index}:${c.pubkey}:${c.name}`)
    .join('|')
  return `${children}#${[...roster.relays].join('|')}`
}

/**
 * Whether the guardian should publish a vault for roster signature
 * `signature`, given the signature it last published SUCCESSFULLY
 * (`lastPublished`) and the one currently being published (`inFlight`).
 * Pure.
 *
 * The two `false` cases are different failures being avoided:
 *   - `signature === lastPublished` — nothing has changed since the last
 *     publish that actually landed, so there is nothing new to seal.
 *   - `signature === inFlight` — a publish for exactly this roster is already
 *     on its way; starting a second one would put two identical vaults on the
 *     relays for no benefit.
 *
 * Everything else publishes, and that is deliberate: `lastPublished` is only
 * ever stamped after a send that left the outbox, so a failed or abandoned
 * publish leaves the signature due again rather than silently skipped. The
 * cost of being wrong in this direction is one redundant vault; the cost of
 * being wrong in the other is a family recovering without one of its children.
 */
export function shouldPublishVault(signature: string, lastPublished: string | null, inFlight: string | null): boolean {
  if (signature === lastPublished) return false
  if (signature === inFlight) return false
  return true
}

/** How old a published vault may get before the guardian republishes it
 *  unchanged, in SECONDS. Many relays expire kind-1059 gift wraps, and a
 *  vault that has quietly aged off every relay is no backup at all. */
export const VAULT_REPUBLISH_AFTER_SECS = 7 * 24 * 60 * 60

/** Why a vault publish is due: the roster or relays changed since the last
 *  one that landed, or the last one is old enough that relays may have
 *  dropped it. */
export type VaultDue = 'none' | 'changed' | 'stale'

/**
 * Whether the guardian should publish its vault now, and why. Pure.
 *
 *  - `signature` is `vaultRosterSignature` of the family as it stands.
 *  - `lastPublished` is the signature of the last publish that actually left
 *    the outbox, as this device RECORDED it — `null` when it never recorded
 *    one (a fresh install, or one from before this was recorded), which
 *    publishes once rather than assume the relays hold a current copy.
 *  - `inFlight` is the signature of a publish still under way; its twin is
 *    never started.
 *  - `backedUpAt` is `AppState.root.backedUpAt`, unix SECONDS, or `null`.
 *
 * A change beats staleness, and nothing is due while the same roster is
 * already on its way. `nowSec` is unix SECONDS.
 */
export function vaultPublishDue(o: {
  signature: string
  lastPublished: string | null
  inFlight: string | null
  backedUpAt: number | null
  nowSec: number
  maxAgeSecs?: number
}): VaultDue {
  if (o.signature === o.inFlight) return 'none'
  if (shouldPublishVault(o.signature, o.lastPublished, o.inFlight)) return 'changed'
  if (o.backedUpAt === null || o.nowSec - o.backedUpAt >= (o.maxAgeSecs ?? VAULT_REPUBLISH_AFTER_SECS)) return 'stale'
  return 'none'
}

// --- the bounded relay hunt (recovery) ---------------------------------------

/** The shape `wire/giftwrap.ts#unwrapWithSigner` resolves to, narrowed to the
 *  three fields this hunt needs. Injected rather than imported so the bound
 *  can be tested without a signer. */
export interface UnwrappedVault {
  innerKind: number
  payload: unknown
  /** unix SECONDS — the INNER event's `created_at`, which is what dates a
   *  vault (the wrap's own timestamp is deliberately jittered). */
  innerCreatedAt: number
}

export interface CollectVaultCandidatesOpts {
  relay: RelayLike
  /** The family's My Signet pubkey — every vault is gift-wrapped to it. */
  signetPk: string
  unwrap: (wrap: NostrEvent) => Promise<UnwrappedVault | null>
  /** The most wraps this hunt will try to open. */
  maxWraps: number
  /** The whole hunt's deadline, in-flight unwraps included. */
  timeoutMs: number
  /** Unwraps in flight at once — each is two round trips to the remote
   *  signer, which must not be handed hundreds at a time. Default 8. */
  concurrency?: number
}

export interface VaultHunt {
  candidates: VaultCandidate[]
  /** Wraps were offered that were never opened — over `maxWraps`, or still
   *  queued or in flight at the deadline. With no usable candidate that is
   *  "the inbox was too full to search", not "there is no vault". */
  truncated: boolean
}

/** Default for `CollectVaultCandidatesOpts.concurrency`. */
export const VAULT_UNWRAP_CONCURRENCY = 8

/**
 * Subscribes for gift wraps addressed to the family's My Signet identity and
 * collects whatever vaults it can open, BOUNDED both ways (spec §1.6): at most
 * `maxWraps` wraps are ever opened, and the whole hunt ends at `timeoutMs`.
 * It always unsubscribes on the way out. Never throws: an `unwrap` that
 * rejects skips that wrap.
 *
 * The bound is not an optimisation. This subscription is the one place the
 * app reads an inbox it does not control: anyone can address a wrap to a
 * public key, so without a ceiling a recovery screen could be held open
 * forever by a relay dribbling junk at it.
 *
 * The inbox is public, so a flood of junk wraps shaped the rest:
 *  - Wraps are QUEUED and opened `concurrency` at a time, never all at once.
 *  - Once the bound is reached the hunt WAITS for every queued and in-flight
 *    unwrap (up to the deadline) before resolving. It used to resolve when
 *    the LAST wrap's unwrap settled, discarding any earlier one still open —
 *    possibly the genuine vault.
 *  - `truncated` reports that wraps went unopened, so a flooded inbox can be
 *    told apart from an empty one.
 */
export async function collectVaultCandidates(o: CollectVaultCandidatesOpts): Promise<VaultHunt> {
  const found: VaultCandidate[] = []
  const queue: NostrEvent[] = []
  const concurrency = Math.max(1, o.concurrency ?? VAULT_UNWRAP_CONCURRENCY)
  let accepted = 0
  let inFlight = 0
  let overflow = false

  return new Promise<VaultHunt>((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = () => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      unsubscribe?.()
      resolve({ candidates: found, truncated: overflow || queue.length > 0 || inFlight > 0 })
    }

    // Done early only when the bound is reached AND everything accepted has
    // been opened; otherwise the deadline decides.
    const maybeDone = () => {
      if (accepted >= o.maxWraps && queue.length === 0 && inFlight === 0) finish()
    }

    const pump = () => {
      while (!settled && inFlight < concurrency && queue.length > 0) {
        const wrap = queue.shift()!
        inFlight += 1
        void o
          .unwrap(wrap)
          .then(
            (unwrapped) => {
              if (!settled && unwrapped !== null && unwrapped.innerKind === KIND_VAULT) {
                found.push({ payload: unwrapped.payload, createdAt: unwrapped.innerCreatedAt })
              }
            },
            () => {},
          )
          .finally(() => {
            inFlight -= 1
            if (settled) return
            pump()
            maybeDone()
          })
      }
    }

    timer = setTimeout(finish, o.timeoutMs)

    // The same filter the sync engine uses, narrowed to the Signet identity's
    // inbox: our marker tag keeps a shared relay's unrelated traffic out.
    const filter = { kinds: [WRAP], '#p': [o.signetPk], '#t': [MARKER_TAG[1]] }
    unsubscribe = o.relay.subscribe(filter, (wrap) => {
      // Bounded SYNCHRONOUSLY, before any async unwrap: a relay that replays
      // its whole window during `subscribe` would otherwise queue everything.
      if (settled) return
      if (accepted >= o.maxWraps) {
        overflow = true
        return
      }
      accepted += 1
      queue.push(wrap)
      pump()
    })

    // A relay that replayed everything DURING `subscribe` may already have
    // finished the hunt before `unsubscribe` was assigned.
    if (settled) unsubscribe()
  })
}
