import { describe, expect, it } from 'vitest'
import { avatarUrl } from './childAvatar'
describe('consented encrypted child avatar hosts', () => {
  it('uses public HTTPS without credentials or redirects', () => {
    expect(avatarUrl('https://blossom.example/assets/','a'.repeat(64))).toBe(`https://blossom.example/assets/${'a'.repeat(64)}`)
    for (const host of ['http://blossom.example','https://localhost','https://127.0.0.1','https://2130706433','https://[::1]','https://test.local','https://user:pass@blossom.example','https://blossom.example/?key=secret']) expect(() => avatarUrl(host,'a'.repeat(64))).toThrow()
  })
})
