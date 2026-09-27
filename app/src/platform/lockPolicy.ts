// platform/lockPolicy.ts — when a paired child device's in-memory signing
// key (store.tsx's `childSk`) gets cleared for being backgrounded/hidden.
// Extracted out of store.tsx's own `pagehide` effect (Task 1 of
// internal plan 2026-08-11-android-apk: "extract the pagehide
// listener into a policy module") so the decision itself is pure and
// separately tested, and so a SECOND, WebView-appropriate policy can live
// here too — the plan's carried instruction from Plan 4's final review:
// "WebView lock grace policy (visibilitychange + 60 s grace replaces raw
// pagehide when running in the shell)".
//
// Two distinct environments need two different policies:
//  - Plain browser (`isShell()` false — every browser today): `pagehide`
//    fires on backgrounding, tab close, AND bfcache entry, and is the
//    browser's own "this page may not run again" signal (store.tsx's own
//    former comment on this, carried below) — reacting to it locks
//    IMMEDIATELY, and can't produce a false-positive lock from an ordinary
//    app-switch the way `visibilitychange`/`blur` alone could. UNCHANGED
//    behaviour: `wireLock` below is a drop-in replacement for the listener
//    store.tsx used to attach directly.
//  - Kinjar WebView shell (`isShell()` true): an Android Activity's WebView
//    does not fire `pagehide` the way a browser tab does — backgrounding the
//    app is an Activity lifecycle event, not a page navigation/unload — and
//    even where it does fire, the plan wants a WebView session to tolerate
//    BRIEF backgrounding (answering a call, opening notifications, swiping
//    through the Android app switcher; QR scanning via getUserMedia stays
//    in-app, not a detour to the camera app) WITHOUT forcing a fresh PIN
//    entry. This path uses `visibilitychange` instead, records the timestamp
//    the page went hidden, and only locks once `shouldLock` (below) says
//    that gap was >= `graceMs` — checked at the moment the page becomes
//    VISIBLE again, not via a `setTimeout` counting down while hidden:
//    Android commonly suspends/throttles a backgrounded WebView's JS timers,
//    so a timer armed at hide-time has no guarantee of ever firing while the
//    page is actually in the background. Checking on the visible transition
//    sidesteps that entirely — from a user's perspective the two are
//    indistinguishable anyway, since nobody can see an unlocked screen while
//    the page is hidden regardless of exactly when the in-memory key gets
//    cleared. Note: onStop (the native backstop, below) currently locks
//    immediately on ANY backgrounding; the grace-vs-backstop interplay is
//    to be tuned on-device per the checks in scripts/dev-note.md.

import { isShell } from './shell'

// Native backstop (Task 2 MUST-CARRY, internal plan 2026-08-11-android-apk
// ledger): the 60s grace above has no UPPER bound while the
// Activity stays backgrounded — Android does not promise `visibilitychange`
// fires again until the user actually returns, so a device left in the app
// switcher (or swiped away without the Activity being destroyed) could sit
// unlocked indefinitely from the page's own point of view. MainActivity's
// `onStop()` — a stronger signal than `pagehide`, which a bare WebView does
// not reliably fire at all — evaluates
// `window.dispatchEvent(new Event('kinjar-native-stop'))` on the way out.
// The shell branch below treats that event as an IMMEDIATE lock, same as
// plain-browser `pagehide`: onStop fires once the Activity is no longer
// visible in ANY way (home button, task switch, screen off, app swiped
// away), so there is no grace left to extend — the grace period only ever
// covered the gap BETWEEN visibility checks, not a session the native layer
// itself has now confirmed is backgrounded.

/** The native shell's own backstop signal — see the comment above.
 *  Dispatched from `MainActivity.onStop()`; listened for only in the shell
 *  branch of `wireLock` below (a plain browser never has anything
 *  dispatching it, so wiring the listener unconditionally would be dead
 *  weight rather than a correctness issue — but keeping it shell-only
 *  matches every other shell-specific branch in this module). */
export const NATIVE_STOP_EVENT = 'kinjar-native-stop'

/** 60 seconds — the plan's carried grace figure for the WebView shell. */
export const SHELL_LOCK_GRACE_MS = 60_000

/** Pure. `hiddenAtMs` is the timestamp the page most recently became
 *  hidden, or `null` if it hasn't (this session) — never lock on nothing.
 *  `nowMs` is "now" (the moment visibility is regained, in `wireLock`
 *  below). Locks at exactly the boundary (`nowMs - hiddenAtMs === graceMs`),
 *  not strictly past it — a session hidden for EXACTLY the grace period has
 *  used up its whole allowance. */
export function shouldLock(hiddenAtMs: number | null, nowMs: number, graceMs: number): boolean {
  if (hiddenAtMs === null) return false
  return nowMs - hiddenAtMs >= graceMs
}

/** Attaches whichever listener matches the current environment (via
 *  `isShell()`) and calls `lock()` once this policy decides the session
 *  should end. Returns a cleanup function — mirrors every other
 *  listener-attaching helper in this codebase (sync/engine.ts's `startSync`,
 *  store.tsx's own effects) — so the caller decides WHEN wiring is live;
 *  store.tsx only attaches this while `childSk !== null`, exactly as its
 *  former inline `pagehide` effect always did.
 *
 *  `now`/`graceMs` are injectable (rather than reading `Date.now()`/the
 *  module constant directly) purely so lockPolicy.test.ts can drive the
 *  shell branch deterministically without faking global timers. */
export function wireLock(lock: () => void, opts?: { graceMs?: number; now?: () => number }): () => void {
  const graceMs = opts?.graceMs ?? SHELL_LOCK_GRACE_MS
  const now = opts?.now ?? (() => Date.now())

  if (!isShell()) {
    // Unchanged plain-browser behaviour: lock immediately on pagehide.
    window.addEventListener('pagehide', lock)
    return () => window.removeEventListener('pagehide', lock)
  }

  let hiddenAtMs: number | null = null
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      hiddenAtMs = now()
      return
    }
    // Regained visibility — decide based on how long it was hidden for, then
    // reset: the NEXT hide starts its own fresh grace window regardless of
    // whether this one ended in a lock.
    if (shouldLock(hiddenAtMs, now(), graceMs)) lock()
    hiddenAtMs = null
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  // The native backstop — see NATIVE_STOP_EVENT's own doc comment above.
  // Immediate, unconditional lock: unlike a hide/show cycle, there is no
  // "how long was it hidden" question left to ask once the Activity itself
  // says it is stopping.
  window.addEventListener(NATIVE_STOP_EVENT, lock)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener(NATIVE_STOP_EVENT, lock)
  }
}

// --- The other half of the policy: when the KEY goes, not the screen -------
//
// v0.2 spec §2.6. Until now these were one decision — `wireLock` cleared the
// child's in-memory signing key, and the lock screen appeared because the key
// was gone. That is right in a browser tab and wrong in the shell: a
// backgrounded Android session is exactly when a child device most needs to
// keep syncing and to raise a notification, and it cannot do either without
// its key. So the two are now separate. The UI locks immediately (above);
// the key is kept for a while longer (below).

/** 30 minutes — how long a shell session keeps the child key in memory after
 *  the page is hidden, so sync and notifications keep working. Longer than
 *  `SHELL_LOCK_GRACE_MS` by design: the screen behind the lock is what a
 *  passer-by could read, and that is already covered. */
export const SHELL_KEY_RETAIN_MS = 30 * 60 * 1000

/** Pure. Mirrors `shouldLock`'s boundary semantics exactly — due AT
 *  `retainMs`, not strictly past it — so the two halves of the policy can
 *  never disagree about what "the window has elapsed" means. */
export function keyWipeDue(hiddenAtMs: number | null, nowMs: number, retainMs: number): boolean {
  if (hiddenAtMs === null) return false
  return nowMs - hiddenAtMs >= retainMs
}

/** How often the shell branch re-checks a hidden session. 60 s. */
export const KEY_WIPE_CHECK_MS = 60_000

/**
 * Arms the key-wipe half of the policy. Returns a cleanup function, like
 * `wireLock`.
 *
 * Plain browser: `pagehide` -> wipe immediately. Unchanged from what
 * `wireLock` used to do, and right for a tab: `pagehide` is the browser's own
 * "this page may not run again", so there is no session left to keep a key
 * for.
 *
 * Shell: record the time the page went hidden, and wipe once
 * `keyWipeDue` says the retention window has elapsed — checked BOTH on the
 * visible transition and on a `checkMs` interval, because a session that
 * never comes back needs the second one. `NATIVE_STOP_EVENT` deliberately
 * does NOT wipe: `onStop` fires on every ordinary backgrounding, and wiping
 * there would put us straight back to a child device that stops syncing the
 * moment it leaves the foreground. It still locks the UI (see `wireLock`),
 * which is the part a user can see.
 *
 * KNOWN LIMITATION, to verify on device: Android throttles a backgrounded
 * WebView's JS timers, so the interval may fire late or not at all until the
 * page is next visible. The failure mode is therefore WIPING LATE, NEVER
 * EARLY — the correct direction: the UI is already locked (immediately, via
 * `NATIVE_STOP_EVENT`), so a late wipe costs a longer key lifetime in memory
 * on a device that is already screen-locked, whereas an early wipe would
 * silently break sync and notifications, the exact thing this split exists
 * to fix. The visible-transition check means a returning user is never
 * served a stale session regardless of what the timer did.
 */
export function wireKeyWipe(wipe: () => void, opts?: { retainMs?: number; now?: () => number; checkMs?: number }): () => void {
  const retainMs = opts?.retainMs ?? SHELL_KEY_RETAIN_MS
  const now = opts?.now ?? (() => Date.now())
  const checkMs = opts?.checkMs ?? KEY_WIPE_CHECK_MS

  if (!isShell()) {
    window.addEventListener('pagehide', wipe)
    return () => window.removeEventListener('pagehide', wipe)
  }

  // Seeded from the CURRENT visibility state, not `null` (review fix, round
  // 1): store.tsx re-runs the effect that arms this whenever the child's
  // role, key or relay pool changes, and an inbound wrap can do that with
  // the app already in the background. Seeding null would start no retention
  // window at all, so the key would then survive until the next hide —
  // however long the app stayed backgrounded.
  let hiddenAtMs: number | null = document.visibilityState === 'hidden' ? now() : null

  // `hiddenAtMs = null` after a wipe, so a session that stays hidden is
  // wiped ONCE rather than on every tick of the interval; the next hide
  // starts its own fresh window.
  const wipeIfDue = (): void => {
    if (!keyWipeDue(hiddenAtMs, now(), retainMs)) return
    hiddenAtMs = null
    wipe()
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      hiddenAtMs = now()
      return
    }
    wipeIfDue()
    hiddenAtMs = null
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  // Off the global rather than `window` so this module keeps working in any
  // environment without a DOM window (and so a test can drive it with fake
  // timers) — the same reason `wire/outbox.ts#armPeriodicFlush` does it.
  const check = setInterval(wipeIfDue, checkMs)
  return () => {
    clearInterval(check)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
