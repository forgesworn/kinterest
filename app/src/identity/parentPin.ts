import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { vaultLoad, vaultStore } from './vault'
import { isValidPinFormat, nextLockedUntil } from './pinLock'

const SLOT = 'parent-pin-v1'
const ITERATIONS = 210_000
interface Record { v: 1; salt: string; verifier: string; failures: number; lockedUntilSec: number }

async function read(): Promise<Record | null> {
  const bytes = await vaultLoad(SLOT)
  if (bytes === null) return null
  const r = JSON.parse(new TextDecoder().decode(bytes)) as Record
  if (r.v !== 1 || !/^[0-9a-f]{32}$/.test(r.salt) || !/^[0-9a-f]{64}$/.test(r.verifier) ||
      !Number.isSafeInteger(r.failures) || r.failures < 0 || !Number.isSafeInteger(r.lockedUntilSec) || r.lockedUntilSec < 0) {
    throw new Error('Saved parent lock is unreadable. Use My Signet to reset it.')
  }
  return r
}
async function write(r: Record): Promise<void> {
  await vaultStore(SLOT, new TextEncoder().encode(JSON.stringify(r)))
}
async function verifier(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: Uint8Array.from(hexToBytes(salt)).buffer, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256)
  return bytesToHex(new Uint8Array(bits))
}
export async function parentPinIsSet(): Promise<boolean> { return await read() !== null }
/** Caller must freshly authenticate the guardian with My Signet before setup/reset. */
async function setPinRecord(pin: string): Promise<boolean> {
  if (!isValidPinFormat(pin)) return false
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  await write({ v: 1, salt, verifier: await verifier(pin, salt), failures: 0, lockedUntilSec: 0 })
  return true
}
async function attempt(pin: string, nowSec: number): Promise<{ unlocked: boolean; lockedUntilSec: number }> {
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) throw new Error('Invalid lock time')
  const r = await read()
  if (r === null) return { unlocked: false, lockedUntilSec: 0 }
  if (nowSec < r.lockedUntilSec) return { unlocked: false, lockedUntilSec: r.lockedUntilSec }
  const candidate = await verifier(pin, r.salt)
  let diff = 0
  for (let i = 0; i < r.verifier.length; i++) diff |= candidate.charCodeAt(i) ^ r.verifier.charCodeAt(i)
  if (diff === 0) {
    await write({ ...r, failures: 0, lockedUntilSec: 0 })
    return { unlocked: true, lockedUntilSec: 0 }
  }
  const failures = r.failures + 1
  const lockedUntilSec = nextLockedUntil(failures, nowSec)
  await write({ ...r, failures, lockedUntilSec })
  return { unlocked: false, lockedUntilSec }
}

// Serialise verification and writes: concurrent taps must not lose failures.
let tail: Promise<unknown> = Promise.resolve()
function serial<T>(run: () => Promise<T>): Promise<T> {
  const result = tail.then(run, run)
  tail = result.catch(() => {})
  return result
}
export function setParentPin(pin: string): Promise<boolean> { return serial(() => setPinRecord(pin)) }
export function unlockParent(pin: string, nowSec: number): Promise<{ unlocked: boolean; lockedUntilSec: number }> { return serial(() => attempt(pin, nowSec)) }
