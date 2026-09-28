// vitest runs in the 'node' environment (see vite.config.ts) — `window`
// simply doesn't exist there by default, exercising this module's "no DOM
// at all" answers for free. The DOM-shaped branches are driven by
// `vi.stubGlobal`, the same pattern shell.test.ts/lockPolicy.test.ts use.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeInitialPendingRoute, onPendingRoute, parsePendingRouteFragment, PENDING_ROUTE_EVENT } from './pendingRoute'

afterEach(() => {
  vi.unstubAllGlobals()
})

// ============================================================================
// parsePendingRouteFragment — pure
// ============================================================================

describe('parsePendingRouteFragment', () => {
  it('parses a bare #route=approvals fragment', () => {
    expect(parsePendingRouteFragment('#route=approvals')).toBe('approvals')
  })

  it('parses route alongside other params, in either order', () => {
    expect(parsePendingRouteFragment('#route=approvals&x=1')).toBe('approvals')
    expect(parsePendingRouteFragment('#x=1&route=approvals')).toBe('approvals')
  })

  it('is null for an empty fragment', () => {
    expect(parsePendingRouteFragment('')).toBeNull()
    expect(parsePendingRouteFragment('#')).toBeNull()
  })

  it('is null for a fragment naming no route at all', () => {
    expect(parsePendingRouteFragment('#x=1')).toBeNull()
  })

  it('is null for an unrecognised route value — forward-compat with a newer native build', () => {
    expect(parsePendingRouteFragment('#route=somewhereElse')).toBeNull()
  })
})

// ============================================================================
// consumeInitialPendingRoute — cold start
// ============================================================================

describe('consumeInitialPendingRoute', () => {
  it('is null with no window at all', () => {
    expect(consumeInitialPendingRoute()).toBeNull()
  })

  it('is null when window exists but has no location', () => {
    vi.stubGlobal('window', {})
    expect(consumeInitialPendingRoute()).toBeNull()
  })

  it('returns the route named by location.hash', () => {
    vi.stubGlobal('window', { location: { hash: '#route=approvals', pathname: '/', search: '' } })
    expect(consumeInitialPendingRoute()).toBe('approvals')
  })

  it('is null when the hash names nothing recognised', () => {
    vi.stubGlobal('window', { location: { hash: '', pathname: '/', search: '' } })
    expect(consumeInitialPendingRoute()).toBeNull()
  })

  it('clears the fragment via history.replaceState once a route is consumed', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: { hash: '#route=approvals', pathname: '/', search: '?x=1' },
      history: { replaceState },
    })
    expect(consumeInitialPendingRoute()).toBe('approvals')
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?x=1')
  })

  it('does not touch history when there is nothing to consume', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', { location: { hash: '', pathname: '/', search: '' }, history: { replaceState } })
    expect(consumeInitialPendingRoute()).toBeNull()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('still returns the route when history.replaceState is unavailable (an older/odd environment)', () => {
    vi.stubGlobal('window', { location: { hash: '#route=approvals', pathname: '/', search: '' } })
    expect(consumeInitialPendingRoute()).toBe('approvals')
  })

  it('is total against a location getter that throws', () => {
    vi.stubGlobal('window', {
      get location(): never {
        throw new Error('boom')
      },
    })
    expect(() => consumeInitialPendingRoute()).not.toThrow()
    expect(consumeInitialPendingRoute()).toBeNull()
  })
})

// ============================================================================
// onPendingRoute — warm start
// ============================================================================

describe('onPendingRoute', () => {
  it('returns a no-op unsubscribe with no window at all, and never throws', () => {
    const unsubscribe = onPendingRoute(() => {
      throw new Error('should never be called')
    })
    expect(() => unsubscribe()).not.toThrow()
  })

  it('calls back with the route on a well-formed event', () => {
    const listeners: Record<string, (e: Event) => void> = {}
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: (e: Event) => void) => {
        listeners[name] = fn
      },
      removeEventListener: vi.fn(),
    })
    const cb = vi.fn()
    onPendingRoute(cb)
    listeners[PENDING_ROUTE_EVENT]!({ detail: { route: 'approvals' } } as unknown as Event)
    expect(cb).toHaveBeenCalledWith('approvals')
  })

  it('ignores an event with a missing or unrecognised route', () => {
    const listeners: Record<string, (e: Event) => void> = {}
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: (e: Event) => void) => {
        listeners[name] = fn
      },
      removeEventListener: vi.fn(),
    })
    const cb = vi.fn()
    onPendingRoute(cb)
    listeners[PENDING_ROUTE_EVENT]!({ detail: {} } as unknown as Event)
    listeners[PENDING_ROUTE_EVENT]!({ detail: { route: 'somewhereElse' } } as unknown as Event)
    listeners[PENDING_ROUTE_EVENT]!({} as unknown as Event)
    expect(cb).not.toHaveBeenCalled()
  })

  it('unsubscribing removes the listener', () => {
    const removeEventListener = vi.fn()
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener })
    const unsubscribe = onPendingRoute(() => {})
    unsubscribe()
    expect(removeEventListener).toHaveBeenCalledWith(PENDING_ROUTE_EVENT, expect.any(Function))
  })
})
