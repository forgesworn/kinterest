# Kinterest — roadmap & status

*Last updated 2026-09-27. Still in the dogfooding phase, not yet launched.*

## Where it is now (v0.2)

v0.2.0 (Android versionCode 2), ~1230 tests green, built on the v1 base (domain
core, wire/identity/pairing, parent mode, child mode, Android shell — all still
in place and unchanged in kind):

1. **Signet root of recovery and authority.** Signing in with My Signet
   (`nostrconnect://` NIP-46) is now the guardian's login. The family mnemonic
   is generated silently behind it — never a 12-word ceremony on this path —
   and stays viewable from Settings as the standalone fallback either way. A
   vault carrying the mnemonic, the active children, and the family's relays
   is gift-wrapped to the Signet pubkey on those relays, so recovery is "sign
   in again", not "type the words back in". Full design: internal design spec
   2026-09-02-signet-rooted-family-design §1.
2. **Resilient sync.** Each child sends an hourly heartbeat (`status`); the
   guardian reconciles it against its own checkpoint for that child — a peer
   that's behind gets a fresh snapshot, a peer that's ahead gets a paged,
   signature-verified resync (10 pages, rate-limited per peer), so neither
   side ever trusts unsigned JSON handed to it by another peer or a relay.
   The offline outbox flushes every 60 s and on the browser's `online` event.
3. **Final key-vs-UI lock policy.** The screen locks fast (60 s hidden in the
   shell, immediately on a native stop or a real browser `pagehide`); the
   child's signing key survives longer (30 minutes) so sync and notifications
   keep working while the screen is locked. Native `onStop` locks the UI but
   never wipes the key; only an actual page teardown wipes on the spot.
4. **Android notifications and relay service.** Adaptive launcher icon (ember
   jar); a `dataSync` foreground service keeps sync alive with the Activity
   backgrounded (Android 15's 6-hour cap handled via `onTimeout`, restarted
   when the app is brought back to the foreground); two notification
   channels ("Keeping in touch" for the persistent row, "Family updates" for
   tappable ones); `POST_NOTIFICATIONS` requested on first resume; the Signet
   picker's external links (`mysignet.app`, `lite.mysignet.app`,
   `nostrconnect:`, `bunker:`, `signet:`) hand off outside the WebView.
5. **Guardian and child gaps closed.** A guardian-side activity viewer for
   ticks and audit results; dismissed asks show "Not now" rather than a
   stale "no reply yet"; coin-jar accounts reject a currency with no real
   coins; a new "Remove this device" action revokes a child's device and
   signs it out to an `Unpaired` screen.

**On the phone:** build and install with `android/scripts/build-apk.sh` then
`adb install -r android/app/build/outputs/apk/debug/app-debug.apk`; launch
directly with `adb shell am start -n org.forgesworn.kinjar/.MainActivity`.
Release builds sign with `android/keystore.properties` when it's present
(owned by the deploy owner), and fall back to debug signing when it isn't.

## v0.2.1 — audit fixes (2026-09-27)

A full-code audit (domain, protocol, UI, Android shell) found 5 critical and
~25 major bugs; all criticals and majors are fixed on `main` with regression
tests. The ones that mattered most:

- **Money.** Editing an allowance/interest config (account, cadence, pause,
  gate) no longer re-pays history — the schedule re-anchors on every save
  (`domain/reanchor.ts`). Interest is computed on the balance *as of* each due
  day, so a deposit never earns back-interest for empty weeks. Denied/dismissed
  gated periods are never auto-paid. Revoked children stop accruing.
- **Ledger integrity.** `assertEntry` now enforces ledger invariants (signs,
  transfers balance, safe integers); `assertEntryAgainst` binds every leg to
  the entry's own child and currency. The guardian refuses child-authored
  ENTRY events outright (live and resync); ticks/audits are bound to the
  signing child.
- **Revocation.** Saving any accounts change no longer un-revokes a removed
  device; a revoked child can't be "re-paired" onto its revoked key.
- **Sync.** Heartbeat heals a child behind on config; timing-related refusals
  (clock skew, doc not yet arrived) are deferred, not dropped; relays
  reconnect with backoff and on `online`.
- **Recovery.** Vault recovery waits for in-flight unwraps, reports "too
  many candidates" distinctly, and refuses to silently pick between backups
  naming different guardians ("conflicting backups" — the tell of a planted
  vault from a phished Signet login).
- **Android.** Family updates are hidden from the lock screen (`family.v3`,
  VISIBILITY_SECRET); relay service restarts after the Android 15 timeout and
  stops when the task is removed; `configChanges` stops a theme/font change
  wiping the child's session; `FLAG_SECURE` blanks the recents thumbnail.
- **UI.** Settle-up can record £0; transfer/allowance/interest dead-ends fixed;
  bad-currency asks can't break Approvals; recovery words are normalised;
  "Add a child" is reachable after the first child.

**Hardware round needed** (turnkey checks, on a test phone):
`android/scripts/build-apk.sh && adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, then:
1. Lock screen — "Show sensitive content" ON, lock, trigger an ask. Expect
   nothing on the lock screen; `adb shell dumpsys notification | grep -A3 family.v3`
   shows `mLockscreenVisibility=-1`.
2. Swipe from recents → `adb shell dumpsys activity services org.forgesworn.kinjar`
   shows no RelayService; the ongoing notification is gone.
3. Unlocked as child, `adb shell cmd uimode night yes` → no PIN prompt, no reload.
4. App switcher → blank thumbnail; screenshots blocked.
5. Service timeout (if `adb shell cmd activity service-timeout-now` exists) →
   background, reopen → "Keeping in touch" notification returns.

## Next (v0.3) — in priority order

1. **Replace a lost phone without losing the child's money.** Re-pairing now
   correctly uses a new index (new key), but the child's accounts stay keyed to
   the old pubkey. Needs a guardian-authored "move child" config op that
   re-homes accounts, chores and history to the new device key. *Design
   question — decide before building.*
2. **Snapshot scoping.** Snapshots still carry every sibling's ledger to every
   child device. Scope per child.
3. **Pairing-QR race.** Anyone who photographs the offer QR within its 600 s
   window can claim first and receive the child's key. Bind the claim to the
   SAS confirmation before the key is released, or shorten + single-use.
4. **Deposit match.** Configurable in settings but never paid — implement per
   v1 §Interest, or hide the setting until it is.
5. **Vault freshness.** The My Signet vault is a one-shot snapshot; re-seal it
   when children or relays change. Relays may expire kind-1059 — republish
   periodically, and consider a non-public locator so an inbox flood can't
   hide it (today it degrades to "too many candidates").
6. **Root attestation that a generic login can't produce.** Today the
   attestation is an ordinary Signet login event over a public challenge, so
   any site the guardian logs into with Signet could obtain one (the `origin`
   tag is written by the requesting site, so it proves nothing). Needs a
   Signet-side change: a dedicated, displayed "authorise this family root"
   signature. Conflicting-backup detection is the stopgap. Fold into the
   Signet-side brief.
7. **Root retraction on children.** A guardian who changes/disconnects Signet
   leaves the old root pinned on every child.
8. **Corrections.** `reverseEntry` has no UI; reversed scheduled payouts are
   never re-paid (latent), and a reversed older interest period stays closed
   once a later payout exists. Decide semantics, add a guardian "correct this"
   path.
9. **Browser notifications.** Web path is now safe but unused: needs a
   Settings toggle calling `requestNotificationPermission()` and a registered
   service worker. (Android uses the native path.)
10. **Child resync + GRANTs in snapshots.** Children never initiate a resync,
   and snapshots carry no GRANTs.
11. **Child interest projection.** "Leave it 4 more weeks and it's £X" (v1
    spec) — ChildHome shows one period only.
12. **Adopt Signet dependant pairing (was "Signet-side issuance").** The
    Signet side now exists: signet-app `main` ships "Pair an app as this
    dependant" (`bunker://…?dependant=` QR), and the sibling app
    Kindependence already uses it — the child phone scans, connects over
    NIP-46, makes a local device-only phone key, and has the guardian's
    Signet sign a device statement; the child's real key never leaves
    Signet. Adopting it would retire the app-generated family mnemonic,
    and also fix lost-phone re-homing (item 1), the pairing-QR race
    (item 3), and give children the Signet identity the IOU idea needs.
    **Open design question (Fable session): shared kit or not.**
    Recommendation to start from:
    - Signet half (scan, NIP-46 dependant session, phone key, device
      statement) → a dependant mode in `signet-login`, next to Signet's
      own pairing screen.
    - Family-link format (guardian-of / dependant-of statements, device
      statement — today a generic kind 30078) → a written protocol with
      fixtures; check `brood-kit` (family policy + guardian approvals)
      before making a new kit.
    - Extract from Kindependence's working code *when Kinterest adopts
      it* (two real consumers), not ahead of time.
    - Shared layer = pairing + identity only; each app decides which
      actions need the guardian's live Signet. Kinterest's asks, ticks and
      heartbeat must work on the phone key alone.
    - Consumers: Kindependence now, Kinterest next, likely Kinclude and
      Kintrinsic.
13. **Storage.** CONFIG corpus pruning (superseded `issuedAt`), then move
    from whole-state localStorage writes to IndexedDB. A save failure now
    shows a banner rather than crashing.

## Later — ideas captured

- **IOUs: who owes whom.** A child (or parent) notes money lent or owed —
  most often a cash-flow "you get this one, I'll get the next", sometimes a
  real loan. Works inside one family (sibling ↔ sibling) and between two
  families using the app (a child owes a friend's child). The counterparty
  is picked from **My Signet contacts**, so the note names a real person
  rather than free text, and can be shown to them to confirm. Open
  questions to settle before design:
  - A private note on my side only, or a shared record both sides sign?
  - Does settling an IOU move money in the ledger, or just mark it paid
    (cash may change hands outside the app)?
  - Cross-family: what does the other child's guardian see, and does a
    child need their parent's OK to lend or borrow?
  - Interest on loans — never, or parent-set?
  - Depends on children having a Signet identity (see Signet-side
    dependant issuance) for contacts to work on the child's side.

Deferred minors from the audit (logged in the session's audit notes, not
urgent): PIN backoff lives in localStorage and can be reset by anyone with
script access; synthetic grant rows can drop on reload; `dayKey` relies on the
`en-CA` locale; non-ULID scheduler ids; a daily chore added mid-period blocks
completion; adjustment entries lack some spec fields.

## Known limitations to keep in mind while dogfooding

- **localStorage holds the whole family ledger in plaintext on every paired
  device.** The PIN gates *signing*, not *reading*; per-child UI filtering is
  a convention, not a security boundary. Snapshots and configs are now
  scoped to each child, but a device that ran an older build may still hold
  sibling data until it is replaced (see SECURITY.md).
- `innerEvents` CONFIG entries are retained without pruning — a very
  long-lived family could eventually approach `localStorage`'s ~5 MB budget.
- Background notification delivery is best-effort: the relay service keeps
  the *process* foregrounded, not necessarily the socket, and a stopped
  Activity's WebView still has its JS timers throttled — verify on-device.
