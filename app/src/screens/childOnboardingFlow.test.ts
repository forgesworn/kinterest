import { describe, expect, it } from 'vitest'
import { qrContent } from '../pairing/pairing'
import {
  offerAccepted,
  retryPinEntry,
  scanStep,
  submitConfirmPin,
  submitFirstPin,
  submitScannedText,
} from './childOnboardingFlow'

const VALID_QR = qrContent({
  guardianPk: 'a'.repeat(64),
  relays: ['wss://relay.example'],
  token: 'deadbeefdeadbeefdeadbeefdeadbeef',
})

describe('scanStep', () => {
  it('starts on scan with no error', () => {
    expect(scanStep()).toEqual({ kind: 'scan', error: null })
  })
})

describe('submitScannedText', () => {
  it('a valid QR line moves to waiting, carrying the guardian pk/token/relays', () => {
    const step = submitScannedText(VALID_QR)
    expect(step).toEqual({
      kind: 'waiting',
      guardianPk: 'a'.repeat(64),
      token: 'deadbeefdeadbeefdeadbeefdeadbeef',
      relays: ['wss://relay.example'],
    })
  })

  it('garbage text stays on scan with calm failure copy, never a throw', () => {
    expect(() => submitScannedText('not a qr code at all')).not.toThrow()
    const step = submitScannedText('not a qr code at all')
    expect(step.kind).toBe('scan')
    expect(step.kind === 'scan' && step.error).toBeTruthy()
  })

  it('is total against empty/undefined-ish input', () => {
    expect(() => submitScannedText('')).not.toThrow()
    expect(submitScannedText('').kind).toBe('scan')
  })
})

describe('offerAccepted', () => {
  it('moves waiting -> setPin', () => {
    const waiting = submitScannedText(VALID_QR)
    expect(offerAccepted(waiting)).toEqual({ kind: 'setPin' })
  })

  it('is a no-op from any other step', () => {
    expect(offerAccepted(scanStep())).toEqual(scanStep())
    expect(offerAccepted({ kind: 'setPin' })).toEqual({ kind: 'setPin' })
  })
})

describe('submitFirstPin', () => {
  it('a valid PIN on setPin moves to confirmPin, carrying it', () => {
    expect(submitFirstPin({ kind: 'setPin' }, '4242')).toEqual({ kind: 'confirmPin', firstPin: '4242' })
  })

  it('rejects a malformed PIN, staying on setPin', () => {
    expect(submitFirstPin({ kind: 'setPin' }, '12')).toEqual({ kind: 'setPin' })
    expect(submitFirstPin({ kind: 'setPin' }, 'abcd')).toEqual({ kind: 'setPin' })
  })

  it('is a no-op from any other step', () => {
    expect(submitFirstPin(scanStep(), '4242')).toEqual(scanStep())
  })
})

describe('submitConfirmPin', () => {
  it('matching PINs report matched: true with the PIN', () => {
    const step = submitFirstPin({ kind: 'setPin' }, '4242')
    expect(submitConfirmPin(step, '4242')).toEqual({ matched: true, pin: '4242' })
  })

  it('a mismatch moves to pinMismatch', () => {
    const step = submitFirstPin({ kind: 'setPin' }, '4242')
    expect(submitConfirmPin(step, '9999')).toEqual({ matched: false, step: { kind: 'pinMismatch' } })
  })

  it('is a no-op (matched: false, step unchanged) from any other step', () => {
    expect(submitConfirmPin(scanStep(), '4242')).toEqual({ matched: false, step: scanStep() })
  })
})

describe('retryPinEntry', () => {
  it('always returns setPin', () => {
    expect(retryPinEntry()).toEqual({ kind: 'setPin' })
  })
})
