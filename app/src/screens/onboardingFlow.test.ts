import { describe, expect, it } from 'vitest'
import {
  addChildStep,
  backToWelcome,
  beginMnemonicReveal,
  beginRestore,
  beginSignetConnect,
  beginSignetRecover,
  signetFailed,
  signetSucceeded,
  confirmMnemonicWritten,
  normalizeMnemonicInput,
  submitRestoreMnemonic,
  welcomeStep,
  type OnboardingStep,
} from './onboardingFlow'

describe('welcomeStep / addChildStep / backToWelcome', () => {
  it('are the expected fixed steps', () => {
    expect(welcomeStep()).toEqual({ kind: 'welcome' })
    expect(addChildStep()).toEqual({ kind: 'addChild' })
    expect(backToWelcome()).toEqual({ kind: 'welcome' })
  })
})

describe('beginMnemonicReveal / beginRestore', () => {
  it('carries the supplied mnemonic', () => {
    expect(beginMnemonicReveal('one two three')).toEqual({ kind: 'mnemonicReveal', mnemonic: 'one two three' })
  })

  it('starts restore entry with no error', () => {
    expect(beginRestore()).toEqual({ kind: 'restoreEntry', error: null })
  })
})

describe('confirmMnemonicWritten', () => {
  it('advances mnemonicReveal -> addChild', () => {
    const step = beginMnemonicReveal('words here')
    expect(confirmMnemonicWritten(step)).toEqual({ kind: 'addChild' })
  })

  it('is a no-op from any other step', () => {
    const steps: OnboardingStep[] = [welcomeStep(), beginRestore(), addChildStep()]
    for (const step of steps) {
      expect(confirmMnemonicWritten(step)).toBe(step)
    }
  })
})

describe('submitRestoreMnemonic', () => {
  const alwaysValid = () => true
  const alwaysInvalid = () => false

  it('advances restoreEntry -> addChild when validate() accepts', () => {
    const step = beginRestore()
    expect(submitRestoreMnemonic(step, 'abandon abandon about', alwaysValid)).toEqual({ kind: 'addChild' })
  })

  it('fails closed and calmly when validate() rejects — stays on restoreEntry with an error, never throws', () => {
    const step = beginRestore()
    const next = submitRestoreMnemonic(step, 'not a real mnemonic', alwaysInvalid)
    expect(next.kind).toBe('restoreEntry')
    expect((next as { kind: 'restoreEntry'; error: string | null }).error).toEqual(expect.any(String))
  })

  it('trims whitespace before validating', () => {
    let seen: string | null = null
    const capture = (m: string) => {
      seen = m
      return true
    }
    submitRestoreMnemonic(beginRestore(), '  abandon abandon about  \n', capture)
    expect(seen).toBe('abandon abandon about')
  })

  it('is a no-op from any step other than restoreEntry', () => {
    const steps: OnboardingStep[] = [welcomeStep(), beginMnemonicReveal('x'), addChildStep()]
    for (const step of steps) {
      expect(submitRestoreMnemonic(step, 'anything', alwaysValid)).toBe(step)
    }
  })

  it('a second submission after a failure can still succeed (error does not stick)', () => {
    const failed = submitRestoreMnemonic(beginRestore(), 'bad', alwaysInvalid)
    const retried = submitRestoreMnemonic(failed, 'good words now', alwaysValid)
    expect(retried).toEqual({ kind: 'addChild' })
  })

  // A phone keyboard capitalising the first word, or a
  // pasted phrase split across lines, must not make an otherwise-correct
  // mnemonic fail validation.
  it('normalises case and line breaks before validating', () => {
    let seen: string | null = null
    const capture = (m: string) => {
      seen = m
      return true
    }
    submitRestoreMnemonic(beginRestore(), 'Abandon\nabandon  ABOUT', capture)
    expect(seen).toBe('abandon abandon about')
  })
})

describe('normalizeMnemonicInput', () => {
  it('lower-cases and collapses whitespace runs (spaces, newlines, tabs) to single spaces', () => {
    expect(normalizeMnemonicInput('Abandon\nAbandon   About')).toBe('abandon abandon about')
    expect(normalizeMnemonicInput('abandon\tabandon about')).toBe('abandon abandon about')
  })

  it('trims leading/trailing whitespace', () => {
    expect(normalizeMnemonicInput('  abandon abandon about  \n')).toBe('abandon abandon about')
  })

  it('is a no-op on already-normalised input (idempotent)', () => {
    const normalized = 'abandon abandon about'
    expect(normalizeMnemonicInput(normalized)).toBe(normalized)
    expect(normalizeMnemonicInput(normalizeMnemonicInput('ABANDON  about'))).toBe(normalizeMnemonicInput('ABANDON  about'))
  })

  it('whitespace-only input normalises to the empty string', () => {
    expect(normalizeMnemonicInput('   \n\t ')).toBe('')
  })
})

// --- v0.2 §1.8: the My Signet steps -------------------------------------------

describe('the My Signet steps', () => {
  it('has signet connecting and recovering steps reachable from welcome', () => {
    expect(beginSignetConnect()).toEqual({ kind: 'signetConnecting' })
    expect(beginSignetRecover()).toEqual({ kind: 'signetRecovering', error: null })
    expect(signetFailed(beginSignetConnect(), 'nope')).toEqual({ kind: 'welcome', error: 'nope' })
    expect(signetSucceeded(beginSignetConnect())).toEqual({ kind: 'addChild' })
  })

  it('reports a recovery failure on the recovery step, not back on welcome', () => {
    expect(signetFailed(beginSignetRecover(), 'no family there')).toEqual({
      kind: 'signetRecovering',
      error: 'no family there',
    })
  })

  it('advances a successful recovery to addChild too', () => {
    expect(signetSucceeded(beginSignetRecover())).toEqual({ kind: 'addChild' })
  })

  it('is a no-op from any step that is not a signet step', () => {
    const steps: OnboardingStep[] = [welcomeStep(), beginMnemonicReveal('x'), beginRestore(), addChildStep()]
    for (const step of steps) {
      expect(signetFailed(step, 'nope')).toBe(step)
      expect(signetSucceeded(step)).toBe(step)
    }
  })

  it('welcomeStep still equals a bare welcome — the error is optional', () => {
    expect(welcomeStep()).toEqual({ kind: 'welcome' })
    expect(backToWelcome()).toEqual({ kind: 'welcome' })
  })
})
