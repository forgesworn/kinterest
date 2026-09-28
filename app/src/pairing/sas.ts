// The short pairing code both screens show — port of charter's
// `domain/pairingSas.ts`
// renamed to this suite's name-free domain separator.
//
// WHAT IT PROVES. Only that the two screens (guardian's QR screen, child's
// scan screen) are talking about the same (guardian pubkey, token) pair. A
// child comparing "123 456" against what the parent's screen shows out loud
// is a check a family will actually perform — unlike comparing full npubs,
// which nobody does. It is NOT a secret: it is derived from public inputs
// (the guardian's pubkey and the pairing token, both of which cross the QR
// itself) and exists purely so a substituted QR/link produces a visibly
// different code rather than a silent, unverifiable identity swap.
//
// Deliberately keyed on BOTH inputs: the pubkey alone would repeat across
// every pairing this guardian ever does, so a code glimpsed once (over a
// shoulder, in a photo of the QR) would be replayable forever; folding in the
// per-pairing token makes each code single-occasion.

/** Domain separator — a hash of these inputs must mean this and nothing
 *  else. Name-free by design ("kin-jar", never the app's real
 *  name — see Global Constraints). */
const SAS_DOMAIN = 'kin-jar-sas-v1'

/**
 * The six-digit pairing code for a (guardian pubkey, one-time token) pair,
 * formatted as `"123 456"`.
 */
export async function sasDigits(guardianPk: string, token: string): Promise<string> {
  const input = `${SAS_DOMAIN}:${guardianPk.toLowerCase()}:${token}`
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))
  // 24 bits -> 0..999999. The modulo bias on the largest residues (~6%)
  // doesn't matter: this is a comparison code between two screens, not a
  // secret anyone has to guess (see header comment).
  const n = ((digest[0]! << 16) | (digest[1]! << 8) | digest[2]!) % 1_000_000
  const s = String(n).padStart(6, '0')
  return `${s.slice(0, 3)} ${s.slice(3)}`
}

/** Binds the approval to the particular claiming device, not just the QR. */
export async function claimSasDigits(guardianPk: string, token: string, childPk: string, devicePk: string): Promise<string> {
  return sasDigits(guardianPk, `claim-v2:${token}:${childPk}:${devicePk}`)
}
