# Kinterest

A shared family pocket-money ledger — parent and child look at the same account.
No card, no real money, ever. Part of the KIN suite.

## Status

v0.2.0 (Android versionCode 2) — the guardian's My Signet identity is now the
family's root of recovery and authority, sync self-heals with a heartbeat and a
paged, signature-verified resync, and the Android shell notifies the family in
the background via a foreground relay service. ~1230 tests green. See
`docs/ROADMAP.md` for what's built and what's next.

Design docs and plans live in the private suite repo, not here:

- Concept of record: internal concept 2026-08-09-kinterest-concept
- v1 design spec: internal design spec 2026-08-10-kinterest-v1-design
- v0.2 design spec: internal design spec 2026-09-02-signet-rooted-family-design
- Plan series: internal plan 2026-08-10-v1-plan-series

## Run it

```
cd app && npm i && npm run dev
```

## Test it

```
cd app && npm run typecheck && npm test
```

## Build and install the Android shell

```
android/scripts/build-apk.sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Add `--release` to `build-apk.sh` for a release build type — it comes out
release-signed only when `android/keystore.properties` exists (owned by
whoever runs the deploy pipeline), and debug-signed otherwise. See
`scripts/dev-note.md` for running on a real phone, including the Android
shell's lock policy, notification permission, relay service, and how it
hands off Signet sign-in links outside the WebView.

App code lives in `app/` (Vite + React + TS); the native Android shell lives
in `android/` (package `org.forgesworn.kinjar`).

See [SECURITY.md](SECURITY.md) for the threat model, known limitations, and
how to report a vulnerability.
