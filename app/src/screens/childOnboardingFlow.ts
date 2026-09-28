// The pure step machine behind screens/ChildOnboarding.tsx — mirrors
// screens/onboardingFlow.ts's own shape and reasoning ("Deliberately knows
// nothing about AppState, the vault, or dispatch... testable with no...
// crypto, no React at all"). See
// internal plan 2026-08-11-child-mode, Task 2: "scan parent QR
// (camera; paste fallback) -> waiting screen with SAS large... -> offer
// arrives -> ... -> set PIN twice -> home".
//
// Deliberately does NOT own: parsing the QR text itself (pairing.ts's
// `parsePairQr` is total and already tested there — this module just calls
// it), generating the device keypair, sending/receiving anything over the
// wire, or vaulting the PIN (identity/pinLock.ts). This module only ever
// decides which screen comes next, exactly like onboardingFlow.ts.

import { parsePairQr } from '../pairing/pairing'
import { isValidPinFormat } from '../identity/pinLock'

export type ChildOnboardingStep =
  | { kind: 'scan'; error: string | null }
  | { kind: 'waiting'; guardianPk: string; token: string; relays: string[] }
  | { kind: 'setPin' }
  | { kind: 'confirmPin'; firstPin: string }
  | { kind: 'pinMismatch' }
  /** The PIN is set and the offer accepted, but its family-root attestation
   *  would not verify (v0.2 spec §1.5) — a warning-and-confirm interstitial,
   *  reached ONLY once, right before this device actually joins the family.
   *  Deliberately BEFORE the `startAsChildFromOffer` dispatch
   *  that flips `role` to 'child': App.tsx's own role-derived routing swaps
   *  this whole screen out for ChildShell the instant that lands, so any
   *  warning shown only AFTER dispatching would never actually be seen. */
  | { kind: 'rootRejected' }

export function scanStep(): ChildOnboardingStep {
  return { kind: 'scan', error: null }
}

/**
 * A scanned (camera) or pasted (fallback) line of QR text becomes a
 * 'waiting' step — or, on anything that doesn't parse (`parsePairQr` is
 * itself total: wrong scheme, missing fields, a malformed guardian pubkey,
 * zero relays), stays on 'scan' with calm failure copy rather than a raw
 * parser error. The child never sees the guardian's pubkey or the token on
 * THIS screen — see ChildOnboarding.tsx for where they're actually used
 * (never rendered as text, per Global Constraints: "the child never sees
 * raw pubkeys").
 */
export function submitScannedText(text: string): ChildOnboardingStep {
  const parsed = parsePairQr(text)
  if (parsed === null) {
    return { kind: 'scan', error: "That code didn't look right — try scanning again, or check what you pasted." }
  }
  return { kind: 'waiting', guardianPk: parsed.guardianPk, token: parsed.token, relays: parsed.relays }
}

/** The guardian's PAIR_OFFER arrived and was accepted — only meaningful from
 *  'waiting'; a no-op (returns `step` unchanged) from anywhere else, the
 *  same defensive-total convention onboardingFlow.ts's own
 *  `confirmMnemonicWritten` uses. */
export function offerAccepted(step: ChildOnboardingStep): ChildOnboardingStep {
  return step.kind === 'waiting' ? { kind: 'setPin' } : step
}

/** First PIN entry submitted. A malformed PIN (see
 *  identity/pinLock.ts#isValidPinFormat) or the wrong originating step both
 *  leave `step` unchanged — the screen re-shows its own inline guidance
 *  rather than this module minting error copy for a keypad UI it knows
 *  nothing about. */
export function submitFirstPin(step: ChildOnboardingStep, pin: string): ChildOnboardingStep {
  if (step.kind !== 'setPin' || !isValidPinFormat(pin)) return step
  return { kind: 'confirmPin', firstPin: pin }
}

export type ConfirmPinResult =
  | { matched: true; pin: string }
  | { matched: false; step: ChildOnboardingStep }

/** Second PIN entry submitted, checked against the first. A mismatch moves
 *  to a dedicated 'pinMismatch' step (calm "let's try that again" copy,
 *  never blaming the child) rather than silently retrying — the caller
 *  (ChildOnboarding.tsx) is the one that actually seals the PIN via
 *  `identity/pinLock.ts#setPin` and dispatches into the store, only once
 *  `matched: true` comes back; this module holds no secret material of its
 *  own at any point (the PIN strings pass straight through, never derived
 *  from or compared against anything cryptographic here). */
export function submitConfirmPin(step: ChildOnboardingStep, pin: string): ConfirmPinResult {
  if (step.kind !== 'confirmPin') return { matched: false, step }
  if (pin !== step.firstPin) return { matched: false, step: { kind: 'pinMismatch' } }
  return { matched: true, pin }
}

/** "Let's try that again" tapped on the pinMismatch step — starts the PIN
 *  ceremony over from the first entry (never resumes into 'confirmPin' with
 *  a half-remembered first PIN; asking again from scratch is both simpler
 *  and safer). */
export function retryPinEntry(): ChildOnboardingStep {
  return { kind: 'setPin' }
}

/** The confirmPin step succeeded and the PIN has been sealed, but the
 *  offer's own root attestation would not verify — see `rootRejected`'s own
 *  doc comment on `ChildOnboardingStep`. */
export function rootRejectedStep(): ChildOnboardingStep {
  return { kind: 'rootRejected' }
}
