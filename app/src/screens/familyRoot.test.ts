import { describe, expect, it } from 'vitest'
import { rootCardModel } from './familyRoot'
import type { RootRecord } from '../state/types'

const fmt = () => '2 September 2026'

describe('rootCardModel', () => {
  it('offers Connect when there is no signet root', () => {
    for (const r of [null, { kind: 'phrase' } as const] satisfies (RootRecord | null)[]) {
      const m = rootCardModel(r, fmt)
      expect(m.showConnectButton).toBe(true)
      expect(m.showDisconnectButton).toBe(false)
      expect(m.backupLine).toBeNull()
      expect(m.showBackupButton).toBe(false)
      expect(m.title).toBe('Family root')
    }
  })

  it('shows the backup date when backed up', () => {
    const m = rootCardModel(
      { kind: 'signet', pubkey: 'a'.repeat(64), authEvent: {} as never, displayName: 'Alex', backedUpAt: 1756800000 },
      fmt,
    )
    expect(m.subtitle).toBe('Signed in as Alex')
    expect(m.backupLine).toBe('Backed up to My Signet ✓ 2 September 2026')
    expect(m.showDisconnectButton).toBe(false)
    expect(m.showConnectButton).toBe(false)
    // Fix round 1: backing up again must ALWAYS be reachable. A re-publish
    // that silently failed (a roster change made offline, say) otherwise has
    // no remedy anywhere in the app.
    expect(m.showBackupButton).toBe(true)
    expect(m.backupButtonLabel).toBe('Back up again')
  })

  it('falls back to a short npub and offers Back up now', () => {
    const pk = 'ab'.repeat(32)
    const m = rootCardModel({ kind: 'signet', pubkey: pk, authEvent: {} as never, backedUpAt: null }, fmt)
    expect(m.subtitle).toBe(`Signed in as ${pk.slice(0, 8)}…${pk.slice(-8)}`)
    expect(m.showBackupButton).toBe(true)
    expect(m.backupButtonLabel).toBe('Back up now')
    expect(m.backupLine).toBeNull()
  })

  it('passes the stored unix SECONDS straight to the injected formatter', () => {
    let seen: number | null = null
    rootCardModel({ kind: 'signet', pubkey: 'a'.repeat(64), authEvent: {} as never, backedUpAt: 1756800000 }, (s) => {
      seen = s
      return 'x'
    })
    expect(seen).toBe(1756800000)
  })

  it('is pure and total — a blank display name falls back to the short npub', () => {
    const pk = 'cd'.repeat(32)
    const m = rootCardModel({ kind: 'signet', pubkey: pk, authEvent: {} as never, displayName: '  ', backedUpAt: null }, fmt)
    expect(m.subtitle).toBe(`Signed in as ${pk.slice(0, 8)}…${pk.slice(-8)}`)
  })
})
