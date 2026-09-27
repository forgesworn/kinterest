// platform/notifyPolicy.ts — Task E4's one pure seam between an ingress
// `Effect` (or the store-synthesised `pairAnswered` event) and
// notifications.ts's copy helper. `notificationFor` alone answers "what
// would this notification say, if anything" for a given role; this adds the
// one further fact store.tsx's onEffect glue needs before it may actually
// call `shell.ts#notify` — the firing rule from spec §3.1:
//
//   "the store fires a notification only when
//    typeof document !== 'undefined' && document.visibilityState === 'hidden'"
//
// Kept pure and DOM-free of its own accord: `visibilityState` is passed IN
// by the caller (which does the `typeof document` check itself), never read
// from `document` here — so this stays unit-testable with plain fixtures,
// exactly like `notificationFor`, and store.tsx's own glue shrinks to one
// call plus an `if (content !== null) notify(content)`.

import { notificationFor, type NotifiableEvent, type NotificationContent, type NotificationContext } from './notifications'

/** Fix round 1 (IMPORTANT 1): a resync reply re-emits every ingested effect
 *  through the SAME onEffect path a live delivery takes
 *  (`store.tsx#handleResilienceEffect`'s `reemit`) so state/acks fold in
 *  identically — but the events it replays are, by definition, already old
 *  (a device catching up after being offline). Without a way to say "fold
 *  this in, but don't notify", every replayed request/grant/entry would
 *  fire a fresh notification, and a device offline for a day would surface
 *  a burst of stale ones the moment it reconnects. `opts.notify === false`
 *  short-circuits before even the visibility check. */
export interface NotificationToFireOpts {
  notify?: boolean
}

/** Pure and total. `null` unless `opts.notify` isn't explicitly `false`, the
 *  document is genuinely hidden, AND `notificationFor` itself has copy for
 *  this event/role. */
export function notificationToFire(
  e: NotifiableEvent,
  ctx: NotificationContext,
  visibilityState: DocumentVisibilityState | undefined,
  opts?: NotificationToFireOpts,
): NotificationContent | null {
  if (opts?.notify === false) return null
  if (visibilityState !== 'hidden') return null
  return notificationFor(e, ctx)
}
