# Running Kinterest on a phone

The guardian app is a PWA with no native build step — the quickest way to
check a change on a real handset is to point the dev server at it over USB,
rather than deploying anywhere. There is also a native Android shell
(`android/`, package `org.forgesworn.kinjar`) that bundles the built PWA into
a WebView — see "Installing the native Android shell" below for that.

1. Start the dev server, bound to all interfaces (not just localhost):

   ```
   cd app && npx vite --host
   ```

2. Plug the phone into the machine over USB, with USB debugging enabled,
   and forward the dev server's port through `adb`:

   ```
   adb reverse tcp:5173 tcp:5173
   ```

3. On the phone, open Chrome and browse to:

   ```
   http://localhost:5173
   ```

`adb reverse` tunnels the phone's `localhost:5173` back to the machine's
`vite` process, so no Wi-Fi/LAN reachability between the two is needed —
this works over USB alone, including on a network that blocks device-to-device
traffic.

Useful for a genuine device check of anything phone-specific: onboarding at
360×640 portrait, the mnemonic grid, QR pairing (`components/QRCode.tsx`),
touch targets, `prefers-color-scheme` dark mode, and PWA install behaviour.

## Installing the native Android shell

`android/scripts/build-apk.sh` builds the PWA (`cd app && npm run build`),
then assembles the debug APK (`gradlew :app:assembleDebug`, which stages the
freshly built `app/dist` into the APK's assets as its bundled console —
Gradle's `stageConsoleAssets` task, wired as a `preBuild` dependency, fails
loudly if `app/dist` is missing or stale), and prints the resulting APK's
path, sha256, and size:

```
android/scripts/build-apk.sh
```

Install the built APK over USB (with the phone plugged in, USB debugging
enabled, and `adb devices` showing it as `device` not `unauthorized`):

```
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**First install on a given phone needs the screen unlocked once** — `adb
install` on a screen-locked phone can fail (or silently queue) because
Android needs the user to be present to accept a first-time install from an
unknown/debug source; subsequent reinstalls of the same `versionCode` (or
an upgrade) generally do not need this. Wake + unlock the phone (fingerprint
or PIN) before the first `adb install -r` of a fresh checkout, then it's fine
locked for launches/relaunches after that (`adb shell am start -n
org.forgesworn.kinjar/.MainActivity` works regardless of lock state — it
just resumes behind the keyguard until the phone is unlocked).

Launch it directly via adb (skips hunting for the "Jar" icon):

```
adb shell am start -n org.forgesworn.kinjar/.MainActivity
```

### Known gotcha — a shared test phone can refuse ALL installs

Regardless of lock state: if a phone has previously been enrolled as a Device Owner by
another ForgeSworn project's own kiosk/enforcement testing, that project's own
`DISALLOW_INSTALL_APPS` / `DISALLOW_INSTALL_UNKNOWN_SOURCES` device-policy
restrictions apply system-wide to every app on the device, not just to that
project — `adb install` fails with `SecurityException: User restriction
prevents installing` even though the phone is unlocked and `adb` is authorised.
This is NOT a Kinterest bug and not fixable from this repo; the restriction
has to be lifted from the enrolled device-owner app's own side (or the
phone re-flashed/factory-reset out of that enrollment) before sideloading
anything else works again. Check with: `adb shell dumpsys device_policy |
grep -i "Device Owner"`.

## The Android shell's on-device behaviour

### Lock policy: UI lock vs. key retention (final)

`lockPolicy.ts` splits what used to be one decision into two, because a
backgrounded child device that wiped its signing key straight away would
stop syncing and stop notifying at the exact moment a family update — and a
notification worth raising for it — is most likely to arrive.

**UI lock** (`wireLock`, unchanged from earlier builds) — locks the screen
behind the PIN:
- Browser tab: `pagehide` locks immediately.
- Shell: `visibilitychange` grants up to 60 s (`SHELL_LOCK_GRACE_MS`) hidden
  before locking, checked when the page becomes visible again — not on a
  timer armed while hidden (see the timer-throttling note below).
- Native `onStop` (home button, task switcher, screen off, or a swipe out of
  recents — anything that takes the Activity out of visibility) locks
  immediately and ungraced, regardless of how much of the 60 s grace was
  left: it's a stronger signal than the WebView's own `visibilitychange`.

**Key retention** (`wireKeyWipe`) — clears the in-memory child signing key,
now decided separately from the UI lock:
- Browser tab: `pagehide` wipes immediately, same as before.
- Shell: the key survives 30 minutes (`SHELL_KEY_RETAIN_MS`) after the page
  goes hidden — long enough for the relay service (below) to keep syncing
  and raising notifications behind an already-locked screen — rechecked both
  on the visible transition and on a 60 s interval while hidden.
- Native `onStop` does **not** wipe the key — only `wireLock` reacts to it.
  Wiping on every ordinary backgrounding would put a child device straight
  back to not-syncing the instant it left the foreground, which is the
  exact problem this split exists to fix.

**Known limitation, to verify on device:** Android throttles a backgrounded
WebView's JS timers, so the 60 s key-retention recheck may fire late. The
failure mode is therefore *wiping late, never early* — correct, since the UI
is already locked (via `onStop`) regardless, so a late wipe only extends how
long the key sits in memory on a screen nobody can see; check the actual
timing on the Pixel 8 before relying on it for anything time-sensitive.

### Notification permission

Android 13+'s `POST_NOTIFICATIONS` is requested once, from `MainActivity`'s
`onResume`, on first launch — without it neither the relay service's
persistent row nor a family update can show. It's fire-and-forget: denying
it once is not re-prompted. To re-test the prompt: uninstall and reinstall
the APK, or clear the permission from Android Settings → Apps → Jar →
Notifications, then relaunch.

### The relay service

Once a role is set and an engine is live, the shell starts a `dataSync`
foreground service (`RelayService.kt`); it's stopped on teardown or when the
role returns to unset.

**What it does:** keeps the app's *process* foregrounded so the web app's
sync can keep running — and raise a notification — while the Activity is
backgrounded; holds a partial wake lock for its lifetime; shows the required
persistent row on the "Keeping in touch" channel; posts tappable updates on
the separate "Family updates" channel. Android 15 caps a `dataSync`
foreground service at 6 hours continuous — `onTimeout` releases the wake
lock and stops the service cleanly before the OS would kill the app for
overrunning it; the service restarts whenever the app is brought back to
the foreground.

**What it does not do:** it does not itself hold the relay socket open —
that's still the WebView's own JS. A WebView in a stopped Activity still has
its JS timers throttled by Android, so background message delivery is
best-effort, not guaranteed. Check it for real rather than taking it on
faith from the service simply running: send something from the other
profile, background the app for a few minutes, and confirm a notification
actually arrives.

### External links (the Signet sign-in picker)

Signing in with My Signet can hand off outside the WebView entirely —
`bunker:`, `nostrconnect:` and `signet:` links, and
`https://mysignet.app` / `https://lite.mysignet.app`, are all routed to
whatever app or browser tab the phone has for them (`UrlGate.kt`'s
`EXTERNAL` verdict), wrapped in a `runCatching` so a phone with nothing
installed to handle the link doesn't crash — the navigation is simply
consumed either way. Everything else outside the console's own origin is
blocked outright (`BLOCK`); only the bundled console origin itself
(`app.kinjar.local`) is allowed to load inside the WebView (`IN_APP`).

No fake relay, no phone required — the whole guardian/child flow (pairing,
config sync, requests/grants, chores, and the audit ceremony below) works
between two ordinary desktop browser windows as long as both are talking to
the same relay. There is nothing to stand up for this: the app's own default
relays (`state/state.ts`'s `DEFAULT_RELAYS` — damus, nos.lol, primal) are
real, already-running public relays — both profiles just need internet access to
reach it. This is genuinely useful for a fast local check of anything
cross-device (a new request/grant flow, a config doc reaching a paired
child) without touching a phone at all.

**Why two browser *profiles*, not two tabs:** this app's own local storage
(the vault, the PIN's wrapped blob, `AppState` itself) is per-origin, so two
tabs of the same browser profile against `localhost:5173` would share ONE
identity — you'd only ever see a single device, not a guardian and a child
pairing with each other. Two separate profiles (or a normal window + an
Incognito/Private window, which also gets its own storage partition) give
each its own vault, exactly like two different physical devices would.

1. Start the dev server (either bound to localhost, or `--host` — no need
   for USB/`adb reverse` here, both profiles run on the same machine):

   ```
   cd app && npx vite --host
   ```

2. Open the guardian profile (a normal browser window/profile) at
   `http://localhost:5173`:
   - "Welcome" -> **Set up as parent** (mints the family mnemonic — no need
     to write it down for a throwaway local test, but the "Write these
     down" step still shows it once).
   - **Add your first child** -> give them a name.
   - From the child's card -> **Settings** -> add a physical account: name
     it (e.g. "Piggy bank"), currency `GBP`, custody **Physical cash** — this
     is the account the audit ceremony below needs (a `custody: 'ledger'`
     account never offers an audit at all).
   - Back on the child's card -> **Pair a device** — this opens a QR code
     plus a short SAS (Short Authentication String) phrase.

3. Open the child profile (a second browser profile, or an Incognito/Private
   window) at the same `http://localhost:5173`:
   - "Welcome" -> **Join your family**.
   - A laptop only has one built-in webcam, and it faces you, not the
     screen — there is no way for a single machine's own camera to scan a
     QR code shown in its own second window, so camera scanning is a dead
     end for a same-machine test regardless of HTTPS. Use the paste
     fallback instead: on the guardian profile, the "Pair a device" card
     has a **Can't scan? Copy this code instead** field under the QR/SAS —
     select all (auto-selects on tap/focus) and copy it, then paste it into
     the child profile's own **Paste the code instead** field (under "Join
     your family") rather than scanning.
   - The child screen now shows its own SAS — check it reads the SAME phrase
     as the guardian profile's (this is the pairing ceremony's own
     tamper-check; in a real two-device pairing this is what confirms
     neither side was intercepted).
   - Set a PIN (entered twice) -> lands on the jar home.

4. Back on the guardian profile, the pairing ceremony should already have
   closed out on its own (no extra step) — the child now appears synced;
   config docs (the physical account you added in step 2) and any ledger
   entries you add from `QuickActions` reach the child profile over the real
   relay within a few seconds.

### Demoing the audit ceremony (Task 5) on top of the above

1. On the guardian profile, add the child a bit of pocket money against the
   physical account from step 2 (`QuickActions` -> a credit/deposit) so
   there's a non-zero balance to count against.
2. On the child profile's jar home, tap **Count your jar** -> pick the
   physical pot -> use the +/− steppers to count out coins/notes until the
   running total matches what you just credited -> **Compare with your
   jar**.
   - A matching count shows a celebration screen and a single **All done!**
     tap, which sends the signed audit result to the guardian.
   - Miscount it on purpose (tap one stepper extra) to see the mismatch
     path instead: a "detective" screen listing what's happened to the pot
     since its last audit, then either **I found it** or **Not sure — send
     it anyway** — both send the same signed audit result; only the closing
     copy differs.
3. The sent result now shows up on the guardian side too — open the child's
   card and check the activity list (`ChildActivity`, added in v0.2) for the
   "Matched" / over / short outcome, rather than having to check
   `AppState.audits` via devtools/localStorage. Any correcting entry is still
   the guardian's own manual job via `QuickActions` -> **Settle up**, which
   builds the exact same kind of adjustment entry, just guardian-typed rather
   than fed straight from the ceremony.
