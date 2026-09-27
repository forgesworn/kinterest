const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32

function defaultRandom(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  crypto.getRandomValues(out)
  return out
}

// nowMs is milliseconds — distinct from entries'/audits'/ticks' unix-seconds
// fields elsewhere in the domain, so don't feed one where the other is
// expected. The output (10-char time + 16-char random, Crockford base32) is
// wire-compatible with standard ULID; future ports of this ID scheme to
// other languages should target the standard ULID spec rather than this
// function's exact bit-twiddling.
export function newId(nowMs: number, random: (bytes: number) => Uint8Array = defaultRandom): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError(`bad timestamp: ${nowMs}`)
  let t = nowMs
  const time = new Array<string>(10)
  for (let i = 9; i >= 0; i--) {
    time[i] = ALPHABET[t % 32]!
    t = Math.floor(t / 32)
  }
  const rnd = random(16)
  let tail = ''
  for (let i = 0; i < 16; i++) tail += ALPHABET[rnd[i]! % 32]!
  return time.join('') + tail
}
