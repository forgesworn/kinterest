// The ONLY module in this app that imports `signet-login` (v0.2 spec §1.7).
//
// LOAD-BEARING, do not relax: `signet-login`'s root entry touches `document`
// and `window` at call time and mounts its own `<dialog>` on `document.body`.
// The vitest suite runs in the `node` environment, where neither exists, so
// this module must NEVER be imported at the top level of any module a test
// loads. Screens reach it as `await import('../identity/signetLogin')`, inside
// the click handler that needs it, and nothing else imports it at all.
// Everything decidable — the challenge, the attestation check, the vault
// choice — lives in `signetRoot.ts` / `signetVault.ts`, which import nothing
// from this package and are tested directly. This file is a pass-through and
// deliberately has no test of its own.

import { login, logout, type SignetSession, type SignetSigner } from 'signet-login'
import type { NostrEvent } from 'nostr-tools/pure'

export interface SignetLoginOpts {
  /** 64 lowercase hex, from `signetRoot.ts#rootChallenge`. Omitted only on
   *  the RECOVERY path, which does not yet know the guardian key the
   *  challenge has to bind to — it signs the real attestation afterwards
   *  with `signetAttest`, once the vault has told it what that key is. */
  challenge?: string
  /** `AppState.relays` — the family's own relays, so a NIP-46 signer meets us
   *  where the rest of the family already talks. */
  relayUrls: string[]
  /** Recovery needs to DECRYPT the vault, so it needs a live NIP-44 signer;
   *  first sign-in only needs the signed attestation, so an auth-only session
   *  is good enough there and the backup can wait. */
  requireFullSigner: boolean
}

export interface SignetLoginResult {
  pubkey: string
  authEvent: NostrEvent
  displayName?: string
  signer: SignetSigner
  /** `signer.capabilities.hasNip44 && signer.capabilities.canSignEvents` —
   *  i.e. this session can seal a vault and open one again. */
  full: boolean
}

/** `appName` goes into the auth event's `app` tag, which is relay-visible.
 *  Name-free per the global rules: "Jar", never the working name. */
const APP_NAME = 'Jar'

function toResult(session: SignetSession | null, requireFullSigner: boolean): SignetLoginResult | null {
  if (session === null) return null
  const caps = session.signer.capabilities
  const full = caps.hasNip44 === true && caps.canSignEvents === true
  if (requireFullSigner && !full) return null
  return {
    pubkey: session.pubkey,
    authEvent: session.authEvent as unknown as NostrEvent,
    ...(session.displayName !== undefined ? { displayName: session.displayName } : {}),
    signer: session.signer,
    full,
  }
}

/**
 * Opens the My Signet picker and returns the authenticated session.
 *
 * `null` means "no session to use": the user cancelled or timed out, the
 * picker threw, or `requireFullSigner` was asked for and the session that came
 * back is auth-only. Never throws — a login the user walked away from must
 * never take a screen down with it.
 */
export async function signetLogin(o: SignetLoginOpts): Promise<SignetLoginResult | null> {
  try {
    const session = await login({
      appName: APP_NAME,
      ...(o.challenge !== undefined ? { challenge: o.challenge } : {}),
      preferredMethod: 'nostrconnect',
      methods: ['nostrconnect', 'remote-signet', 'local-signet', 'bunker', 'nip07', 'amber'],
      advancedMethods: [],
      relayUrls: o.relayUrls,
      nostrConnectPerms: ['sign_event', 'nip44_encrypt', 'nip44_decrypt'],
      theme: 'auto',
      timeout: 180_000,
    })
    return toResult(session, o.requireFullSigner)
  } catch {
    return null
  }
}

/** Clears `signet-login`'s stored session. Never throws — disconnecting must
 *  succeed locally even when the remote signer is unreachable. */
export async function signetLogout(): Promise<void> {
  try {
    await logout()
  } catch {
    // Deliberately swallowed: see the doc comment.
  }
}

/**
 * Signs a fresh kind-21236 attestation with an already-open session.
 *
 * The recovery path needs this: it has to log in BEFORE it can open the vault,
 * and only the vault says which guardian key the attestation must bind to, so
 * the login's own auth event is bound to the wrong (auto-generated) challenge.
 * Rather than making the user log in twice, we ask the signer — the same My
 * Signet key, over the same session — to sign the attestation the family
 * actually needs. `verifyRootAttestation` cannot tell the two apart and does
 * not care: it checks the kind, the signature, the author and the challenge,
 * all of which are identical either way.
 *
 * `nowSec` is unix SECONDS, supplied by the caller (no clock in here).
 * Returns `null` if the session cannot sign events, or the signer refuses.
 */
export async function signetAttest(
  signer: SignetSigner,
  challenge: string,
  nowSec: number,
): Promise<NostrEvent | null> {
  try {
    if (!signer.capabilities.canSignEvents) return null
    // The `origin` tag every real 21236 event carries. Our own
    // `verifyRootAttestation` deliberately ignores it (a child device has no
    // idea what origin the guardian signed from — see signetRoot.ts), but
    // `signet-login`'s own verifier does not, and an attestation it would
    // reject is one no other app in the family could ever check.
    const origin = typeof window !== 'undefined' ? window.location?.origin : undefined
    const signed = await signer.signEvent({
      kind: 21236,
      created_at: nowSec,
      content: '',
      tags: [
        ['challenge', challenge],
        ...(typeof origin === 'string' && origin !== '' ? [['origin', origin]] : []),
        ['app', APP_NAME],
      ],
    })
    return signed as unknown as NostrEvent
  } catch {
    return null
  }
}
