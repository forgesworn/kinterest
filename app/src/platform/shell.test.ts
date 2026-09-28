// vitest runs in the 'node' environment (see vite.config.ts) — `window`
// simply doesn't exist there by default, which conveniently exercises
// `isShell()`'s "every plain browser/no bridge" answer for free. The shell
// branch is driven by `vi.stubGlobal('window', …)`, the same pattern
// identity/vault.test.ts uses (via fake-indexeddb) to run DOM/browser-shaped
// code under this environment without a real jsdom dependency.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isShell,
  notify,
  requestNotificationPermission,
  shellInfo,
  startRelayService,
  stopRelayService,
} from './shell'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isShell', () => {
  it('is false with no window at all — the plain-browser default this environment already exercises', () => {
    expect(isShell()).toBe(false)
  })

  it('is false when window exists but has no KinjarShell', () => {
    vi.stubGlobal('window', {})
    expect(isShell()).toBe(false)
  })

  it('is false when KinjarShell is present but null/non-object', () => {
    vi.stubGlobal('window', { KinjarShell: null })
    expect(isShell()).toBe(false)
  })

  it('is true once window.KinjarShell is an object', () => {
    vi.stubGlobal('window', { KinjarShell: {} })
    expect(isShell()).toBe(true)
  })
})

describe('shellInfo', () => {
  it('is null outside the shell', () => {
    expect(shellInfo()).toBeNull()
  })

  it('reports null fields when the bridge has no version() method (an older shell)', () => {
    vi.stubGlobal('window', { KinjarShell: {} })
    expect(shellInfo()).toEqual({ versionName: null, versionCode: null })
  })

  it('parses a well-formed version() payload', () => {
    vi.stubGlobal('window', { KinjarShell: { version: () => '{"versionName":"1.0","versionCode":3}' } })
    expect(shellInfo()).toEqual({ versionName: '1.0', versionCode: 3 })
  })

  it('is total against non-JSON garbage from version()', () => {
    vi.stubGlobal('window', { KinjarShell: { version: () => 'not json' } })
    expect(shellInfo()).toEqual({ versionName: null, versionCode: null })
  })

  it('is total against a version() payload with the wrong field types', () => {
    vi.stubGlobal('window', { KinjarShell: { version: () => '{"versionName":1,"versionCode":"x"}' } })
    expect(shellInfo()).toEqual({ versionName: null, versionCode: null })
  })

  it('is total against a version() payload that is not an object at all', () => {
    vi.stubGlobal('window', { KinjarShell: { version: () => '"just a string"' } })
    expect(shellInfo()).toEqual({ versionName: null, versionCode: null })
  })
})

describe('startRelayService / stopRelayService / notify — spec §3.2', () => {
  it('are all no-ops and do not throw with no window at all', () => {
    expect(() => startRelayService()).not.toThrow()
    expect(() => stopRelayService()).not.toThrow()
    expect(() => notify({ title: 't', body: 'b', tag: 'g' })).not.toThrow()
  })

  it('startRelayService calls through to the bridge', () => {
    const startRelayServiceMock = vi.fn()
    vi.stubGlobal('window', {
      KinjarShell: { startRelayService: startRelayServiceMock, stopRelayService: vi.fn(), notify: vi.fn() },
    })
    startRelayService()
    expect(startRelayServiceMock).toHaveBeenCalledTimes(1)
    expect(startRelayServiceMock).toHaveBeenCalledWith()
  })

  it('stopRelayService calls through to the bridge', () => {
    const stopRelayServiceMock = vi.fn()
    vi.stubGlobal('window', {
      KinjarShell: { startRelayService: vi.fn(), stopRelayService: stopRelayServiceMock, notify: vi.fn() },
    })
    stopRelayService()
    expect(stopRelayServiceMock).toHaveBeenCalledTimes(1)
    expect(stopRelayServiceMock).toHaveBeenCalledWith()
  })

  it('notify calls through to the bridge with three positional strings', () => {
    const notifyMock = vi.fn()
    vi.stubGlobal('window', {
      KinjarShell: { startRelayService: vi.fn(), stopRelayService: vi.fn(), notify: notifyMock },
    })
    notify({ title: 'New ask from Alex', body: 'GBP 5.00 — tap to decide', tag: 'ask:r1' })
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock).toHaveBeenCalledWith('New ask from Alex', 'GBP 5.00 — tap to decide', 'ask:r1')
  })

  it('all three degrade to a silent no-op when window.KinjarShell = {}', () => {
    vi.stubGlobal('window', { KinjarShell: {} })
    expect(() => startRelayService()).not.toThrow()
    expect(() => stopRelayService()).not.toThrow()
    expect(() => notify({ title: 't', body: 'b', tag: 'g' })).not.toThrow()
  })

  it('a bridge whose method throws is swallowed, not rethrown', () => {
    vi.stubGlobal('window', {
      KinjarShell: {
        startRelayService: () => {
          throw new Error('boom')
        },
        stopRelayService: () => {
          throw new Error('boom')
        },
        notify: () => {
          throw new Error('boom')
        },
      },
    })
    expect(() => startRelayService()).not.toThrow()
    expect(() => stopRelayService()).not.toThrow()
    expect(() => notify({ title: 't', body: 'b', tag: 'g' })).not.toThrow()
  })

  it('notify falls back to a silent no-op in a plain browser with no Notification API', () => {
    vi.stubGlobal('window', {})
    expect(() => notify({ title: 't', body: 'b', tag: 'g' })).not.toThrow()
  })

  // notify() runs from a hidden page with no user
  // activation, where a permission request can never succeed — so it must
  // never ask. Asking is requestNotificationPermission()'s job, from a gesture.
  it('notify never requests permission, and shows nothing, while permission is still default', () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const NotificationMock = vi.fn() as unknown as { permission: string; requestPermission: typeof requestPermission } & (new (
      title: string,
      options?: { body?: string; tag?: string },
    ) => void)
    NotificationMock.permission = 'default'
    NotificationMock.requestPermission = requestPermission
    vi.stubGlobal('window', {})
    vi.stubGlobal('Notification', NotificationMock)
    expect(() => notify({ title: 't', body: 'b', tag: 'g' })).not.toThrow()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(NotificationMock).not.toHaveBeenCalled()
  })

  it('notify prefers a service-worker registration\'s showNotification when one exists', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined)
    const NotificationMock = vi.fn() as unknown as { permission: string }
    NotificationMock.permission = 'granted'
    vi.stubGlobal('window', {})
    vi.stubGlobal('Notification', NotificationMock)
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ showNotification }) } })
    notify({ title: 'New ask from Alex', body: 'GBP 5.00 — tap to decide', tag: 'ask:r1' })
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
    expect(showNotification).toHaveBeenCalledWith('New ask from Alex', { body: 'GBP 5.00 — tap to decide', tag: 'ask:r1' })
    expect(NotificationMock).not.toHaveBeenCalled()
  })

  it('notify degrades silently when the constructor throws (Chrome on Android: Illegal constructor)', async () => {
    const NotificationMock = vi.fn(() => {
      throw new TypeError('Illegal constructor')
    }) as unknown as { permission: string }
    NotificationMock.permission = 'granted'
    vi.stubGlobal('window', {})
    vi.stubGlobal('Notification', NotificationMock)
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined) } })
    expect(() => notify({ title: 't', body: 'b', tag: 'g' })).not.toThrow()
    await vi.waitFor(() => expect(NotificationMock).toHaveBeenCalledTimes(1))
  })

  it('notify swallows a rejected getRegistration', async () => {
    const getRegistration = vi.fn().mockRejectedValue(new Error('boom'))
    const NotificationMock = vi.fn() as unknown as { permission: string }
    NotificationMock.permission = 'granted'
    vi.stubGlobal('window', {})
    vi.stubGlobal('Notification', NotificationMock)
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration } })
    expect(() => notify({ title: 't', body: 'b', tag: 'g' })).not.toThrow()
    await vi.waitFor(() => expect(getRegistration).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(NotificationMock).not.toHaveBeenCalled()
  })

  // Fix round 1 (MINOR): the branch above only ever exercised
  // Notification.permission === 'default' — the already-granted case (a
  // returning user who granted permission on an earlier visit) falls
  // through to the actual `new Notification(...)` call, which was
  // previously untested.
  it('notify constructs a real Notification when permission is already granted', () => {
    const NotificationMock = vi.fn() as unknown as { permission: string } & (new (
      title: string,
      options?: { body?: string; tag?: string },
    ) => void)
    NotificationMock.permission = 'granted'
    vi.stubGlobal('window', {})
    vi.stubGlobal('Notification', NotificationMock)
    expect(() => notify({ title: 'New ask from Alex', body: 'GBP 5.00 — tap to decide', tag: 'ask:r1' })).not.toThrow()
    expect(NotificationMock).toHaveBeenCalledTimes(1)
    expect(NotificationMock).toHaveBeenCalledWith('New ask from Alex', { body: 'GBP 5.00 — tap to decide', tag: 'ask:r1' })
  })
})

describe('requestNotificationPermission — gesture-only', () => {
  it('asks the browser once when permission is still default', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('window', {})
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    await expect(requestNotificationPermission()).resolves.toBe('granted')
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('does not re-ask once the user has answered', async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('window', {})
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission })
    await expect(requestNotificationPermission()).resolves.toBe('denied')
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it("resolves 'unsupported' with no Notification API, and 'granted' inside the shell", async () => {
    vi.stubGlobal('window', {})
    await expect(requestNotificationPermission()).resolves.toBe('unsupported')
    vi.stubGlobal('window', { KinjarShell: { notify: vi.fn() } })
    await expect(requestNotificationPermission()).resolves.toBe('granted')
  })

  it('never rejects, even if the browser request throws', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn().mockRejectedValue(new Error('x')) })
    await expect(requestNotificationPermission()).resolves.toBe('denied')
  })
})
