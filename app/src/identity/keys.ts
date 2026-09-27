// Guardian/child keypairs are plain Nostr secp256k1 keys — nothing more than
// a thin, typed wrapper over nostr-tools so callers never reach past this
// module for key material shapes.

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'

export { bytesToHex, hexToBytes }

/**
 * A fresh secp256k1 keypair: raw 32-byte secret key, lowercase hex pubkey.
 *
 * TEST/EPHEMERAL ONLY — real identities in this app are mnemonic-rooted via
 * identity/derive.ts (`guardianFromMnemonic`, `deriveDependantKey`), per the
 * suite's single-family-backup convention: the mnemonic is the one thing a
 * family needs to recover every device's keys. A `newKeypair()` identity has
 * no mnemonic behind it at all, so it is unrecoverable — lose the raw `sk`
 * and that identity is gone for good. Production code must never call this
 * for a guardian, child, or device identity; it exists so tests can mint
 * disposable keypairs (an "impostor" peer, a throwaway device) without
 * generating and discarding a whole mnemonic for each one.
 */
export function newKeypair(): { sk: Uint8Array; pk: string } {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  return { sk, pk }
}

/** Bech32 `npub1…` encoding of a hex pubkey. */
export function npubOf(pk: string): string {
  return npubEncode(pk)
}
