import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
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

  // Renders the SVG inside the data: URL (runs of `M<x> <y>h<w>v1h-<w>z` in
  // module units) to pixels and reads it back with jsQR, the decoder the app
  // scans with, so the test covers the real rendered output.
  it('is an SVG that jsQR reads back', () => {
    const uri = `kin-jar-pair:v1?g=${'a'.repeat(64)}&r=${encodeURIComponent('wss://relay.example.com')}&t=${'b'.repeat(32)}`
    const url = qrDataUrl(uri)
    expect(url).toMatch(/^data:image\/svg\+xml/)
    const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1))
    const side = Number(/viewBox="0 0 (\d+) /.exec(svg)![1])
    const scale = 4
    const px = side * scale
    const rgba = new Uint8ClampedArray(px * px * 4).fill(255)
    for (const [, x, y, w] of svg.matchAll(/M(\d+) (\d+)h(\d+)v1/g)) {
      for (let j = 0; j < scale; j++) {
        for (let i = 0; i < Number(w) * scale; i++) {
          const o = ((Number(y) * scale + j) * px + Number(x) * scale + i) * 4
          rgba[o] = rgba[o + 1] = rgba[o + 2] = 0
        }
      }
    }
    expect(jsQR(rgba, px, px)?.data).toBe(uri)
  })

  it('keeps a whole-module quiet zone of 4', () => {
    expect(decodeURIComponent(qrDataUrl('x').split(',')[1]!)).toMatch(/M4 4h/)
  })
})
