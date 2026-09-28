# Kinterest — notes for coding agents

This repository is **public**. Never commit real names, home-directory paths,
device serials, credentials or internal planning material. A pre-commit hook
checks for identity terms — never bypass it. Internal specs, plans and design
questions live in the private suite repo, not here; code cites them as
"internal design spec <slug>" / "internal plan <slug>".

## Engineering rules

- Money is integers in minor units, always. No floats near money, ever.
- Domain code (`app/src/domain/`) is pure: no I/O, no `Date.now()`; time is a
  parameter.
- Canonical time units: entries/audits/ticks carry unix SECONDS; `newId`
  takes milliseconds. Label any new time field.
- British English. Tests beside sources. Conventional commits.
- The user-facing app name is **Kinterest**. The Android package id
  (`org.forgesworn.kinjar`) and the relay marker tag (`kin-jar`) keep their
  old internal names on purpose — changing them breaks installs and sync.
- My Signet is mandatory for guardians. Never ask a guardian to write down
  recovery words.
- Security-, money- or sync-affecting changes get an independent review of
  the diff before they are pushed, even when tests are green.

## Commands

- `cd app && npm ci` — install (lockfile).
- `cd app && npx vitest run && npx tsc --noEmit` — the acceptance check.
- `android/scripts/build-apk.sh` — debug APK at
  `android/app/build/outputs/apk/debug/app-debug.apk`.

## Status and plans

See `docs/ROADMAP.md` (public roadmap) and `SECURITY.md` (threat model).
