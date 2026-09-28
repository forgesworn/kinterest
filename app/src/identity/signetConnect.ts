// The two My Signet journeys, in one place: connecting a family root, and
// recovering a family from one (v0.2 spec §1.6, §1.8).
//
// This module does I/O — a picker, a relay subscription — so it has no test of
// its own; every decision it makes is delegated to a pure, tested function
// (`signetRoot.ts`'s verification, `signetVault.ts`'s selection and bounds).
// What is left here is ORDERING, and the order is load-bearing in both
// directions; see each function's comment.
//
// `signet-login` is reached only through `await import('./signetLogin')`, so
// importing THIS module still costs a test nothing: the browser-only package
// is not pulled in until one of these functions actually runs.

import type { NostrEvent } from 'nostr-tools/pure'
import { guardianFromMnemonic, validateMnemonic } from './derive'
import { rootChallenge, verifyRootAttestation } from './signetRoot'
import { collectVaultCandidates, pickFamilyVault } from './signetVault'
import { unwrapWithSigner } from '../wire/giftwrap'
import type { RelayLike } from '../wire/relayClient'
import type { VaultPayload } from '../wire/payloads'
import type { RootRecord } from '../state/types'

export type SignetRoot = Extract<RootRecord, { kind: 'signet' }>

/** Spec §1.6: the recovery subscription is bounded both ways — it reads a
 *  public inbox that anyone at all can address. */
// The inbox is public, so a flood of junk wraps must not hide the
// vault. Opened 8 at a time (each is two signer round trips), a minute buys
// several hundred attempts rather than the old first 200 all fired at once.
export const RECOVERY_TIMEOUT_MS = 60_000
export const RECOVERY_MAX_WRAPS = 1_000

export interface ConnectRootOpts {
  /** The guardian device key the attestation must bind to. It MUST already
   *  exist and be vaulted before this runs (spec §1.8, step ordering). */
  guardianPk: string
  /** `AppState.relays`. */
  relayUrls: string[]
}

export interface ConnectedRoot {
  root: SignetRoot
  /** Whether the session can seal a vault (`hasNip44 && canSignEvents`). */
  full: boolean
}

/**
 * Opens the picker and returns a VERIFIED family root, or `null`.
 *
 * `null` covers every failure the user can see as one thing ("that didn't
 * work"): a cancelled picker, a timeout, or an attestation that does not
 * verify against `guardianPk`. The last one matters most — we check the
 * attestation we were just handed rather than trusting the session object,
 * so a signer that returned something malformed, stale or bound to another
 * key never becomes this family's root.
 *
 * `backedUpAt` is always `null` here: connecting is not backing up. The
 * caller decides whether to publish a vault straight afterwards.
 */
export async function connectSignetRoot(o: ConnectRootOpts): Promise<ConnectedRoot | null> {
  const { signetLogin } = await import('./signetLogin')
  const r = await signetLogin({
    challenge: rootChallenge(o.guardianPk),
    relayUrls: o.relayUrls,
    requireFullSigner: false,
  })
  if (r === null) return null
  if (!verifyRootAttestation(r.authEvent, r.pubkey, o.guardianPk)) return null
  return {
    root: {
      kind: 'signet',
      pubkey: r.pubkey,
      authEvent: r.authEvent,
      ...(r.displayName !== undefined ? { displayName: r.displayName } : {}),
      backedUpAt: null,
    },
    full: r.full,
  }
}

/**
 * Why a recovery login cannot proceed, or `null` when it can. Pure.
 *
 * Recovery asks for a session that can DECRYPT, but it must not ask the
 * picker to enforce that: `requireFullSigner` collapses "the user closed the
 * picker" and "the signer is auth-only" into the same `null`, and those two
 * need different copy. Telling someone who changed their mind that we could
 * not find their family sends them looking for a backup that is sitting there
 * perfectly well.
 */
export function classifyRecoveryLogin(session: { full: boolean } | null): RecoverFailure | null {
  if (session === null) return 'cancelled'
  if (!session.full) return 'needs-full-signer'
  return null
}

export interface RecoverOpts {
  relay: RelayLike
  relayUrls: string[]
  /** unix SECONDS, supplied by the caller. */
  nowSec: number
}

/** `too-many-candidates`: no usable vault among the wraps that were opened,
 *  but the bound or the deadline left others unopened — the inbox may be
 *  flooded. Distinct from `no-vault`, which means every wrap on
 *  offer was tried. */
/** `conflicting-vaults`: authentic vaults for more than one family (guardian
 *  key) were found, so none is picked — one may be planted. */
export type RecoverFailure = 'cancelled' | 'needs-full-signer' | 'no-vault' | 'too-many-candidates' | 'conflicting-vaults'

export interface RecoveredFamily {
  vault: VaultPayload
  /** The root to store. `backedUpAt` is the vault's own `createdAt` — that IS
   *  when this family was last backed up. `null` when the session could not
   *  sign a correctly-bound attestation; the family still recovers, and
   *  Settings offers "Connect My Signet" to fix the root afterwards. */
  root: SignetRoot | null
}

/** The failure for a hunt that found no usable vault. Pure. */
export function recoveryMiss(truncated: boolean): 'no-vault' | 'too-many-candidates' {
  return truncated ? 'too-many-candidates' : 'no-vault'
}

/**
 * "I already have a family on My Signet" (spec §1.6).
 *
 * The vault inbox this reads is PUBLIC — `{kinds:[1059], '#p':[signetPk]}`,
 * addressable by anyone — and the unwrap deliberately pins no expected
 * author, because the guardian key is exactly what is not yet known. The
 * authenticity check therefore lives one step later, in `pickNewestVault`,
 * which requires every candidate to carry a root attestation signed by
 * `session.pubkey` (item C1).
 *
 * Order, all of it load-bearing:
 *   1. Log in, then check the session can decrypt. The login itself does NOT
 *      demand a full signer, so that a picker the user simply closed stays
 *      distinguishable from a session that came back auth-only — the two need
 *      different copy (see `classifyRecoveryLogin`).
 *   2. Collect gift wraps addressed to that identity, bounded
 *      RECOVERY_TIMEOUT_MS / RECOVERY_MAX_WRAPS, opening them with the remote
 *      signer a few at a time.
 *   3. `pickFamilyVault` decides — refusing outright if the authentic vaults
 *      name more than one family, otherwise newest first, the root attestation that
 *      proves the vault was written for THIS Signet identity, the checksum,
 *      and the self-consistency check that stops a torn vault recovering a
 *      family into the wrong identity.
 *   4. Only THEN is the guardian key known, so only then can a correctly
 *      bound attestation be signed (`signetAttest`). It is verified before
 *      being kept, exactly as on the connect path.
 *
 * Never throws. The mnemonic is returned, not committed: vaulting it and
 * dispatching the restored state is the screen's job, and it must happen
 * before anything else can fail.
 */
export async function recoverFamilyFromSignet(o: RecoverOpts): Promise<RecoveredFamily | RecoverFailure> {
  const { signetLogin, signetAttest } = await import('./signetLogin')
  const session = await signetLogin({ relayUrls: o.relayUrls, requireFullSigner: false })

  const refused = classifyRecoveryLogin(session)
  if (refused !== null) return refused

  const nip44 = session?.signer.nip44
  if (session === null || nip44 === undefined) return 'needs-full-signer'

  const hunt = await collectVaultCandidates({
    relay: o.relay,
    signetPk: session.pubkey,
    maxWraps: RECOVERY_MAX_WRAPS,
    timeoutMs: RECOVERY_TIMEOUT_MS,
    unwrap: (wrap: NostrEvent) =>
      unwrapWithSigner({
        wrap,
        signer: { decrypt: (peerPk, ct) => nip44.decrypt(peerPk, ct) },
      }),
  })

  // `session.pubkey` — the Signet identity this login actually authenticated
  // as, never anything read out of a candidate payload. That is what makes
  // the attestation gate mean something (item C1): a planted vault in this
  // public inbox carries an attestation from SOMEBODY's Signet key, and the
  // only question worth asking is whether it is this one.
  //
  // More than one family among the authentic vaults is refused rather than
  // resolved by recency: see `pickFamilyVault`.
  const picked = pickFamilyVault(hunt.candidates, session.pubkey, validateMnemonic, (m) => guardianFromMnemonic(m).pk)
  if (picked.kind === 'conflicting-vaults') return 'conflicting-vaults'
  if (picked.kind === 'none') return recoveryMiss(hunt.truncated)
  const { vault } = picked

  const authEvent = await signetAttest(session.signer, rootChallenge(vault.guardianPk), o.nowSec)
  const verified = authEvent !== null && verifyRootAttestation(authEvent, session.pubkey, vault.guardianPk)

  return {
    vault,
    root: verified
      ? {
          kind: 'signet',
          pubkey: session.pubkey,
          authEvent: authEvent as NostrEvent,
          ...(session.displayName !== undefined ? { displayName: session.displayName } : {}),
          backedUpAt: vault.createdAt,
        }
      : null,
  }
}
