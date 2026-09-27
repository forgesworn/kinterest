// Mnemonic-rooted guardian identity and dependant (child) key derivation.
//
// AMENDED 2026-08-10 after review: the suite roots every family at the
// guardian's BIP-39 mnemonic, never at a raw secret key. An earlier sibling
// app (`app/src/identity.ts`) and signet-app derive both the guardian's own
// signing keypair AND every dependant's keypair from that one mnemonic via
// `signet-protocol`'s identity tree (itself built on `nsec-tree`). The
// spec's "the guardian's mnemonic is the single family backup" is
// load-bearing: a guardian who only ever holds a raw sk cannot recover a
// lost device, and their children's keys were never portable to signet-app
// in the first place. This file previously hand-ported a `fromNsec`-rooted
// derivation (a real but DIFFERENT algorithm — nsec-tree exposes both
// `fromMnemonic` and `fromNsec` as distinct roots) and has been reworked to
// call the same mnemonic-rooted chain that earlier sibling app calls, using
// the published `signet-protocol` package directly rather than hand-porting it.
//
// This module mirrors that earlier sibling app's `app/src/identity.ts`'s exact calls:
//   - `generateMnemonic`/`validateMnemonic` wrap signet-protocol's re-export
//     of `@scure/bip39` against its own wordlist (`BIP39_WORDLIST`) — same
//     call shape as that app's own wrappers, so words generated here
//     validate in that app / My Signet and vice versa.
//   - `guardianFromMnemonic` mirrors that app's `derivePersonaKeypair`:
//     `createSignetIdentity(mnemonic).persona` is the identity tree's
//     built-in `persona` branch (NOT an additional named persona, and NOT
//     the natural-person branch — that app never touches that one for the
//     guardian either).
//   - `deriveDependantKey` mirrors that app's `deriveChild`:
//     `deriveDependantIdentity(tree.root, index).naturalPerson`, the
//     `dependant-<index>-np` identity. Byte-identical to that app / My
//     Signet by construction (same package, same calls) — pinned against a
//     live run of that package in derive.test.ts as a regression guard.

import {
  generateMnemonic as _generateMnemonic,
  validateMnemonic as _validateMnemonic,
  BIP39_WORDLIST,
  createSignetIdentity,
  deriveDependantIdentity,
  destroyIdentity,
} from 'signet-protocol'
import { bytesToHex } from 'nostr-tools/utils'

/** Generates a fresh 12-word BIP-39 mnemonic (English wordlist) — the
 *  guardian's single family backup. Same call shape as that earlier
 *  sibling app's `generateMnemonic()` wrapper. */
export function generateMnemonic(): string {
  return _generateMnemonic(BIP39_WORDLIST)
}

/** Validates a mnemonic against the same wordlist that app / My Signet use. */
export function validateMnemonic(mnemonic: string): boolean {
  return _validateMnemonic(mnemonic, BIP39_WORDLIST)
}

/**
 * Derives the guardian's own signing keypair from their mnemonic — the
 * identity tree's built-in `persona` branch, exactly as that earlier
 * sibling app's `derivePersonaKeypair`/`importFamilyIdentity` derive the parent's
 * keypair. Never `generateSecretKey()`: the guardian's signing identity
 * must be recoverable from the mnemonic alone.
 */
export function guardianFromMnemonic(mnemonic: string): { sk: Uint8Array; pk: string } {
  const tree = createSignetIdentity(mnemonic)
  // Copy the bytes out before destroyIdentity zeroes the tree's internal
  // buffers in place (see that earlier sibling app's identity.ts for the same ordering).
  const sk = new Uint8Array(tree.persona.identity.privateKey)
  const pk = bytesToHex(tree.persona.identity.publicKey)
  destroyIdentity(tree)
  return { sk, pk }
}

/**
 * Derives dependant (child) `index`'s natural-person keypair from the
 * guardian's mnemonic — byte-identical to that earlier sibling app's `deriveChild` /
 * signet-app's `deriveDependantIdentity(...).naturalPerson`. Deterministic:
 * the same mnemonic + index always reproduces the same child keys, so a
 * guardian who restores from their mnemonic can re-derive every child.
 */
export function deriveDependantKey(mnemonic: string, index: number): { sk: Uint8Array; pk: string } {
  const tree = createSignetIdentity(mnemonic)
  let dependant: ReturnType<typeof deriveDependantIdentity> | undefined
  try {
    // Validates `index` at the canonical provider boundary (throws a
    // message containing "index" for negative/non-integer/unsafe values) —
    // see derive.test.ts.
    dependant = deriveDependantIdentity(tree.root, index)
    const sk = new Uint8Array(dependant.naturalPerson.identity.privateKey)
    const pk = bytesToHex(dependant.naturalPerson.identity.publicKey)
    return { sk, pk }
  } finally {
    // The canonical API derives both branches together; we only use the
    // natural-person half, but must wipe both additional private keys.
    dependant?.naturalPerson.identity.privateKey.fill(0)
    dependant?.persona.identity.privateKey.fill(0)
    destroyIdentity(tree)
  }
}
