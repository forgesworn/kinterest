// The pure step machine behind screens/Onboarding.tsx. See
// internal plan 2026-08-11-parent-mode, Task 3, and the v0.3 "My Signet is
// mandatory for guardians" change: Welcome now offers only "Sign in with My
// Signet" (fresh family) and "I already have a family on My Signet"
// (recovery), plus the child's own "Join your family". The standalone
// mnemonic-ceremony setup path (a phrase root with no Signet at all) is no
// longer reachable from the UI, and a failed Signet sign-in no longer falls
// back to showing the mnemonic — the family mnemonic is always generated (or
// restored) silently, per Signet-side design. Recovery words remain a
// fallback, but only INSIDE the Signet recovery path: when
// "I already have a family on My Signet" cannot find or pick a vault, the
// screen offers restoring from words instead — reachable only from there,
// via `beginRestore()`.
//
// Deliberately knows nothing about AppState, the vault, or dispatch — every
// transition here is a total, side-effect-free function of the CURRENT step
// (plus whatever the caller supplies: a freshly generated mnemonic, typed
// restore input, an injected validator). Onboarding.tsx is what turns a step
// into actual identity — deriving keys, storing the mnemonic in the vault,
// dispatching into the store, sealing a root to My Signet — this module only
// ever decides WHICH SCREEN comes next, so it is testable with no BIP-39
// wordlist, no crypto, no React at all.

export type OnboardingStep =
  /** `error` is set only by a failed My Signet sign-in bouncing back here —
   *  absent on every other path, so a plain `welcomeStep()` still equals a
   *  bare `{ kind: 'welcome' }` (v0.2 spec §1.8). */
  | { kind: 'welcome'; error?: string }
  | { kind: 'restoreEntry'; error: string | null }
  /** The My Signet picker is open. No error field: a failure here goes back
   *  to `welcome` carrying the message, because the family IS already set up
   *  with a phrase root by this point and the user can simply carry on. */
  | { kind: 'signetConnecting' }
  /** "I already have a family on My Signet" — the picker, then a bounded
   *  relay hunt for the newest vault. A failure STAYS here (with an error):
   *  unlike sign-in, nothing has been set up yet, so bouncing to welcome
   *  would lose the user's place in the one flow that can recover them. */
  | { kind: 'signetRecovering'; error: string | null }
  | { kind: 'addChild' }

export function welcomeStep(): OnboardingStep {
  return { kind: 'welcome' }
}

export function addChildStep(): OnboardingStep {
  return { kind: 'addChild' }
}

/** "Use recovery words instead" — reachable only from a `signetRecovering`
 *  step that ended in no-vault, too-many-candidates or conflicting-vaults
 *  (Onboarding.tsx decides which errors offer this; see its
 *  `offersWordsFallback`). Onboarding.tsx tracks separately that a restore
 *  reached this way must be bound back to the signed-in Signet session once
 *  the words validate — that binding is a side effect, so it stays out of
 *  this pure step type, the same way `familyMnemonic`/`restoreInput` already
 *  live in the screen's own React state rather than in a step. */
export function beginRestore(): OnboardingStep {
  return { kind: 'restoreEntry', error: null }
}

/** Any step's "start over" affordance. */
export function backToWelcome(): OnboardingStep {
  return welcomeStep()
}

/** Normalises pasted/typed recovery-words input before it is ever validated
 *  or used to derive a key: a phone keyboard capitalises
 *  the first word, autocorrect/newlines can leave stray capitals or split
 *  words across lines, and a fat-fingered double space is easy to miss.
 *  None of that changes what the words ARE, but `@scure/bip39`'s wordlist
 *  lookup is exact-match, so any of it makes a perfectly correct phrase
 *  fail `validateMnemonic` with no way for the user to tell why. Lower-cases
 *  and collapses every run of whitespace (including newlines) to a single
 *  space, after trimming the ends. Pure, and idempotent — normalising an
 *  already-normalised string returns it unchanged. */
export function normalizeMnemonicInput(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).join(' ')
}

/** Submits a pasted recovery-words textarea on the restore step. `validate`
 *  is injected (identity/derive.ts's `validateMnemonic` in production)
 *  rather than imported directly, so this module's transition table stays
 *  testable without a real BIP-39 wordlist and without pulling
 *  identity/derive.ts's dependencies into every caller of this module.
 *
 *  `input` is run through `normalizeMnemonicInput` before validating — the
 *  caller (Onboarding.tsx) must derive the mnemonic it actually commits
 *  from THE SAME normalised text, never a separately-trimmed copy of the
 *  raw textarea value, or the two could silently disagree on what was just
 *  validated.
 *
 *  Fails closed and calmly: an invalid mnemonic stays on `restoreEntry`
 *  with a plain-language `error` set, never throws, and never lets a bad
 *  restore attempt silently proceed. Only meaningful from `restoreEntry` —
 *  a no-op (returns `step` unchanged) from any other step. */
export function submitRestoreMnemonic(
  step: OnboardingStep,
  input: string,
  validate: (mnemonic: string) => boolean,
): OnboardingStep {
  if (step.kind !== 'restoreEntry') return step
  const normalized = normalizeMnemonicInput(input)
  if (!validate(normalized)) {
    return { kind: 'restoreEntry', error: "Those words don't look right — check the spelling and try again." }
  }
  return addChildStep()
}

/** "Sign in with My Signet" tapped on the welcome step. */
export function beginSignetConnect(): OnboardingStep {
  return { kind: 'signetConnecting' }
}

/** "I already have a family on My Signet" tapped on the welcome step. */
export function beginSignetRecover(): OnboardingStep {
  return { kind: 'signetRecovering', error: null }
}

/** A My Signet step that did not get where it was going — a cancelled picker,
 *  an attestation that would not verify, no vault found. Sign-in returns to
 *  `welcome` with the message (the family is already usable, silently backed
 *  by its mnemonic); recovery stays put with the message (nothing is set up
 *  yet, and some of these errors offer "use recovery words instead" —
 *  Onboarding.tsx's call, from the error text). A no-op from any other step,
 *  so the transition table stays total. */
export function signetFailed(step: OnboardingStep, error: string): OnboardingStep {
  if (step.kind === 'signetConnecting') return { kind: 'welcome', error }
  if (step.kind === 'signetRecovering') return { kind: 'signetRecovering', error }
  return step
}

/** A My Signet step that succeeded — both paths land on "add your first
 *  child". No mnemonic ceremony on either: sign-in generated the mnemonic
 *  silently and vaulted it (spec §1.2), recovery restored one that is already
 *  sealed to the signed-in Signet identity. A no-op from any other step. */
export function signetSucceeded(step: OnboardingStep): OnboardingStep {
  return step.kind === 'signetConnecting' || step.kind === 'signetRecovering' ? addChildStep() : step
}
