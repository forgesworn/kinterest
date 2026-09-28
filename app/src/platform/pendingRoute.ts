// platform/pendingRoute.ts — the screen a family-update notification asked
// THIS launch to open (v0.3): tapping the "ask" notification
// ("New ask from … — tap to decide" — notifications.ts's `tag:
// "ask:${reqId}"`) should land the guardian straight on Approvals, not
// wherever GuardianShell would otherwise start on. Every other family
// notification keeps opening the app on its ordinary start screen — see
// android's Notifier.kt (`routeFor`), the native side's half of this.
//
// Split into a pure parse and two impure edges, the same shape
// lockPolicy.ts uses for "what to do" vs "how it's wired" — see that
// module's own header. Two delivery paths, matching MainActivity's
// cold-start/warm-start split (that file's own header on `onCreate` vs
// `onNewIntent`):
//
//  - COLD START: the launch Intent's `route` extra becomes a
//    `#route=approvals` fragment on the very first `loadUrl` (before any JS
//    on the page has run) — UrlGate.kt#decide only ever looks at
//    scheme+host, so a fragment never changes whether the page loads.
//    `consumeInitialPendingRoute` reads it once, at module/app start.
//  - WARM START: the Activity and this page are already running
//    (`singleTask` launchMode — MainActivity never gets a fresh `onCreate`
//    for a second tap), so `onNewIntent` cannot re-navigate the WebView
//    without reloading the app and losing its in-memory state. It instead
//    `evaluateJavascript`s a DOM `CustomEvent`, exactly the way
//    `MainActivity.onStop()` already does for lockPolicy.ts's
//    `NATIVE_STOP_EVENT`. `onPendingRoute` is the listener half.

export type PendingRoute = 'approvals'

/** The native shell's warm-start event name (`MainActivity.onNewIntent`) —
 *  see this module's own header. */
export const PENDING_ROUTE_EVENT = 'kinjar-pending-route'

/** Parses the `route` param out of a `location.hash`-shaped string
 *  (`"#route=approvals"`, `"#route=approvals&x=1"`, `""`, `"#"`, garbage…).
 *  Pure and total: anything not a recognised route — none at all, or a
 *  value this bundle doesn't know (forward-compat with a native build
 *  newer than the page it shipped with) — is `null`. */
export function parsePendingRouteFragment(hash: string): PendingRoute | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('route')
  return value === 'approvals' ? value : null
}

/** Cold start: the route (if any) this launch's URL fragment named — read
 *  and consumed EXACTLY ONCE, via `history.replaceState` clearing the
 *  fragment straight back off the URL, so a later reload of the same
 *  session (or a second render reading `location.hash` again) can never
 *  replay it. `null` with nothing to consume, and equally `null` outside a
 *  DOM (this suite's node test environment, and any environment with no
 *  `window`/`location` at all) — never throws. */
export function consumeInitialPendingRoute(): PendingRoute | null {
  try {
    if (typeof window === 'undefined' || typeof window.location === 'undefined') return null
    const route = parsePendingRouteFragment(window.location.hash)
    if (route !== null && typeof window.history?.replaceState === 'function') {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    return route
  } catch {
    return null
  }
}

/** Warm start: subscribes to the native shell's `PENDING_ROUTE_EVENT`.
 *  Returns an unsubscribe function, like every other listener-attaching
 *  helper in this codebase (lockPolicy.ts#wireLock, sync/engine.ts's
 *  `startSync`). A malformed event — missing or unrecognised
 *  `detail.route` — is silently ignored rather than passed through to
 *  `cb`. A no-op, never-throwing subscription with no `window` at all. */
export function onPendingRoute(cb: (route: PendingRoute) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: Event): void => {
    const route = (e as CustomEvent<{ route?: unknown }>).detail?.route
    if (route === 'approvals') cb(route)
  }
  window.addEventListener(PENDING_ROUTE_EVENT, handler)
  return () => window.removeEventListener(PENDING_ROUTE_EVENT, handler)
}
