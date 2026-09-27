// Minimal service worker — web build only. Registered from main.tsx, and
// only outside the Android WebView shell (which fires notifications
// natively — see src/platform/shell.ts#isShell and #notify).
//
// Why this exists at all: on Android Chrome, `new Notification(...)` throws
// ("Illegal constructor") — a notification there can only be shown through
// a service worker registration's own `showNotification`, which is exactly
// what `platform/shell.ts#notify` prefers when one is available. This file
// deliberately does nothing beyond installing and taking control: no fetch
// handler, no cache, no offline strategy — this app is not an offline-first
// PWA (see index.html/manifest.webmanifest), so a caching layer here would
// be a behaviour change nobody asked for. Keep it this way unless a caching
// strategy is a deliberate, separate piece of work.

self.addEventListener('install', () => {
  // Don't wait for old tabs to close before this version takes over — there
  // is no cached state here for an old version to protect.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
