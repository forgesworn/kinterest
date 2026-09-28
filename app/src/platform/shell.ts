// platform/shell.ts — feature-detected bridge to the Android WebView shell
// (the Kinjar carrier — Plan 5 "Android APK"). Global Constraints for that
// plan: "The web app must keep working in plain browsers — WebView
// affordances are additive (feature-detected bridge)". Every read here is
// therefore defensive and total: `window.KinjarShell` does not exist in any
// browser today, or in a WebView not yet updated to expose it, and neither
// case is an error — it is just "not the shell", the overwhelmingly common
// answer this module must always be safe to ask for.
//
// See internal plan 2026-08-11-android-apk Task 1 ("typed
// feature-detected bridge: shellInfo(), isShell()") and Task 2 (Android's
// own `MainActivity` exposing `KinjarShell` via `@JavascriptInterface`,
// mirroring charter's own `CarrierBridge`/`window.CharterCarrier` pattern —
// see that file's `version(): String` returning
// `{"versionName":…,"versionCode":…}` JSON, which `shellInfo` below parses).

/** The shape actually reachable off `window.KinjarShell` once Task 2's
 *  Android shell exposes it — NOT assumed to exist, and every method on it
 *  optional: an older shell build may expose the bridge object itself but
 *  lack a method a newer web bundle wants to call (the same "shell older
 *  than the page" gap `CarrierBridge#version`'s own doc comment describes),
 *  and that must degrade gracefully rather than throw. */
interface KinjarShellBridge {
  version?: () => string
  /** Foreground relay-keepalive service (v0.2 spec §3.2/§3.3). Started once
   *  a role is set and an engine is live; stopped on teardown and when the
   *  role returns to `unset`. */
  startRelayService?: () => void
  stopRelayService?: () => void
  /** Shell -> native notification. `notify()` below falls back to the
   *  browser Notification API when this is absent (a plain browser, or an
   *  older shell build). */
  notify?: (title: string, body: string, tag: string) => void
}

declare global {
  interface Window {
    KinjarShell?: KinjarShellBridge
  }
}

/** Parsed, typed shell version info. `null` fields mean the bridge exists
 *  but couldn't say — an older shell missing `version()`, or a malformed
 *  response — as distinct from `shellInfo()` itself returning `null`
 *  ("there is no shell at all"). */
export interface ShellInfo {
  versionName: string | null
  versionCode: number | null
}

/** True iff running inside the Kinjar Android WebView shell. THE gate every
 *  other module in this app (lockPolicy.ts's grace-period branch, and any
 *  future shell-only affordance — camera bridge, back-button handling) must
 *  use, so "what counts as the shell" stays defined in exactly one place.
 *  Total: never throws, even where `window` itself doesn't exist (this
 *  suite's node test environment — see vite.config.ts). */
export function isShell(): boolean {
  return typeof window !== 'undefined' && typeof window.KinjarShell === 'object' && window.KinjarShell !== null
}

/** The shell's own self-reported version, or `null` outside the shell.
 *  Informational only today (nothing in this plan gates behaviour on a
 *  specific version yet) — exposed for the same reason `CarrierBridge`'s
 *  `version()` exists at all: a WebView's page content updates live from the
 *  site, but the NATIVE shell around it only changes when a new APK is
 *  installed, so the page can otherwise never tell the two apart. */
export function shellInfo(): ShellInfo | null {
  if (!isShell()) return null
  const bridge = window.KinjarShell as KinjarShellBridge
  if (typeof bridge.version !== 'function') return { versionName: null, versionCode: null }
  try {
    const parsed: unknown = JSON.parse(bridge.version())
    if (typeof parsed !== 'object' || parsed === null) return { versionName: null, versionCode: null }
    const { versionName, versionCode } = parsed as Record<string, unknown>
    return {
      versionName: typeof versionName === 'string' ? versionName : null,
      versionCode: typeof versionCode === 'number' ? versionCode : null,
    }
  } catch {
    // Malformed/non-JSON response — same "we don't know" answer as a
    // missing version() method, never a throw (this function is called from
    // render paths, per its own doc comment above, and must not be able to
    // crash the tree the way main.tsx's ErrorBoundary comment describes for
    // other unbounded inputs).
    return { versionName: null, versionCode: null }
  }
}

/** Starts the Android foreground relay-keepalive service (v0.2 spec §3.2).
 *  No-op outside the shell, on an older shell missing the method, or on any
 *  failure the bridge call itself throws — a WebView bridge call failing is
 *  no different from "there is no shell" as far as this app's own state is
 *  concerned. Never throws. */
export function startRelayService(): void {
  try {
    if (typeof window === 'undefined') return
    window.KinjarShell?.startRelayService?.()
  } catch {
    // Swallowed — see doc comment above.
  }
}

/** Stops the foreground relay-keepalive service. Called on teardown and
 *  whenever the role returns to `unset`. Same no-op/never-throws contract
 *  as `startRelayService`. */
export function stopRelayService(): void {
  try {
    if (typeof window === 'undefined') return
    window.KinjarShell?.stopRelayService?.()
  } catch {
    // Swallowed — see doc comment above.
  }
}

/** Shell -> `KinjarShell.notify` when present. Otherwise the browser path,
 *  which only ever SHOWS — it never asks for permission:
 *  this is called from a hidden page with no user activation, where
 *  `Notification.requestPermission()` is ignored or auto-denied, so asking
 *  from here could never have worked. Permission is asked for only through
 *  `requestNotificationPermission()`, from a user gesture.
 *
 *  With permission granted, a service-worker registration's
 *  `showNotification` is preferred (Chrome on Android throws
 *  `Illegal constructor` for `new Notification`); with no registration the
 *  constructor is tried, which works on desktop browsers. Every failure —
 *  no shell, no bridge method, no `Notification` global, permission not
 *  granted, the constructor or a rejected promise — is swallowed. Never
 *  throws, never rejects. */
export function notify(c: { title: string; body: string; tag: string }): void {
  try {
    if (typeof window !== 'undefined' && window.KinjarShell?.notify) {
      window.KinjarShell.notify(c.title, c.body, c.tag)
      return
    }
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const options = { body: c.body, tag: c.tag }
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
    if (sw && typeof sw.getRegistration === 'function') {
      sw.getRegistration()
        .then((reg) => (reg ? reg.showNotification(c.title, options) : showByConstructor(c.title, options)))
        .catch(() => {
          // Swallowed — see doc comment above.
        })
      return
    }
    showByConstructor(c.title, options)
  } catch {
    // Swallowed — see doc comment above.
  }
}

function showByConstructor(title: string, options: { body: string; tag: string }): void {
  try {
    new Notification(title, options)
  } catch {
    // Chrome on Android: `Illegal constructor` — degrade silently.
  }
}

/** Asks the browser for notification permission. MUST be called from a
 *  user gesture (a click handler) — browsers ignore or auto-deny a request
 *  made without one. Inside the shell the native side owns the permission
 *  (MainActivity asks for POST_NOTIFICATIONS), so this reports 'granted'
 *  without asking. Resolves 'unsupported' where there is no Notification
 *  API. Never rejects. */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  try {
    if (typeof window !== 'undefined' && window.KinjarShell?.notify) return 'granted'
    if (typeof Notification === 'undefined') return 'unsupported'
    if (Notification.permission !== 'default') return Notification.permission
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}
