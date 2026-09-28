# Kinterest — roadmap & status

*Updated 2026-09-28. The first-release build is in validation; it has not been launched.*

## First release

- **My Signet family authority.** Guardians approve a dedicated Kinterest
  family request in My Signet. Generic login signatures cannot authorise a
  family. Existing unbound families must connect their saved family identity.
  A saved binding supports ordinary offline use.
- **Stable child identities.** Children are selected from the guardian's My
  Signet dependants, with a displayed approval for the selected child and
  device. Only the approved name and optional contact avatar are shared.
  Existing children are explicitly linked without rewriting their money or
  history. The child's identity key stays in My Signet.
- **Shared parent phone.** Parents can act as a child to make asks, tick chores
  and record audits. Returning to parent screens requires a separate parent
  PIN. Reloading or backgrounding locks parent access. Setting or resetting
  that PIN requires a fresh, dedicated My Signet approval.
- **Confirmed pairing and replacement.** Parent and child compare a code
  bound to the claiming phone before the parent approves it. Each phone has
  its own operational key. Replacing a lost phone or forgotten child PIN
  revokes the old phone credentials and keeps the same child, pots and history.
- **Append-only corrections.** A parent supplies a reason and reverses an
  original entry, optionally replacing its amounts in the same operation.
  The original remains visible. Corrected scheduled periods stay closed;
  corrections do not silently recalculate previous interest or deposit match.
  Offline correction delivery intents survive restart.
- **Complete family backup.** Encrypted checkpoints include phone-less
  children's money, history, settings, device grants and revocations, activity
  and pending corrections. My Signet recovery opens the family manifest;
  checkpoint chunks are decrypted locally with the recovered family key.
  A relay must acknowledge every chunk before its manifest is published there.
  An incomplete latest checkpoint is an error, never an automatic rollback.
- **Exact money and scoped sync.** Amounts are integer minor units. Child
  devices receive their own data. Signed snapshots, paged reconciliation,
  durable offline delivery and scheduled allowance, interest and match remain
  supported. Parent Home shows money held for the family by currency.
- **Durable storage.** IndexedDB migration commits before deleting old copies.
  Failed writes retain data for retry and show a banner; one browser tab owns
  the writer. Android uses native relay sockets while its service is running.

These features require the corresponding My Signet build with explicit
Kinterest family, dependant and parent-presence approvals. Earlier My Signet
builds cannot complete those ceremonies.

## Validation still required

The previous build passed the live ask-notification check: tapping a background
notification opened Approvals, and dismissing it did not move money. The new
first-release build needs its own device round for My Signet approvals, parent
lock and child mode, pairing/replacement, correction sync and full recovery.
The device round is underway. Dedicated family and parent-presence approvals
have passed on-device, including returning from My Signet to parent PIN setup.
The six-hour Android service test is deferred.

Build locally with `android/scripts/build-apk.sh`. The debug APK is at
`android/app/build/outputs/apk/debug/app-debug.apk`. The Android package remains
`org.forgesworn.kinjar` so updates retain existing installations.

## Supported limits

- One guardian installation per family; retire the old installation after
  recovery. Concurrent guardian histories are not merged.
- Checkpoints are bounded to 4 MiB, split into at most 256 encrypted chunks.
  Oversize or incomplete backups fail visibly. Keep the existing phone until
  a current backup succeeds; relay storage is not guaranteed permanent.
- Local ledger data remains plaintext in IndexedDB. PINs protect ordinary app
  use and signing keys, not a compromised device or browser developer tools.
- Updates are forward-only. Older builds do not understand the current
  identity, backup and correction formats.
- Background notifications are best-effort; Android can stop the service or
  process. The ledger itself remains unbounded by policy.

## Later

IOUs and cross-family lending, multiple guardians, biometric unlock and
shared identity-kit extraction are outside this release. Handling a guardian
clock that pins configuration recency in the future still needs a separate
policy decision. An unchanged deferred entry can trigger bounded catch-up
requests every 30 minutes.

See [SECURITY.md](../SECURITY.md) for the threat model and accepted limits.
