# Security

Jar is a shared family pocket-money ledger: a parent (guardian) device and
one or more child devices, each running the same web app, syncing directly
with each other over a public relay. There is no backend server, no real
money, and no card ever involved — Jar only ever moves a number around in a
ledger that everyone in the family can already see.

This document describes the threat model this app is designed against, what
it deliberately does not try to defend against, and how to report a security
issue.

## What Jar never does

- It never touches real money, a bank account, or a card.
- It never talks to a backend of its own — devices sync peer-to-peer over a
  relay, and the relay only ever sees encrypted, signed messages.
- It never asks for anything beyond what a family pocket-money ledger needs:
  no contacts, no location, no camera use beyond scanning a pairing code.

## Threat model, in plain English

Jar assumes:

- The people using it are a family. The guardian device is trusted to run
  the family's ledger honestly; a child device is trusted to be operated by
  that child, not by a stranger.
- The main risk worth defending against is a lost or stolen phone, or a
  sibling picking up the wrong device — not a nation-state attacker, and not
  someone with sustained physical possession of a device plus the skill to
  attach a debugger to it.
- The relay that messages pass through is not trusted with anything in the
  clear: every message that leaves a device is encrypted and signed first,
  so a relay operator (or anyone who can read relay traffic) sees ciphertext
  and metadata, never ledger contents.
- Anyone who can run arbitrary script in the app's own browser tab (for
  example, via that browser's developer console) has already won on that
  device — nothing described below is designed to survive that. It only
  needs to survive someone else picking the device up and using it normally.

## Known limitations

These are accepted trade-offs, not oversights — each one is here so nobody
assumes a stronger guarantee than the app actually provides:

- **The ledger itself is stored in the clear.** Each paired device keeps its
  copy of the family ledger as plain, unencrypted data in the browser's own
  local storage. Anyone who can read a device's browser storage — through
  that browser's own developer tools, or a backup of the browser's profile —
  can read the whole ledger for that device.
- **A child's PIN gates signing, not reading.** The PIN on a child device
  protects the child's own signing key (so nobody but that child can send
  messages as them); it does not encrypt or hide the ledger data already on
  that device, which is readable the same way as any other locally stored
  app data.
- **What a child device holds.** A child device is sent only its own data:
  its own profile, its own ledger entries, the guardian's answers to its own
  requests, and its own rows of the family settings (its accounts, its
  pocket-money and interest settings, its chores, and the record of its own
  removal if it has been removed). It also holds the guardian's public key
  and the family's relay list, which it needs to sync. The guardian's
  device holds the full family settings. One caveat: a child device that
  ran an older version of the app may still hold sibling data it was sent
  then — ledger entries, and other children's accounts, pocket-money and
  interest settings and chores. Sibling entries are cleared the next time
  the guardian sends that device a full catch-up, and each settings list is
  replaced the next time the guardian changes it; until then, the old copy
  remains readable in that device's storage.
- **Background notifications are best-effort.** Neither the browser's
  Notification API nor the Android app's own background delivery is
  guaranteed to fire every time — a notification may be delayed, or simply
  not arrive, depending on the device, battery settings, and how long the
  app has been in the background.
- **PIN brute-force protection is client-side only, and therefore soft.** A
  child device's PIN is protected by a slow key-derivation step and a
  short escalating delay between guesses, both enforced by the app itself
  rather than by any external system. Anyone who can run script in that
  device's own browser tab can bypass or reset this delay; it is meant to
  slow down someone idly guessing a short PIN, not to withstand a
  determined attacker with the device and developer tools in hand. The
  delay is tracked in two independent places so that clearing just one of
  them doesn't reset it, which raises the bar slightly further, but does
  not change this fundamental limit.

## Reporting a vulnerability

If you find a security issue in this repository, please open a GitHub
security advisory on this repository rather than a public issue. That
keeps the details private between you and the maintainers until a fix is
ready.
