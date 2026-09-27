import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  keyWipeDue,
  NATIVE_STOP_EVENT,
  SHELL_KEY_RETAIN_MS,
  SHELL_LOCK_GRACE_MS,
  shouldLock,
  wireKeyWipe,
  wireLock,
} from './lockPolicy'

afterEach(() => {
  vi.unstubAllGlobals()
})

// ============================================================================
// shouldLock — pure
// ============================================================================

describe('shouldLock', () => {
  it('never locks when the page has never been observed hidden', () => {
    expect(shouldLock(null, 1_000_000, 60_000)).toBe(false)
  })

  it('does not lock before the grace period elapses', () => {
    expect(shouldLock(1_000, 1_000 + 59_999, 60_000)).toBe(false)
  })

  it('locks exactly at the grace boundary — a full allowance counts as used up', () => {
    expect(shouldLock(1_000, 1_000 + 60_000, 60_000)).toBe(true)
  })

  it('locks well past the grace period', () => {
    expect(shouldLock(1_000, 1_000 + 600_000, 60_000)).toBe(true)
  })

  it('the default export SHELL_LOCK_GRACE_MS is 60s', () => {
    expect(SHELL_LOCK_GRACE_MS).toBe(60_000)
  })
})

// ============================================================================
// wireLock — the listener-wiring half. Driven with minimal fake
// window/document objects stubbed onto globalThis (this suite runs in the
// 'node' environment — see vite.config.ts — with no real DOM), the same
// pattern identity/vault.test.ts uses for IndexedDB.
// ============================================================================

function fakeEventTarget() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn)
    },
    fire: (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

describe('wireLock — plain browser (no window.KinjarShell)', () => {
  it('locks immediately on pagehide, and stops listening once unwired', () => {
    const win = fakeEventTarget()
    vi.stubGlobal('window', win)
    let locked = 0
    const unwire = wireLock(() => {
      locked += 1
    })

    expect(win.count('pagehide')).toBe(1)
    win.fire('pagehide')
    expect(locked).toBe(1)

    unwire()
    expect(win.count('pagehide')).toBe(0)
    win.fire('pagehide') // no-op after unwiring — nothing left listening
    expect(locked).toBe(1)
  })
})

describe('wireLock — Kinjar shell (window.KinjarShell present)', () => {
  function fakeShellWindow() {
    return { ...fakeEventTarget(), KinjarShell: {} }
  }

  function fakeDocument() {
    const target = fakeEventTarget()
    return { ...target, visibilityState: 'visible' as 'visible' | 'hidden' }
  }

  it('does not lock on a brief backgrounding well under the grace period', () => {
    vi.stubGlobal('window', fakeShellWindow())
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let now = 1_000_000
    let locked = 0
    wireLock(
      () => {
        locked += 1
      },
      { now: () => now, graceMs: 60_000 },
    )

    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    now += 10_000 // 10s hidden, well under the 60s grace
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')

    expect(locked).toBe(0)
  })

  it('locks once hidden for >= the grace period by the time the page is visible again', () => {
    vi.stubGlobal('window', fakeShellWindow())
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let now = 1_000_000
    let locked = 0
    wireLock(
      () => {
        locked += 1
      },
      { now: () => now, graceMs: 60_000 },
    )

    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    now += 60_000
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')

    expect(locked).toBe(1)
  })

  it('a second brief hide after an already-cleared window does not carry over the old timestamp', () => {
    vi.stubGlobal('window', fakeShellWindow())
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let now = 1_000_000
    let locked = 0
    wireLock(
      () => {
        locked += 1
      },
      { now: () => now, graceMs: 60_000 },
    )

    // First hide/show cycle: brief, no lock.
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    now += 5_000
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    expect(locked).toBe(0)

    // Second cycle starts its own fresh grace window rather than measuring
    // from the FIRST hide — another brief hide must still not lock.
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    now += 5_000
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    expect(locked).toBe(0)
  })

  it('does not attach a pagehide listener in the shell branch', () => {
    const win = fakeShellWindow()
    vi.stubGlobal('window', win)
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    wireLock(() => {})
    expect(win.count('pagehide')).toBe(0)
  })

  it('cleans up the visibilitychange listener once unwired', () => {
    vi.stubGlobal('window', fakeShellWindow())
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    const unwire = wireLock(() => {})

    expect(doc.count('visibilitychange')).toBe(1)
    unwire()
    expect(doc.count('visibilitychange')).toBe(0)
  })

  // Native backstop — Task 2 MUST-CARRY: MainActivity.onStop() dispatches
  // NATIVE_STOP_EVENT on window; the shell branch must treat it as an
  // immediate, ungraced lock (the Activity itself has confirmed it is
  // backgrounded, so there is nothing left to wait out).
  it('locks immediately on the native-stop event, without waiting for the grace period', () => {
    const win = fakeShellWindow()
    vi.stubGlobal('window', win)
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let locked = 0
    wireLock(
      () => {
        locked += 1
      },
      { graceMs: 60_000 },
    )

    win.fire(NATIVE_STOP_EVENT)
    expect(locked).toBe(1)
  })

  it('stops listening for the native-stop event once unwired', () => {
    const win = fakeShellWindow()
    vi.stubGlobal('window', win)
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let locked = 0
    const unwire = wireLock(() => {
      locked += 1
    })

    expect(win.count(NATIVE_STOP_EVENT)).toBe(1)
    unwire()
    expect(win.count(NATIVE_STOP_EVENT)).toBe(0)
    win.fire(NATIVE_STOP_EVENT)
    expect(locked).toBe(0)
  })
})

// ============================================================================
// keyWipeDue / wireKeyWipe — v0.2 spec §2.6. The UI lock and the key wipe are
// now two decisions: locking the screen the moment a shell session is
// backgrounded is right, but throwing the key away with it stopped sync and
// notifications dead, which is exactly what a backgrounded child device is
// supposed to keep doing.
// ============================================================================

describe('keyWipeDue', () => {
  it('mirrors shouldLock boundary semantics', () => {
    expect(keyWipeDue(null, 10_000, 1000)).toBe(false)
    expect(keyWipeDue(0, 999, 1000)).toBe(false)
    expect(keyWipeDue(0, 1000, 1000)).toBe(true)
  })

  it('the default retention window is 30 minutes', () => {
    expect(SHELL_KEY_RETAIN_MS).toBe(30 * 60 * 1000)
  })
})

describe('wireKeyWipe — plain browser', () => {
  it('wipes on pagehide, and stops listening once unwired', () => {
    const win = fakeEventTarget()
    vi.stubGlobal('window', win)
    let wiped = 0
    const off = wireKeyWipe(() => {
      wiped += 1
    })

    win.fire('pagehide')
    expect(wiped).toBe(1)
    off()
    expect(win.count('pagehide')).toBe(0)
    win.fire('pagehide')
    expect(wiped).toBe(1)
  })
})

describe('wireKeyWipe — Kinjar shell', () => {
  function fakeShellWindow() {
    return { ...fakeEventTarget(), KinjarShell: {} }
  }

  function fakeDocument() {
    const target = fakeEventTarget()
    return { ...target, visibilityState: 'visible' as 'visible' | 'hidden' }
  }

  it('does not wipe on the native stop event, but exceeding the window does', () => {
    const win = fakeShellWindow()
    vi.stubGlobal('window', win)
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let now = 0
    let wiped = 0
    const off = wireKeyWipe(
      () => {
        wiped += 1
      },
      { retainMs: 1000, now: () => now, checkMs: 100 },
    )

    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    win.fire(NATIVE_STOP_EVENT)
    expect(wiped).toBe(0)

    now = 1000
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    expect(wiped).toBe(1)
    off()
  })

  it('keeps the key across a brief backgrounding', () => {
    vi.stubGlobal('window', fakeShellWindow())
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let now = 0
    let wiped = 0
    const off = wireKeyWipe(
      () => {
        wiped += 1
      },
      { retainMs: 1000, now: () => now },
    )

    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    now = 999
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    expect(wiped).toBe(0)
    off()
  })

  it('wipes on the interval while still hidden, and only once', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', fakeShellWindow())
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let now = 0
    let wiped = 0
    const off = wireKeyWipe(
      () => {
        wiped += 1
      },
      { retainMs: 1000, now: () => now, checkMs: 100 },
    )

    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    now = 500
    vi.advanceTimersByTime(500)
    expect(wiped).toBe(0)
    now = 1000
    vi.advanceTimersByTime(500)
    expect(wiped).toBe(1)
    // Still hidden, still ticking — but the key is already gone, so nothing
    // fires again until a fresh hide starts a fresh window.
    now = 5000
    vi.advanceTimersByTime(1000)
    expect(wiped).toBe(1)

    off()
    vi.useRealTimers()
  })

  it('stops checking once unwired', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', fakeShellWindow())
    const doc = fakeDocument()
    vi.stubGlobal('document', doc)
    let wiped = 0
    const off = wireKeyWipe(
      () => {
        wiped += 1
      },
      { retainMs: 1000, now: () => 10_000, checkMs: 100 },
    )

    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    off()
    expect(doc.count('visibilitychange')).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(wiped).toBe(0)
    vi.useRealTimers()
  })

  it('does not attach a pagehide or native-stop listener in the shell branch', () => {
    const win = fakeShellWindow()
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', fakeDocument())
    const off = wireKeyWipe(() => {})
    expect(win.count('pagehide')).toBe(0)
    expect(win.count(NATIVE_STOP_EVENT)).toBe(0)
    off()
  })
})

// Review fix (round 1): `wireKeyWipe` used to seed `hiddenAtMs` as null, so a
// re-arm while the page was ALREADY hidden (the store re-runs its effect
// whenever role/key/relay change, and an inbound wrap can do that with the
// app in the background) started no retention window at all — the key then
// survived until the next hide, however long the app stayed backgrounded.
describe('wireKeyWipe — armed while already hidden', () => {
  function fakeShellWindow() {
    return { ...fakeEventTarget(), KinjarShell: {} }
  }

  it('seeds the retention window from the current visibility state', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', fakeShellWindow())
    const target = fakeEventTarget()
    vi.stubGlobal('document', { ...target, visibilityState: 'hidden' as const })
    let now = 0
    let wiped = 0
    const off = wireKeyWipe(
      () => {
        wiped += 1
      },
      { retainMs: 1000, now: () => now, checkMs: 100 },
    )

    now = 999
    vi.advanceTimersByTime(999)
    expect(wiped).toBe(0)
    now = 1000
    vi.advanceTimersByTime(100)
    expect(wiped).toBe(1)

    off()
    vi.useRealTimers()
  })

  it('starts no window when armed while visible', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', fakeShellWindow())
    const target = fakeEventTarget()
    vi.stubGlobal('document', { ...target, visibilityState: 'visible' as const })
    let wiped = 0
    const off = wireKeyWipe(
      () => {
        wiped += 1
      },
      { retainMs: 1000, now: () => 100_000, checkMs: 100 },
    )

    vi.advanceTimersByTime(10_000)
    expect(wiped).toBe(0)
    off()
    vi.useRealTimers()
  })
})
