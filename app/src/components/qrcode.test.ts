import { describe, expect, it } from 'vitest'
import { qrDataUrl } from './QRCode'

describe('qrDataUrl', () => {
  it('renders a data: URL', () => {
    expect(qrDataUrl('kin-jar-pair:v1?g=abc&t=def')).toMatch(/^data:image\//)
  })

  it('varies with input content', () => {
    const a = qrDataUrl('payload-a')
    const b = qrDataUrl('payload-b')
    expect(a).not.toBe(b)
  })

  it('encodes a realistic pairing URI (guardian pk + relay + token) without throwing', () => {
    const uri = `kin-jar-pair:v1?g=${'a'.repeat(64)}&r=${encodeURIComponent('wss://relay.example.com')}&t=${'b'.repeat(32)}`
    expect(() => qrDataUrl(uri)).not.toThrow()
  })

  it('is deterministic for the same input', () => {
    expect(qrDataUrl('same')).toBe(qrDataUrl('same'))
  })
})
