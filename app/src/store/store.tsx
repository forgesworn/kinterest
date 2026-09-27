// The guardian app's central store — see
// internal plan 2026-08-11-parent-mode, Task 2.
//
// Split deliberately in two layers, per the plan's "Store logic must be
// testable without DOM":
//   1. Everything above `AppProvider` is plain, exported, DOM-free
//      functions/types: a pure `storeReducer`, pure pairing-session
//      constructors, a handful of async-but-deterministic "action builder"
//      functions (`addEntryAndSend`, `publishConfigDoc`) that take an
//      explicit `AppState` plus injected wire dependencies (`WireOpts`) and
//      return the next `AppState` — the same shape `sync/publish.ts`'s own
//      helpers already use, so these compose with it rather than wrapping it
//      in anything opaque — and `buildGrantDecision` (Task 5), which is
//      PURE and returns a functional `applyToApp` updater rather than a
//      precomputed `AppState` (see its own doc comment for why: a live
//      caller, screens/Approvals.tsx, dispatches that updater and sends the
//      wire messages separately, the same "dispatch first, send after"
//      shape QuickActions.tsx's `submitEntry` established). Every one of
//      these is unit-testable with a `fakeRelay`/in-memory storage and no
//      React at all (see store.test.ts).
//   2. `AppProvider`/`useApp` is the thin shell: a `useReducer` over
//      `storeReducer`, persistence-after-every-step, and the two `useEffect`
//      hooks that own process-lifetime concerns pure functions can't express
//      (restarting `sync/multi.ts`'s engine when the guardian's child list
//      changes, the 15-minute/on-focus scheduler tick). It contains no
//      business logic of its own beyond gluing the pieces above to React's
//      lifecycle and the browser's `localStorage`/`window`.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { getPublicKey } from 'nostr-tools/pure'
import { makePool } from '../wire/relayClient'
import type { RelayLike } from '../wire/relayClient'
import { armPeriodicFlush, flush, type StorageLike } from '../wire/outbox'
import {
  buildGrantPayload,
  buildResyncRequestPayload,
  buildSnapshotPayload,
  type ConfigDocKind,
  type GrantPayload,
  type RequestPayload,
  type RootAttestation,
  type SnapshotPayload,
} from '../wire/payloads'
import { loadState, saveState } from '../state/persist'
import { activeChildren, addEntry, applyConfigDoc, configRecipients, recordGrantResult, recordRequestDecision, requestAlreadyDecided, upsertRequest, claimPeriodGrantable } from '../state/state'
import type { AppState, ConfigDocs, Role } from '../state/types'
import { reanchorConfigs } from '../domain/reanchor'
import { creditEntry, debitEntry } from '../domain/ledger'
import type { Entry } from '../domain/types'
import { mintToken, type MintedToken } from '../pairing/tokens'
import { loadFamilyMnemonic, vaultLoad } from '../identity/vault'
import { sendAck, sendConfig, sendEntry, sendRequest, sendResyncReply, sendResyncRequest, sendSnapshot, sendStatus, sendVault } from '../sync/publish'
import { shouldPublishVault, vaultPayloadFor, vaultRosterOf, vaultRosterSignature } from '../identity/signetVault'
import { guardianFromMnemonic } from '../identity/derive'
import { clearPin } from '../identity/pinLock'
import { startGuardianSync, type PairingSession as MultiPairingSession } from '../sync/multi'
import { startSync } from '../sync/engine'
import type { Effect, PairTokenStore } from '../sync/ingress'
import {
  acksFor,
  catchUpDue,
  compareStatus,
  ingestResyncEvents,
  nextResyncCursor,
  resyncPage,
  servesResyncPage,
  statusAccepted,
  statusFor,
  STATUS_INTERVAL_MS,
  type ResyncExchange,
} from '../sync/resync'
import type { AnsweredPairClaim } from '../pairing/pairing'
import { wireKeyWipe, wireLock } from '../platform/lockPolicy'
import { notify, startRelayService, stopRelayService } from '../platform/shell'
import { notificationToFire, type NotificationToFireOpts } from '../platform/notifyPolicy'
import type { NotifiableEvent, NotificationContext } from '../platform/notifications'
import { formatMinor } from '../domain/money'
import { runSchedulers } from './scheduler'
import { grantsFor, scopeSnapshotState } from '../sync/snapshot'
// screens/approvals.ts's `clampGrant` is the tested home for the stepper's
// 0..asked clamp rule (Task 5's file list puts the Approvals inbox's pure
// logic there) — buildGrantDecision below is its one non-screen caller,
// since the SAME clamp must apply whether a decision comes from a live
// Stepper tap or (as in store.test.ts) a direct function call.
import { clampGrant } from '../screens/approvals'
import { raiseChoreGateClaims } from '../screens/chores'

/** The vault key the guardian's own signing key lives under — matches
 *  App.tsx's existing debug flow (identity/vault.ts stores it there once
 *  during onboarding via `startAsGuardian`); kept as the same literal here
 *  rather than re-exported from App.tsx, which owns none of this module's
 *  concerns and is itself replaced by real onboarding screens in Task 3. */
const GUARDIAN_SK_NAME = 'guardian-sk'

// NOTE: there is deliberately NO vault slot for a child device's own signing
// key anymore. A first version of this module read/wrote one (named
// `CHILD_SK_NAME`, mirroring `GUARDIAN_SK_NAME` above) as a "session cache"
// — a security review found that design didn't actually gate the key behind
// the PIN at all: `identity/vault.ts`'s wrap is device-bound, not PIN-bound
// (no passphrase needed to `vaultLoad` it), and the sessionStorage flag that
// was meant to gate TRUSTING that slot is trivially forgeable by anyone with
// console access on the page. See identity/pinLock.ts's header ("THE
// MODEL") for the fixed design: the child sk now lives ONLY in the `childSk`
// React state below once `unlockChildSk` sets it — never in any browser
// storage — so EVERY fresh mount (reload, restored tab, new tab, console
// access before a real unlock happens) finds `childSk` null and lands on
// ChildLock. `identity/pinLock.ts` itself now owns only the durable,
// PIN-wrapped blob; there is nothing left for this module to vault-load at
// all on the child side.

/** 15 minutes — see the plan's "scheduler on mount + every 15 min + on app
 *  focus". */
export const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000

/** Every action builder below needs the same handful of injected wire
 *  dependencies (never a module-level default — see publish.ts's own header
 *  for why `storage` in particular must always be explicit). `nowSec` is
 *  obtained ONCE by the caller (a screen action, or the shell's own
 *  effects) and threaded through, per Global Constraints. */
export interface WireOpts {
  selfSk: Uint8Array
  relay: RelayLike
  storage: StorageLike
  nowSec: number
}

// ============================================================================
// Pairing session — pure constructors; PairTokenStore adapters are the
// shell's job (they need a live, mutable reference into React state).
// ============================================================================

/** The guardian-side state of an open pairing ceremony (Task 3's PairDevice
 *  screen). Deliberately never persisted alongside `AppState` (see
 *  `AppProvider`'s persistence effect) — it carries the family mnemonic for
 *  as long as a ceremony is open, and the mnemonic's only durable home is
 *  the vault (Global Constraints: "the mnemonic is shown exactly once..."). */
export interface PairingSessionState {
  token: MintedToken
  mnemonic: string
  childIndex: number
  childName: string
  relays: string[]
  /** 'burned': a claim consumed the token (single-use) but was refused
   *  (devicePk mismatch, or any other `answerPairClaim` failure) — the UI
   *  must re-mint rather than keep showing a QR/SAS for a token that no
   *  longer exists (Plan 2 carry-forward: "a burned pair token... needs UI:
   *  re-mint + show fresh QR/SAS rather than appearing to hang"). */
  status: 'active' | 'burned'
}

/** Starts a pairing ceremony for an EXISTING child (already added via
 *  `state/onboarding.ts#addChild` — that's what assigns the index/name a
 *  device claim will bind to; pairing hands an already-decided identity to
 *  a physical device, it does not invent a new one). `null` if `childPubkey`
 *  isn't a known child. */
export function beginPairingSession(
  app: AppState,
  childPubkey: string,
  mnemonic: string,
  relays: string[],
  nowSec: number,
): PairingSessionState | null {
  const child = app.children.find((c) => c.pubkey === childPubkey)
  if (child === undefined) return null
  return { token: mintToken(nowSec), mnemonic, childIndex: child.index, childName: child.name, relays, status: 'active' }
}

/** Re-mints a fresh token for the SAME child/relays after a burn (or simply
 *  an expired TTL) — same identity, new token, `status` reset to 'active'. */
export function reMintPairingSession(session: PairingSessionState, nowSec: number): PairingSessionState {
  return { ...session, token: mintToken(nowSec), status: 'active' }
}

/** The snapshot for ONE child device — a PAIR_OFFER's embedded one, or the
 *  answer to a heartbeat that shows the child behind. Built fresh from
 *  current `AppState` rather than captured once at `beginPairingSession`
 *  time, so a claim landing near the end of the token's 600s TTL still hands
 *  the device an up-to-date ledger.
 *
 *  Scoped to `childPk` (audit P6): that child's profile, entries and config
 *  rows only — never a sibling's. See `sync/snapshot.ts`. It also carries
 *  that child's decided asks as GRANTs, so a GRANT a relay dropped heals. */
export function snapshotOf(app: AppState, childPk: string): SnapshotPayload {
  return buildSnapshotPayload(scopeSnapshotState(app, childPk), rootAttestationOf(app), grantsFor(app, childPk))
}

/** The pubkey a pairing session's claim will bind to — the roster entry the
 *  ceremony was opened for (`beginPairingSession` copies its index). `null`
 *  if that child has since left the roster. Pure. */
export function pairingChildPk(app: AppState, childIndex: number): string | null {
  return app.children.find((c) => c.index === childIndex)?.pubkey ?? null
}

/** The family root as it travels on the wire (v0.2 spec §1.5) — the pubkey
 *  and the attestation, nothing else: `backedUpAt` is this device's own
 *  bookkeeping and is no business of a child's. `undefined` for a phrase
 *  root or none, which is exactly what the parsers treat as "no root
 *  claimed". Pure. */
export function rootAttestationOf(app: AppState): RootAttestation | undefined {
  const root = app.root
  if (root === null || root.kind !== 'signet') return undefined
  return { pubkey: root.pubkey, authEvent: root.authEvent }
}

/** Builds the `NotificationContext` Task E4's `onEffect` glue needs to ask
 *  `platform/notifyPolicy.ts#notificationToFire` what (if anything) to say —
 *  pure, `app` passed in explicitly rather than read off a ref, so it is
 *  unit-testable here without DOM (the DOM/window half — actually calling
 *  `shell.ts#notify`, and reading `document.visibilityState` — stays in
 *  `AppProvider`, same split as every other piece of this module's header
 *  describes). `childNameFor` reads `app.children`; `formatMoney` is
 *  `domain/money.ts#formatMinor`, the same formatter `components/Money.tsx`
 *  itself is built on (see that module's re-export of `moneyParts`).
 *  `currencyForAccount` (fix round 1 — IMPORTANT 2) is the store's own
 *  answer to a question `platform/notifications.ts` cannot ask itself: an
 *  `AuditResult` (domain/audit.ts) carries only an account ID, never a
 *  currency, but THIS module has `app.docs.accounts` to actually resolve
 *  one from — `notificationFor`'s hard-coded 'GBP' now only applies when
 *  even this lookup comes back empty (a deleted/never-synced account). */
export function notificationContextFor(role: 'guardian' | 'child', app: AppState): NotificationContext {
  return {
    role,
    childNameFor: (pubkey) => app.children.find((c) => c.pubkey === pubkey)?.name ?? null,
    formatMoney: safeFormatMoney,
    currencyForAccount: (accountId) => app.docs.accounts.accounts.find((a) => a.id === accountId)?.currency ?? null,
  }
}

/** `formatMinor` (domain/money.ts), adapted to `NotificationContext`'s
 *  `(amountMinor, currency)` order (flipped from `formatMinor`'s own
 *  `(currencyCode, minor)`) and made total: `currencyOrThrow`/`assertMinor`
 *  throw on a currency code outside `CURRENCIES` or a non-safe-integer
 *  amount, and a `request`'s `currency`/`amountMinor` here are self-reported
 *  by a child device over the wire — `wire/payloads.ts`'s own
 *  `isSpendRequestParams` checks only that `currency` is a non-empty
 *  STRING, never that it names a real currency. A notification callback
 *  must never throw (the same "never throws" contract every function in
 *  `platform/shell.ts` documents for itself), so a malformed/malicious pair
 *  falls back to a plain `"<currency> <amountMinor>"` string (fix round 1:
 *  previously a bare digit string with the currency dropped entirely,
 *  which — for a currency that merely isn't one this build recognises,
 *  rather than genuinely garbage — threw away real information) rather
 *  than crashing the engine's `onEffect` callback. */
function safeFormatMoney(amountMinor: number, currency: string): string {
  try {
    return formatMinor(currency, amountMinor)
  } catch {
    return `${currency} ${amountMinor}`
  }
}

// ============================================================================
// Reducer
// ============================================================================

export interface StoreState {
  app: AppState
  pairing: PairingSessionState | null
  /** A one-off message for the guardian shell to show once, dismissably —
   *  for a screen that has something to say at the very moment it unmounts
   *  (U8: Onboarding's My Signet recovery note is lost when the restored
   *  roster swaps the app to GuardianShell). In memory only, never
   *  persisted: it only has to survive that swap. */
  notice: string | null
}

export function initialStoreState(app: AppState): StoreState {
  return { app, pairing: null, notice: null }
}

export type StoreAction =
  | { type: 'updateApp'; update: (app: AppState) => AppState }
  | { type: 'beginPairing'; session: PairingSessionState }
  | { type: 'burnPairing' }
  | { type: 'endPairing' }
  | { type: 'setNotice'; notice: string }
  | { type: 'clearNotice' }

/** Pure. `updateApp` is the one action every other action in this module
 *  ultimately funnels through — kept as its own case rather than one action
 *  per business operation so this reducer never needs to know about
 *  entries/configs/grants itself.
 *
 *  `update` is a FUNCTION of `state.app`, not a precomputed `AppState`, and
 *  that is load-bearing rather than a style preference. `useReducer`
 *  guarantees each dispatched action's reducer call sees the state left by
 *  whichever action was processed immediately before it — including other
 *  actions dispatched from elsewhere (React batches multiple dispatches
 *  together, but always processes them through the reducer IN ORDER, each
 *  building on the last). If instead every caller computed a whole `next`
 *  app for itself (e.g. from a `stateRef` snapshot taken outside React) and
 *  dispatched THAT, two updates racing — a background sync delivering an
 *  entry from one child at nearly the same moment as another — would each
 *  compute their `next` from the SAME stale snapshot, and whichever
 *  dispatch's reducer call ran second would silently clobber the first's
 *  entry: gone from memory and, since persistence is driven off this same
 *  `state.app`, gone from disk too. Routing every caller through `update`
 *  instead means the reducer itself — the one place guaranteed to see the
 *  TRUE current `app` — is what every accumulation actually happens
 *  against. See `sync/multi.ts`'s module header for where this was found
 *  (the guardian engine's inbound wraps) and `AppProvider`'s scheduler
 *  effect for the other call site it applies to. */
export function storeReducer(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    case 'updateApp': {
      const nextApp = action.update(state.app)
      return nextApp === state.app ? state : { ...state, app: nextApp }
    }
    case 'beginPairing':
      return { ...state, pairing: action.session }
    case 'burnPairing':
      if (state.pairing === null || state.pairing.status === 'burned') return state
      return { ...state, pairing: { ...state.pairing, status: 'burned' } }
    case 'endPairing':
      return state.pairing === null ? state : { ...state, pairing: null }
    case 'setNotice':
      return { ...state, notice: action.notice }
    case 'clearNotice':
      return state.notice === null ? state : { ...state, notice: null }
    default:
      return state
  }
}

// ============================================================================
// Action builders — plain async functions, DOM-free, unit-testable directly.
//
// Each takes an explicit `app: AppState` snapshot and returns a whole next
// `app`. That is the right shape for these functions' OWN unit tests
// (store.test.ts) and for a genuinely single-shot caller — but wiring one of
// these into `AppProvider` behind a live `dispatch` later (Task 3+'s screen
// actions) must NOT do `dispatch({ type: 'updateApp', update: () =>
// result.app })` naively: if anything else (the guardian engine, the
// scheduler tick) could have mutated `state.app` in the time this function's
// own `await`s were in flight, that precomputed `result.app` is exactly the
// stale-snapshot hazard `sync/multi.ts`'s module header and `storeReducer`'s
// `updateApp` doc comment describe — see the scheduler effect below
// (`runSchedulers` re-run fresh inside the dispatched updater) for the
// pattern a racy caller needs instead.
// ============================================================================

/** Applies `entry` locally, then sends it to the child it belongs to
 *  (`entry.child` IS that child's pubkey — the same convention used
 *  throughout wire/state, e.g. `ChildProfile.pubkey`). */
export async function addEntryAndSend(app: AppState, entry: Entry, opts: WireOpts): Promise<{ app: AppState; sent: boolean }> {
  const next = addEntry(app, entry)
  const result = await sendEntry(entry, { selfSk: opts.selfSk, peerPk: entry.child, relay: opts.relay, storage: opts.storage, nowSec: opts.nowSec })
  return { app: next, sent: result.sent }
}

/** Stamps a config doc body with `v: 1` and a MONOTONIC `issuedAt` —
 *  `max(nowSec, docHighWater[docKind] + 1)`, never `nowSec` verbatim. Plain
 *  `nowSec` would collide with `state/state.ts#applyConfigDoc`'s
 *  anti-rollback rule (`doc.issuedAt <= highWater` is DROPPED, not applied)
 *  the moment two edits to the same doc kind land within the same wall-clock
 *  second — a real scenario for a guardian editing settings quickly, e.g.
 *  adding two accounts back to back — silently losing the second edit both
 *  locally and on every child (`applyConfigDoc` returns the SAME state
 *  reference back for an edit that loses this race, so the caller would see
 *  its own just-submitted edit vanish). Bumping strictly past the current
 *  high-water mark instead guarantees every stamped doc actually wins,
 *  regardless of how closely spaced in real time.
 *
 *  Exported (rather than kept private to `publishConfigDoc` below) so a live
 *  screen (Task 6's ChildSettings.tsx) can reuse the SAME stamping logic
 *  when it needs to split "compute the doc" from "apply + send" itself —
 *  dispatching `publishConfigDoc`'s own precomputed `{ app }` back via
 *  `dispatch({ update: () => result.app })` would reopen exactly the
 *  stale-snapshot hazard `storeReducer`'s `updateApp` doc comment describes.
 *
 *  CAUTION for any such caller: calling this ONCE, before dispatch, against
 *  a captured `app` snapshot — then dispatching a `(a) => applyConfigDoc(a,
 *  docKind, doc)` updater closed over that already-stamped `doc` — closes
 *  the MUTATION-visibility hazard above but NOT a second, narrower one:
 *  `issuedAt` itself would still be computed from a snapshot taken before
 *  dispatch, so two saves to the SAME `docKind` landing in the same render
 *  frame (e.g. a fast double-tap on Save, before React has re-rendered to
 *  disable the button) would each read the SAME stale
 *  `app.docHighWater[docKind]` and stamp the SAME `issuedAt` — the SECOND
 *  dispatch's `applyConfigDoc` would then see `doc.issuedAt <= highWater`
 *  (already bumped by the first) and silently DROP it, losing the second
 *  edit both locally and over the wire. The correct call site is therefore
 *  INSIDE the dispatched updater itself — `dispatch({ type: 'updateApp',
 *  update: (a) => applyConfigDoc(a, docKind, stampConfigDoc(a, docKind,
 *  docBody, nowSec)) })` — which is safe because `useReducer` processes
 *  dispatched actions strictly in order: by the time a LATER action's
 *  updater runs, `docHighWater` already reflects any earlier-dispatched
 *  save to the same doc kind. See `ChildSettings.tsx`'s own `saveDoc` for
 *  the live wiring (and its `pendingConfigSendsRef` for how the stamped doc
 *  — needed AFTER commit, for the actual wire send — is captured out of the
 *  updater without putting a network call inside it). */
export function stampConfigDoc<K extends ConfigDocKind>(
  app: AppState,
  docKind: K,
  docBody: Omit<ConfigDocs[K], 'v' | 'issuedAt'>,
  nowSec: number,
): ConfigDocs[K] {
  const issuedAt = Math.max(nowSec, (app.docHighWater[docKind] ?? 0) + 1)
  return { v: 1, issuedAt, ...guardConfigBody(app, docKind, docBody, nowSec) } as ConfigDocs[K]
}

/** The money-safety rules every guardian config save goes through (this is
 *  the single save path — `stampConfigDoc` above, used by `publishConfigDoc`
 *  and by every screen's in-updater save):
 *
 *  - allowance/interest (audit D1/D3/D4): each config is re-anchored
 *    against its predecessor in the CURRENT doc (`domain/reanchor.ts`), so
 *    switching account or cadence, toggling `paused` or turning a gate off
 *    never reopens history.
 *  - accounts (audit U1): `revoked` is carried over from the current doc
 *    unless the caller supplies it explicitly, so a rename/add/archive can
 *    never silently re-admit a removed device. */
function guardConfigBody<K extends ConfigDocKind>(
  app: AppState,
  docKind: K,
  docBody: Omit<ConfigDocs[K], 'v' | 'issuedAt'>,
  nowSec: number,
): Omit<ConfigDocs[K], 'v' | 'issuedAt'> {
  if (docKind === 'allowance') {
    const body = docBody as Omit<ConfigDocs['allowance'], 'v' | 'issuedAt'>
    return { ...body, configs: reanchorConfigs(app.docs.allowance.configs, body.configs, nowSec) } as unknown as typeof docBody
  }
  if (docKind === 'interest') {
    const body = docBody as Omit<ConfigDocs['interest'], 'v' | 'issuedAt'>
    return { ...body, configs: reanchorConfigs(app.docs.interest.configs, body.configs, nowSec) } as unknown as typeof docBody
  }
  if (docKind === 'accounts') {
    const body = docBody as Omit<ConfigDocs['accounts'], 'v' | 'issuedAt'>
    const current = app.docs.accounts.revoked
    if (!('revoked' in body) && current !== undefined) return { ...body, revoked: current } as unknown as typeof docBody
  }
  return docBody
}

/** Publishes a config doc: stamps it via `stampConfigDoc` above, applies it
 *  locally via the same anti-rollback LWW every inbound CONFIG uses, then
 *  broadcasts it to every currently ACTIVE child — `state.ts#configRecipients`,
 *  i.e. the roster minus anyone revoked (each is a separate gift-wrapped
 *  send — see the carry-forward note on config docs being family-wide rather
 *  than per-child; broadcasting identically to everyone is the current,
 *  documented limitation). */
export async function publishConfigDoc<K extends ConfigDocKind>(
  app: AppState,
  docKind: K,
  docBody: Omit<ConfigDocs[K], 'v' | 'issuedAt'>,
  opts: WireOpts,
): Promise<{ app: AppState; sent: boolean }> {
  const doc = stampConfigDoc(app, docKind, docBody, opts.nowSec)
  const next = applyConfigDoc(app, docKind, doc)
  let sent = true
  // Deliberately sequential, NOT `Promise.all`-ed: each `sendConfig` call
  // enqueues into the SAME shared `opts.storage` outbox and then flushes it
  // (publish.ts#send). `wire/outbox.ts#flush` reads a full snapshot of
  // whatever is currently queued on every call — so two overlapping flushes
  // can each read a snapshot containing the OTHER child's just-enqueued
  // wrap too, and both would publish it (removal, not publish, is where
  // outbox.ts's re-entrancy guarantee actually applies — see its module
  // header). Awaiting each send before starting the next keeps every flush
  // strictly non-overlapping, at the cost of one relay round-trip per child
  // rather than running them concurrently (this is the same hazard
  // `sync/multi.ts`'s batch flush works around by awaiting its own sends
  // first — see that module's header).
  for (const peerPk of configRecipients(next)) {
    const result = await sendConfig(docKind, doc, { selfSk: opts.selfSk, peerPk, relay: opts.relay, storage: opts.storage, nowSec: opts.nowSec })
    if (!result.sent) sent = false
  }
  return { app: next, sent }
}

export interface GrantDecisionInput {
  request: RequestPayload
  /** 'dismissed' (v0.2 spec §4.3) is a real, SENT decision — the guardian
   *  setting an ask aside — not the guardian-local status flip it used to
   *  be. It is answered exactly like a 'deny' (no entry, a GRANT so the
   *  child's device stops waiting) but records, and tells the child,
   *  'dismissed' rather than 'denied'. */
  decision: 'allow' | 'deny' | 'dismissed'
  /** For `spend.request` + 'allow': the amount to actually grant (Task 5's
   *  stepper) — defaults to the full requested amount. Ignored for
   *  `allowance.claim` (paid in full — a period is either released or not)
   *  and for any 'deny'. Clamped to `0..asked` via `clampGrant`; a clamp of
   *  exactly 0 is treated as a deny (Task 5: "granting 0 = deny") rather
   *  than publishing a zero-amount entry (which `debitEntry` would refuse
   *  outright — `assertPositiveMinor`). */
  amountMinor?: number
}

/** What answering a `spend.request`/`allowance.claim` REQUEST effect
 *  actually does — deliberately NOT a precomputed next `AppState` (see this
 *  module's header on `updateApp`, and the carried instruction this
 *  function replaces `applyGrantDecision` to satisfy: "grant decisions must
 *  be wired via functional updaters, NOT the current snapshot-shaped
 *  applyGrantDecision"). `applyToApp` is a FUNCTION of whatever `app` the
 *  reducer hands it at dispatch time, exactly like `sync/multi.ts`'s own
 *  `setState` updaters — composing correctly however many wraps/other
 *  decisions landed between `buildGrantDecision`'s own snapshot read and
 *  the actual dispatch, rather than clobbering them the way
 *  `dispatch({ update: () => precomputedNext })` would. See
 *  `screens/Approvals.tsx#submitDecision`, the one live caller, for the
 *  "dispatch the pure updater first, send after" pattern this pairs with
 *  (QuickActions.tsx's `submitEntry` established it for plain entries;
 *  this is the same shape generalised to also cover the request-status
 *  flip and the GRANT). */
export interface GrantDecisionBuild {
  applyToApp: (app: AppState) => AppState
  /** Always present — even a deny/0-clamp sends a GRANT, so the child's own
   *  UI stops showing the request as outstanding. */
  grant: GrantPayload
  /** Present only for a genuine non-zero allow — the entry to apply+send. */
  entry?: Entry
  /** Set (as a mutable box, `{ entryApplied: false }`) ONLY by the
   *  allowance.claim branch's entry-bearing build below, and only when
   *  `entry` is itself present — undefined for `spend.request` (its
   *  `grantEntryId` dedupe-by-id is already sufficient: two builds for the
   *  same reqId always carry the SAME entry, so sending it twice is
   *  harmless) and for the allowance.claim branch's OWN already-paid-at-
   *  snapshot-time early return (no `entry` there to send at all).
   *
   *  Exists because `entry`'s mere PRESENCE on this build is a snapshot-time
   *  fact — it says "the period looked unpaid when buildGrantDecision ran" —
   *  not a dispatch-time one. `applyToApp` re-checks `periodAlreadyPaid`
   *  fresh (see that closure's own comment) and may, at ACTUAL dispatch
   *  time, discover a scheduler entry for the same period landed first and
   *  skip adding this build's `entry` — but a caller (screens/Approvals.tsx#
   *  submitDecision) that only looked at `entry !== undefined` would still
   *  send it over the wire regardless, under its own distinct `grant:`-
   *  prefixed id: the child's dedupe-by-id can't collapse that against the
   *  `sched:`-prefixed entry it already has, so it would apply BOTH —
   *  exactly the double-credit the `applyToApp` re-check was meant to
   *  prevent locally, reopened at the wire layer. `applyToApp` flips
   *  `entryApplied` to `true` on (and only on) the path that actually calls
   *  `addEntry(a, entry)`, so a caller can check `entryOutcome?.entryApplied
   *  !== false` AFTER dispatching (dispatch runs the updater synchronously —
   *  see `storeReducer`'s own header) to learn whether sending `entry` is
   *  still correct. StrictMode's dev-only double-invoke just sets the same
   *  `true` twice — idempotent, not a hazard. */
  entryOutcome?: { entryApplied: boolean }
}

/** Deterministic id for the ONE entry a given request's approval can ever
 *  produce — `grant:` + reqId, mirroring scheduler.ts's own
 *  `sched:${kind}:${child}:${account}:${dueDay}` idempotent-id convention.
 *  Deliberately NOT `newId()` (domain/id.ts, which mints fresh randomness
 *  every call): `buildGrantDecision` is pure and can be invoked more than
 *  once for the SAME reqId (a genuine race — e.g. a guardian's retry after
 *  a failed send, before the first attempt's local decision has committed
 *  and made `requestAlreadyDecided` start refusing — see
 *  screens/Approvals.tsx#submitDecision's own explicit pre-check, which
 *  narrows but cannot fully close that window on its own). A random id per
 *  call would let two such racing sends each carry a DIFFERENT entry id
 *  over the wire, and the receiving child's own `addEntry` dedupes by id —
 *  it would apply BOTH as distinct, real debits/credits. A deterministic id
 *  makes a racing double-send produce byte-identical entries, which the
 *  child's dedupe then correctly collapses to one. */
export function grantEntryId(reqId: string): string {
  return `grant:${reqId}`
}

/**
 * Whether a GRANT a CHILD received implies a ledger entry it does not hold
 * (v0.3 child catch-up). Pure.
 *
 * An allowed `spend.request` always comes with exactly one guardian ENTRY,
 * under the deterministic id `grantEntryId(reqId)` (see `buildGrantDecision`).
 * If the GRANT arrived and that entry has not, either it is still in flight
 * (the caller waits a little before asking) or a relay dropped it.
 *
 * An allowed `allowance.claim` implies nothing checkable: the period may
 * already have been paid by the scheduler under a different id.
 */
export function grantAwaitsEntry(app: AppState, grant: GrantPayload): boolean {
  if (grant.decision !== 'allow') return false
  if (typeof grant.params.amountMinor !== 'number') return false
  const id = grantEntryId(grant.reqId)
  return !app.entries.some((e) => e.id === id)
}

/** How long a child waits for a granted spend's ENTRY to follow its GRANT
 *  before treating it as lost. The two are separate wraps, sent back to
 *  back, and relays promise no order. */
export const GRANT_ENTRY_GRACE_MS = 2 * 60_000

/** Mirrors domain/allowance.ts's own `allowanceDue` internal "paid" set —
 *  see `buildGrantDecision`'s allowance.claim branch below (the plan's
 *  "allowance.claim... idempotent — already-paid periodKey -> treat as
 *  approved, no double entry") for why this needs to be keyed by periodKey
 *  rather than reqId: a duplicate claim for the same period can arrive
 *  under a fresh reqId/nonce (a child's own retry), which reqId-based
 *  dedupe alone (`requestAlreadyDecided`) would not catch. */
function periodAlreadyPaid(entries: Entry[], accountId: string, periodKey: string): boolean {
  const reversedIds = new Set(entries.map((e) => e.reverses).filter((r): r is string => r !== undefined))
  return entries.some(
    (e) => e.category === 'allowance' && e.periodKey === periodKey && !reversedIds.has(e.id) && e.legs.some((l) => l.account === accountId),
  )
}

/** Pure. Computes how to answer a `spend.request`/`allowance.claim`
 *  REQUEST: the GRANT to send, the entry (if any) to apply+send, and the
 *  `applyToApp` updater a caller must dispatch (see `GrantDecisionBuild`'s
 *  doc comment). `applyToApp` re-derives its own idempotency check FRESH
 *  against whatever `app` the reducer actually hands it — the OUTER
 *  `requestAlreadyDecided` check just below only decides whether it's worth
 *  building an entry/GRANT to send AT ALL from this snapshot (so a caller
 *  never sends a duplicate entry over the wire for an already-answered
 *  request); the closure is what makes the eventual STATE MUTATION safe
 *  even if that outer check's snapshot was stale by the time of dispatch
 *  (two decisions landing back to back for the same reqId).
 *
 *  Returns `null` — refusing to build/send anything — for: any op other
 *  than `spend.request`/`allowance.claim` (`pair.claim` is never answered
 *  this way, see ingress.ts's module header); a request naming an
 *  account/allowance config this guardian doesn't actually have, INCLUDING
 *  an archived account (mirrors scheduler.ts's own `accountFor` — the
 *  carried defect this closes: the account lookup previously omitted the
 *  `!archived` check); or a reqId that has ALREADY been decided (the other
 *  carried defect this closes: "no idempotency check against
 *  request.reqId... answering the same request twice... creates two ledger
 *  entries").
 *
 *  On 'deny' (explicit, or an 'allow' whose stepper clamp lands on exactly
 *  0 via `clampGrant` — including a malformed request naming a negative
 *  "asked" amount, which `clampGrant` also forces to 0 rather than letting
 *  a positive clamp reach `debitEntry`'s `assertPositiveMinor` as an
 *  unhandled throw — the third carried defect this closes), only a deny
 *  GRANT is built — no entry. */
export function buildGrantDecision(app: AppState, input: GrantDecisionInput, nowSec: number): GrantDecisionBuild | null {
  const { request } = input
  if (request.op !== 'spend.request' && request.op !== 'allowance.claim') return null
  if (requestAlreadyDecided(app, request.reqId)) return null

  // A deny GRANT still echoes `periodKey` for an allowance.claim (spend.request
  // has no periodKey concept, so it stays `{}`) — found by review: without
  // this, a scheduler-originated gated claim (reqId `scheduler:...`, never
  // sent by the child itself — see recordGrantResult's own doc comment)
  // denied by the guardian arrives at the child with an EMPTY params object.
  // recordGrantResult's synthetic-row path (the only path a reqId like that
  // ever takes on the child) copies whatever periodKey the GRANT carries —
  // none, in that case — so the synthesised StoredRequest ends up with no
  // periodKey at all. screens/chores.ts#alreadyClaimed matches by
  // `params.periodKey`, so a periodKey-less denied row is invisible to it,
  // and the child's own chores-gate effect (choreGateReadyClaims), finding
  // no matching claim on record, re-raises a FRESH allowance.claim for the
  // very period the guardian just denied — the denial never sticks.
  //
  // A 'dismissed' decision (v0.2 spec §4.3) takes this same no-entry path
  // and so inherits the periodKey echo for exactly the same reason: without
  // it, a dismissed gated claim reaches the child with empty params, the
  // synthesised row carries no periodKey, screens/chores.ts#alreadyClaimed
  // cannot match it, and the chores gate re-raises the very period the
  // guardian just set aside. That is a deliberate refinement of spec §4.3's
  // literal "params: {}", which holds for spend.request (as below).
  const noEntry = (decision: 'deny' | 'dismissed'): GrantDecisionBuild => {
    const params: Record<string, unknown> =
      request.op === 'allowance.claim' ? { periodKey: (request.params as { periodKey: string }).periodKey } : {}
    const status = decision === 'deny' ? 'denied' : 'dismissed'
    return {
      grant: buildGrantPayload({ reqId: request.reqId, nonce: request.nonce, decision, ts: nowSec, params }),
      applyToApp: (a) => recordRequestDecision(a, request, request.child, status, nowSec),
    }
  }
  const denyOnly = (): GrantDecisionBuild => noEntry('deny')

  if (input.decision === 'deny') return denyOnly()
  // A dismissal is answered before ANY op-specific validation, exactly as a
  // deny is: an unanswerable request (unknown account, illegitimate period)
  // must still be dismissible, and setting it aside touches no money.
  if (input.decision === 'dismissed') return noEntry('dismissed')

  if (request.op === 'spend.request') {
    const params = request.params as { amountMinor: number; currency: string; account: string; note?: string }
    // !archived — the carried defect: scheduler.ts's own accountFor applies
    // this check, this lookup previously didn't, so a request naming a
    // since-archived account would still get granted.
    const account = app.docs.accounts.accounts.find((a) => a.id === params.account && a.child === request.child && !a.archived)
    if (account === undefined) return null

    const clamped = clampGrant(params.amountMinor, input.amountMinor ?? params.amountMinor)
    if (clamped === 0) return denyOnly()

    const entry = debitEntry(
      {
        id: grantEntryId(request.reqId),
        child: request.child,
        createdAt: nowSec,
        author: 'guardian',
        requestId: request.reqId,
        note: params.note,
      },
      account,
      clamped,
      'spend',
    )
    const grant = buildGrantPayload({ reqId: request.reqId, nonce: request.nonce, decision: 'allow', ts: nowSec, params: { amountMinor: clamped } })
    return {
      grant,
      entry,
      applyToApp: (a) => {
        if (requestAlreadyDecided(a, request.reqId)) return a // re-checked fresh — see this function's own header
        return recordRequestDecision(addEntry(a, entry), request, request.child, 'approved', nowSec, clamped)
      },
    }
  }

  // allowance.claim
  const params = request.params as { periodKey: string }
  const cfg = app.docs.allowance.configs.find((c) => c.child === request.child)
  if (cfg === undefined) return null
  const account = app.docs.accounts.accounts.find((a) => a.id === cfg.account && !a.archived)
  if (account === undefined) return null

  // Money-stakes guard: the claimed periodKey must be one this config's own
  // cadence could actually have produced (domain/allowance.ts's
  // `legitimatePeriodKeys`) — wire/payloads.ts's own
  // `isAllowanceClaimParams` only checks that `periodKey` is a non-empty
  // STRING, so a hostile or malformed claim naming an arbitrary/fabricated
  // period (or a legitimate-LOOKING but far-future one) must never be
  // payable just because it parses. Refused the same way an unknown
  // account/config is — no GRANT built at all; a claim like this is still
  // answerable via "Not now"/dismiss, which never reach this check (see
  // the top-level `if (input.decision === 'deny') return denyOnly()`
  // above, which short-circuits before any op-specific validation).
  // A claim pending since before a re-anchoring edit stays grantable
  // (review R2) — see state.ts#claimPeriodGrantable.
  if (!claimPeriodGrantable(app, request, cfg, nowSec)) return null

  const grant = buildGrantPayload({ reqId: request.reqId, nonce: request.nonce, decision: 'allow', ts: nowSec, params: { periodKey: params.periodKey } })

  if (periodAlreadyPaid(app.entries, account.id, params.periodKey)) {
    // Already paid for this periodKey (the scheduler itself may have paid
    // it between the claim surfacing and the guardian approving it, or a
    // duplicate claim under a different reqId/nonce for the same period) —
    // approve without a second entry, per the plan's "already-paid
    // periodKey -> treat as approved, no double entry".
    return {
      grant,
      applyToApp: (a) => {
        if (requestAlreadyDecided(a, request.reqId)) return a
        return recordRequestDecision(a, request, request.child, 'approved', nowSec)
      },
    }
  }

  const entry: Entry = {
    ...creditEntry(
      { id: grantEntryId(request.reqId), child: request.child, createdAt: nowSec, author: 'guardian', requestId: request.reqId },
      account,
      cfg.amountMinor,
      'allowance',
    ),
    periodKey: params.periodKey,
  }
  // See `GrantDecisionBuild.entryOutcome`'s own doc comment: this mutable
  // box is how `applyToApp` below reports back, AFTER dispatch, whether it
  // actually applied `entry` — a caller (Approvals.tsx#submitDecision) needs
  // that to decide whether sending `entry` over the wire is still correct,
  // since `entry`'s mere presence on this build reflects only the snapshot
  // `buildGrantDecision` was called against, not what `applyToApp` decides
  // once it re-checks `periodAlreadyPaid` fresh at actual dispatch time.
  const entryOutcome = { entryApplied: false }
  return {
    grant,
    entry,
    entryOutcome,
    applyToApp: (a) => {
      if (requestAlreadyDecided(a, request.reqId)) return a
      // Re-checked fresh, same reasoning as the requestAlreadyDecided check
      // just above (and as this function's own doc comment on why
      // `applyToApp` must re-derive idempotency against whatever `app` the
      // reducer actually hands it): the OUTER `periodAlreadyPaid` check a
      // few lines up only asked "is this period already paid, as of the
      // SNAPSHOT `buildGrantDecision` was called against" — it does not, and
      // cannot, see a scheduler payment for the SAME period that lands
      // (under a DIFFERENT entry id — `sched:...`, not `grant:...`) earlier
      // in the same dispatch batch, between that snapshot being read and
      // this closure actually running. Found by review: without this
      // re-check, such an interleave double-credits the child — the
      // scheduler's entry applies first, then this one applies UNCONDITIONALLY
      // on top of it, because `grantEntryId`'s dedupe-by-id only catches two
      // GRANT-shaped entries for the same reqId, never a grant landing after
      // an unrelated scheduler entry for the same period. Mirrors the
      // pre-check's own semantics exactly: approve the request, mint no
      // second entry — and, per `entryOutcome`'s own doc comment, leaves
      // `entryApplied` at its initial `false` so a caller knows NOT to send
      // `entry` either (the scheduler's own send already covers the child).
      if (periodAlreadyPaid(a.entries, account.id, params.periodKey)) {
        return recordRequestDecision(a, request, request.child, 'approved', nowSec)
      }
      entryOutcome.entryApplied = true
      return recordRequestDecision(addEntry(a, entry), request, request.child, 'approved', nowSec)
    },
  }
}

/** Runs the scheduler and applies+sends every entry it proposes — the
 *  synchronous local fold happens up front (so a caller reading `app`
 *  straight back sees every entry already applied), sends are fired after.
 *  Gated claims (`SchedulerResult.claims`) are returned as-is: Task 2 has
 *  nowhere durable to put them yet (`state.requests` lands in Task 5) —
 *  callers that care today (none yet) can render them transiently.
 *
 *  CAUTION for anything dispatching this result into `storeReducer`: `app`
 *  here is a single snapshot, and this whole computation (including the
 *  scan for what's due) runs against it once, up front. That's exactly
 *  right for a one-off, user-triggered call (e.g. a future "sync now"
 *  settings action) where nothing else is concurrently mutating `app` in
 *  the same window — but it is NOT what `AppProvider`'s own recurring
 *  scheduler effect uses, precisely because a recurring background tick CAN
 *  overlap with the live guardian engine's inbound wraps. See
 *  `AppProvider`'s scheduler effect (which re-runs `runSchedulers` fresh
 *  inside a `{ type: 'updateApp' }` closure instead) and `sync/multi.ts`'s
 *  module header for the general hazard this sidesteps only when the
 *  caller is genuinely the sole writer for the duration of the call. */
export async function runSchedulersAndSend(
  app: AppState,
  opts: WireOpts,
): Promise<{ app: AppState; claims: RequestPayload[]; sent: boolean }> {
  const { entries, claims } = runSchedulers(app, opts.nowSec)
  let next = app
  for (const entry of entries) next = addEntry(next, entry)
  let sent = true
  for (const entry of entries) {
    const result = await sendEntry(entry, { selfSk: opts.selfSk, peerPk: entry.child, relay: opts.relay, storage: opts.storage, nowSec: opts.nowSec })
    if (!result.sent) sent = false
  }
  return { app: next, claims, sent }
}

/** Which ledger a device's own view of the heartbeat covers, and whether a
 *  resync reply has to be narrowed to one child (review fix, round 1). A
 *  guardian holds every child's events and scopes per calling peer; a child
 *  holds one child's and scopes to itself. */
export type ResilienceScope = { kind: 'guardian' } | { kind: 'child'; selfPk: string }

// ---------------------------------------------------------------------------
// Child session: the key, and the lock, as two separate facts (spec §2.6)
// ---------------------------------------------------------------------------

/** A paired child device's live session. `sk` is key PRESENCE (in memory
 *  only, never any browser storage — see this module's header); `locked` is
 *  the UI decision, and the two are deliberately independent: a backgrounded
 *  shell session locks its screen at once yet keeps its key for a while, so
 *  sync and notifications carry on (platform/lockPolicy.ts). */
export interface ChildSession {
  sk: Uint8Array | null
  locked: boolean
}

export type ChildSessionAction =
  /** A correct PIN (ChildLock) or a just-completed pairing (ChildOnboarding). */
  | { type: 'unlock'; sk: Uint8Array }
  /** The screen goes behind the PIN; the key stays. `wireLock`'s callback. */
  | { type: 'lockUi' }
  /** The key goes, and with it the session. `wireKeyWipe`'s callback. */
  | { type: 'wipe' }

/** No key, locked — where every mount starts, because nothing durable holds a
 *  child key any more (see this module's header). */
export const initialChildSession: ChildSession = { sk: null, locked: true }

/**
 * Whether the Android foreground relay-keepalive service should be running
 * (v0.2 spec §3.2). Pure — the whole rule, in one place, so the effect that
 * acts on it has nothing left to get wrong.
 *
 * ROLE, and nothing else. It used to be decided inside the two engine
 * effects, whose dependency arrays also carry the peer set and the relay
 * pool: every roster edit and every relay-list edit therefore stopped and
 * restarted the foreground service, flickering its notification, dropping
 * and re-taking the wake lock, and on Android 15 restarting the dataSync
 * time-box each time — none of which has anything to do with whether the
 * device should be keeping in touch at all.
 *
 * `'unset'` is false and stays false: a device with no role has no family,
 * no keys and nothing to sync, so an ongoing notification would be a
 * promise about work that is not happening.
 */
export function shouldRunRelayService(role: Role): boolean {
  return role !== 'unset'
}

/** Pure. The whole of the difference between "locked" and "wiped". */
export function childSessionReducer(session: ChildSession, action: ChildSessionAction): ChildSession {
  switch (action.type) {
    case 'unlock':
      return { sk: action.sk, locked: false }
    case 'lockUi':
      return { ...session, locked: true }
    case 'wipe':
      return { sk: null, locked: true }
  }
}

// ============================================================================
// React shell
// ============================================================================

export interface AppContextValue {
  state: StoreState
  /** True while the last attempt to persist `state.app` failed (storage
   *  full or blocked — audit D7). Non-fatal: the app keeps running on its
   *  in-memory state; the UI should warn that recent changes are not yet
   *  saved on this device. */
  storageError: boolean
  dispatch: React.Dispatch<StoreAction>
  /** A bounded (last 50) log of non-auto-handled sync effects ('request',
   *  'grant', 'tick', 'audit', 'notify') the guardian engine has surfaced —
   *  Task 5 formalises real handling (persisting requests into
   *  `state.requests`); this is a stopgap so nothing is silently dropped in
   *  the meantime. */
  effects: Effect[]
  /** The shared relay pool the guardian engine/scheduler effects below
   *  already use, exposed so a screen that needs to publish something
   *  outside either of those (Task 3's PairDevice: sending the PAIR_OFFER a
   *  successfully-answered pair.claim produces, via `onPairClaimAnsweredRef`
   *  below) reuses the SAME pool rather than opening a second one against
   *  the same relay URLs. */
  relay: RelayLike
  /** The guardian's own signing key, once the vault-load effect below has
   *  resolved it (`null` for role 'unset'/'child', or briefly while
   *  loading) — exposed for the same reason as `relay` above. */
  guardianSk: Uint8Array | null
  /** The child device's own signing key, held ONLY in this React state —
   *  `null` for role 'unset'/'guardian', or for a still-locked child device.
   *  Never backed by a vault/localStorage/sessionStorage read — see this
   *  module's header (the "NOTE" above `GUARDIAN_SK_NAME`/child-sk removal)
   *  and identity/pinLock.ts's header for the full security fix this is
   *  half of. Exposed for the same reason as `guardianSk` above. */
  childSk: Uint8Array | null
  /** The UI lock, independent of key presence (v0.2 spec §2.6). True with a
   *  non-null `childSk` is the case that did not exist before: a
   *  backgrounded shell session, screen behind the PIN, still syncing.
   *  `ChildShell`/`ChildLock` gate on `childSk === null || locked`; the
   *  child sync engine gates on `childSk !== null` alone. */
  locked: boolean
  /** Ends a child device's lock screen by setting `childSk` AND clearing
   *  `locked` — see `AppProvider`'s own definition and identity/pinLock.ts's
   *  header. ChildOnboarding calls it right after `pinLock.ts#setPin`
   *  (pairing just completed); ChildLock calls it right after
   *  `pinLock.ts#unlockWithPin` returns non-null. */
  unlockChildSk: (sk: Uint8Array) => void
  /** Locks the screen and KEEPS the key. Wired to `lockPolicy.ts#wireLock`
   *  in `AppProvider`; also what an explicit "Lock" action would call. */
  lockUi: () => void
  /** Throws the key away, which also locks. Wired to
   *  `lockPolicy.ts#wireKeyWipe`. This is the old `lockChildSk`, renamed for
   *  what it actually costs. */
  wipeChildSk: () => void
  /** PairDevice (Task 3) registers a handler here, while mounted, for a
   *  successfully-answered pair.claim belonging to the ceremony IT opened —
   *  see the guardian-engine effect below, which calls this unconditionally
   *  alongside its own `endPairing` dispatch. This generic provider has no
   *  child-specific context of its own (which device to send the resulting
   *  PAIR_OFFER to is answered's business, not this module's; naming the
   *  paired device in a success banner is a screen concern), so it defers
   *  entirely to whatever the currently-mounted pairing screen supplies —
   *  `null` when no such screen is mounted, in which case a claim still
   *  gets identity-bound but nobody sends its offer or shows a banner (an
   *  acceptable gap: nothing can be pairing without a screen open to have
   *  started the ceremony in the first place). A plain mutable ref rather
   *  than state: setting it must not itself cause a re-render, and only one
   *  ceremony is ever open at a time (mirrors `PairingSessionState` being a
   *  single slot, not a list). */
  onPairClaimAnsweredRef: React.MutableRefObject<((answered: AnsweredPairClaim) => void) | null>
}

const MAX_LOGGED_EFFECTS = 50

/** What this build calls itself on a `status` heartbeat (v0.2 spec §2.1) —
 *  purely diagnostic: a peer reporting a version we do not recognise is not
 *  refused anything, it just tells a support conversation which build is on
 *  the other phone. A literal rather than a `import.meta.env` read so that
 *  `statusFor` stays a pure helper with the version passed IN (see its own
 *  doc comment), and so the release-plumbing task owns version numbers in
 *  exactly one other place without this file racing it. */
const APP_VERSION = '0.2.0'

const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (ctx === null) throw new Error('useApp must be used within an AppProvider')
  return ctx
}

export function AppProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(storeReducer, undefined, () => initialStoreState(loadState()))
  const [effects, setEffects] = useState<Effect[]>([])
  const [guardianSk, setGuardianSk] = useState<Uint8Array | null>(null)
  const [childSession, dispatchChildSession] = useReducer(childSessionReducer, initialChildSession)
  const { sk: childSk, locked } = childSession

  // Live refs so the engine/scheduler effects below (deliberately NOT
  // re-run on every entry/config change — only on role/peer-set/key
  // changes) always read the CURRENT state rather than whatever was
  // captured in their closure at effect-setup time.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const pairingRef = useRef(state.pairing)
  useEffect(() => {
    pairingRef.current = state.pairing
  }, [state.pairing])

  // See AppContextValue's doc comment — set by whichever pairing screen is
  // currently mounted, read by the guardian-engine effect's
  // `onPairClaimAnswered` handler below.
  const onPairClaimAnsweredRef = useRef<((answered: AnsweredPairClaim) => void) | null>(null)

  // Task E4 (v0.2 spec §3.1/§3.2) — the store's own onEffect glue for both
  // engines (and `onPairClaimAnswered` below, for the `pairAnswered`
  // pseudo-effect) funnels through this one function rather than each
  // inlining the same three-line dance. `stateRef.current.app` (not a
  // closed-over `state.app`) is deliberate for the same reason every other
  // callback in this provider reads through the ref: engine callbacks are
  // set up once per effect run and must always see the CURRENT roster, not
  // whatever `state.app` looked like when the effect was set up. All of the
  // actual decision-making — whether this event/role combination has copy
  // at all, the visibility firing rule, and (fix round 1) the `notify: false`
  // replay override — lives in the pure, unit-tested `notificationToFire`;
  // this wrapper only supplies the two impure bits that function is
  // deliberately kept ignorant of: `document.visibilityState` and the
  // DOM-touching `notify` call. `opts` is forwarded verbatim — see
  // `onGuardianEffect`/`onChildEffect` below, which pass `{ notify: false }`
  // on for anything reaching them via `handleResilienceEffect`'s `reemit`
  // (a resync replay), so state/acks still fold in but nothing re-notifies
  // for an event that is, by definition, already old.
  const fireNotification = useCallback(
    (role: 'guardian' | 'child', e: NotifiableEvent, opts?: NotificationToFireOpts): void => {
      const visibilityState = typeof document !== 'undefined' ? document.visibilityState : undefined
      const content = notificationToFire(e, notificationContextFor(role, stateRef.current.app), visibilityState, opts)
      if (content !== null) notify(content)
    },
    [],
  )

  // Populated synchronously by the scheduler's `update` closure below
  // whenever a tick actually finds something newly due, drained by the
  // effect right after it (see that effect's comment for why sends live in
  // a SEPARATE effect rather than inside the updater itself). Id-keyed Map,
  // NOT a plain array/plain assignment — see that effect's own comment for
  // why a bare `duePayoutsRef.current = entries` loses payouts under a
  // batched double-dispatch (two `runOnce()` calls — e.g. the 15-minute
  // interval and a `focus` event landing close enough together to land in
  // the same React batch, or StrictMode's dev-only double-invoke) whose
  // updaters both run through the reducer before this ref is drained.
  const duePayoutsRef = useRef<Map<string, Entry>>(new Map())

  // Persist after every reducer step. `state.pairing` is deliberately never
  // written here (see PairingSessionState's doc comment) — only `app`.
  // `saveState` never throws (audit D7); a failed write only raises the
  // non-fatal `storageError` flag, which clears on the next good save.
  const [storageError, setStorageError] = useState(false)
  useEffect(() => {
    setStorageError(!saveState(state.app))
  }, [state.app])

  // Load the guardian's own signing key once role is 'guardian' — needed by
  // both the engine effect and the scheduler effect below.
  useEffect(() => {
    if (state.app.role !== 'guardian') return
    let cancelled = false
    void vaultLoad(GUARDIAN_SK_NAME).then((sk) => {
      if (!cancelled && sk !== null) setGuardianSk(sk)
    })
    return () => {
      cancelled = true
    }
  }, [state.app.role])

  // NOTE: there is no load effect here mirroring the guardian-sk one above.
  // `childSk` starts `null` on every mount and ONLY ever becomes non-null via
  // `unlockChildSk` below (ChildLock, after a correct PIN; ChildOnboarding,
  // right after `pinLock.ts#setPin`) — see this module's header for why that
  // is the fix, not an oversight: nothing durable to load exists any more.

  /** ChildLock/ChildOnboarding's one entry point for ending a lock screen —
   *  sets `childSk` directly, in memory only. See this module's header: this
   *  is now the ENTIRE definition of "unlocked" for a child device: no vault
   *  write, no sessionStorage flag, nothing that outlives this piece of
   *  React state. */
  const unlockChildSk = useCallback((sk: Uint8Array): void => {
    dispatchChildSession({ type: 'unlock', sk })
  }, [])

  /** Screen only — the key stays, so a backgrounded child device carries on
   *  syncing behind its lock screen (v0.2 spec §2.6). */
  const lockUi = useCallback((): void => {
    dispatchChildSession({ type: 'lockUi' })
  }, [])

  /** The expensive half: clears the in-memory sk, stopping the child engine
   *  and landing the child branch back on ChildLock with a PIN to re-enter.
   *  Wired to `wireKeyWipe` below. */
  const wipeChildSk = useCallback((): void => {
    dispatchChildSession({ type: 'wipe' })
  }, [])

  // Passive lock: a child device that gets backgrounded, has its tab
  // evicted, or is simply closed should not leave the sk sitting in memory
  // indefinitely waiting for a GC that browsers don't guarantee promptly.
  // `platform/lockPolicy.ts#wireLock` owns the actual policy — plain-browser
  // behaviour is unchanged (`pagehide`, locks immediately), but a Kinjar
  // Android WebView session (Task 1 of the android-apk plan) instead gets a
  // 60s `visibilitychange` grace period, so switching briefly to the camera
  // app to scan a QR (or answering a call) doesn't force a fresh PIN entry —
  // see that module's own header for the full reasoning and the shell
  // detection (`platform/shell.ts#isShell`) it's gated on. Only attached
  // while a child session is actually live (`childSk !== null`) — nothing to
  // clear, nothing to listen for, before or after that.
  //
  // v0.2 spec §2.6 splits this in two: `wireLock` now locks the SCREEN
  // (unchanged policy — immediate on browser `pagehide`, 60 s grace plus the
  // native stop event in the shell), while `wireKeyWipe` owns the key and
  // holds onto it for `SHELL_KEY_RETAIN_MS` of shell backgrounding so sync
  // and notifications survive an app switch. A browser tab still loses both
  // at once on `pagehide`, exactly as before.
  useEffect(() => {
    if (state.app.role !== 'child' || childSk === null) return
    const unwireLock = wireLock(lockUi)
    const unwireWipe = wireKeyWipe(wipeChildSk)
    return () => {
      unwireLock()
      unwireWipe()
    }
  }, [state.app.role, childSk, lockUi, wipeChildSk])

  // activeChildren, not `children` (v0.2 spec §4.5): a revoked child stays in
  // the roster — its history is still the family's — but stops being a peer.
  // Dropping it here is the whole revocation mechanism on the guardian side:
  // the engine's peer set is what `sync/multi.ts` membership-checks inbound
  // wraps against, so a revoked device's traffic is discarded before it can
  // touch state, with no new code path anywhere.
  const peerPksKey = activeChildren(state.app)
    .map((c) => c.pubkey)
    .join(',')
  const relaysKey = state.app.relays.join(',')

  // ONE relay pool shared by the engine and scheduler effects below (rather
  // than each opening its own `SimplePool` against the same relay URLs) —
  // recreated only when the relay list itself changes.
  const relay = useMemo<RelayLike>(() => makePool(state.app.relays), [relaysKey])

  // How many pages of a resync exchange each peer has served us, keyed by
  // peer pubkey and reset whenever WE start a fresh exchange. This is the
  // bound on a hostile (or merely broken) peer turning "I am behind you"
  // into an endless conversation — see `nextResyncCursor`, which owns the
  // decision; this ref only owns the counting. A plain ref, not state:
  // nothing renders off it.
  const resyncPagesRef = useRef<Map<string, number>>(new Map())

  // When this CHILD device last asked its guardian to catch it up (unix
  // SECONDS) — the requester's half of the catch-up rate limit (`catchUpDue`).
  const lastCatchUpRef = useRef<number | undefined>(undefined)

  // Inbound rate limiting (review fix, round 1). Answering a heartbeat costs
  // a whole-state snapshot wrap or a fresh exchange, and a fresh exchange
  // resets `resyncPagesRef` — so without a gap on the INBOUND side the
  // 10-page cap bounded one exchange while the exchange rate was the peer's
  // to choose. `statusSeenRef` is the last accepted `status` per peer;
  // `servedExchangesRef` is the serving side's own per-peer page budget.
  // Both are plain refs: nothing renders off either.
  const statusSeenRef = useRef<Map<string, number>>(new Map())
  const catchUpSeenRef = useRef<Map<string, number>>(new Map())
  const servedExchangesRef = useRef<Map<string, ResyncExchange>>(new Map())

  /**
   * The receiving half of resilience (v0.2 spec §2.2), shared verbatim by
   * both engines because both sides genuinely do all three things: compare a
   * heartbeat, serve a replay, ingest one.
   *
   *  - `status` — compare the peer's claim against OUR view of the same
   *    ledger (on the guardian, of that child's entries only) and act:
   *    they are behind, send a snapshot; we are behind, ask for a replay.
   *  - `resyncRequest` — answer with one page of the corpus. Always page 0
   *    RELATIVE TO the cursor we were given: the requester advances the
   *    cursor itself, so this side keeps no per-peer paging state at all.
   *  - `resyncReply` — verify and fold via `ingestResyncEvents` (nothing in
   *    the page is trusted before that), then ask for the next page while
   *    one remains and the cap allows.
   *
   * `reemit` is the calling engine's own `onEffect`, so everything the
   * ingest produced (an entry, a config, a grant) takes exactly the same
   * path a live wire delivery of it would — EXCEPT notification firing
   * (fix round 1, IMPORTANT 1): every produced effect is reemitted with
   * `{ notify: false }`, since a resync reply is by definition a REPLAY of
   * something that already happened (a device catching up after being
   * offline), and re-notifying for each one would fire a burst of stale
   * notifications for asks/grants/entries the user may have already seen
   * and acted on elsewhere. State/acks still fold in exactly as before —
   * only the DOM-facing `notify()` call is suppressed, inside
   * `notificationToFire` itself (see that function's own doc comment). It
   * cannot recurse: ingest only ever ingests ENTRY/CONFIG/GRANT/CHILD_SIG,
   * none of which produce any of the three effects handled here.
   */
  const handleResilienceEffect = useCallback(
    (
      effect: Effect,
      selfSk: Uint8Array,
      scope: ResilienceScope,
      reemit: (e: Effect, opts?: NotificationToFireOpts) => void,
    ): void => {
      if (effect.type !== 'status' && effect.type !== 'resyncRequest' && effect.type !== 'resyncReply') return
      // Sampled once per effect, outside every closure below — the same
      // discipline every other action in this file follows.
      const nowSec = Math.floor(Date.now() / 1000)
      const peerPk = effect.authorPk
      const storage: StorageLike = window.localStorage
      const wire = { selfSk, peerPk, relay, storage, nowSec }
      const app = stateRef.current.app

      // Both ends count the SAME set or they never agree: a guardian scopes
      // its view to the child that called in, a child to its own pubkey (it
      // may still hold sibling entries from an old family snapshot, and
      // counting those would keep it permanently "ahead").
      const scopePk = scope.kind === 'guardian' ? peerPk : scope.selfPk

      if (effect.type === 'status') {
        // A child's catch-up (v0.3) asks for a snapshot outright. It is gated
        // by the same gap as an ordinary heartbeat, in its own bucket, so an
        // hourly beat landing just before cannot swallow it.
        const catchUp = scope.kind === 'guardian' && effect.payload.catchUp === true
        const seen = catchUp ? catchUpSeenRef.current : statusSeenRef.current
        if (!statusAccepted(seen, peerPk, nowSec)) return
        seen.set(peerPk, nowSec)
        const local = statusFor(app, scopePk, APP_VERSION, nowSec)
        const verdict = compareStatus(local, effect.payload)
        if (verdict.kind === 'send-snapshot' || catchUp) {
          void sendSnapshot(snapshotOf(app, peerPk), wire).catch(() => {})
        }
        if (verdict.kind === 'request-resync') {
          // `null`, never `local.lastEntryId`: the corpus and the ledger sort
          // by different keys, so a ledger-derived cursor can sit after an
          // event we never received and hide it for ever. See `resyncPage`.
          resyncPagesRef.current.set(peerPk, 0)
          void sendResyncRequest(buildResyncRequestPayload(null), wire).catch(() => {})
        }
        return
      }

      if (effect.type === 'resyncRequest') {
        // The gap gates only the START of an exchange; continuation pages are
        // bounded by the serving side's own count instead, because gating
        // every request would break paging outright. See `servesResyncPage`.
        const gate = servesResyncPage(servedExchangesRef.current.get(peerPk), effect.since, nowSec)
        if (gate.exchange !== undefined) servedExchangesRef.current.set(peerPk, gate.exchange)
        if (!gate.serve) return
        // Scoped on the guardian, unscoped on a child: a guardian must not
        // hand one child a sibling's ledger, while a child replying to its
        // own guardian has nothing to withhold (and a RECOVERING guardian
        // wants everything the child kept).
        const serveTo = scope.kind === 'guardian' ? peerPk : null
        void sendResyncReply(resyncPage(app, effect.since, 0, serveTo), wire).catch(() => {})
        return
      }

      // A replay page. The fold re-runs FRESH inside the dispatched updater
      // (the same reason sync/multi.ts's header gives for functional
      // updaters: a second page can land before the first has been
      // reflected back through `stateRef`), and `ingestResyncEvents` is pure
      // and dedupes by event id, so running it twice is safe by
      // construction. The copy computed here is only read for its effects.
      const { events } = effect.payload
      const ingested = ingestResyncEvents(app, events, { peerPk, nowSec })
      // `!==` rather than `accepted > 0`: a verified event this build cannot
      // read still belongs in the corpus (spec §2.3), and that IS a state
      // change worth persisting.
      if (ingested.state !== app) {
        dispatch({ type: 'updateApp', update: (a) => ingestResyncEvents(a, events, { peerPk, nowSec }).state })
      }
      // Acks are SENT, not re-emitted: the live engines intercept the `ack`
      // effect themselves and never hand it to `onEffect`, so a replayed
      // entry would otherwise show as never-delivered in the sender's own
      // feed for ever (review fix, round 1). Everything else takes the same
      // path a live delivery would.
      for (const entryId of acksFor(ingested.effects, peerPk)) {
        void sendAck(entryId, wire).catch(() => {})
      }
      for (const produced of ingested.effects) if (produced.type !== 'ack') reemit(produced, { notify: false })

      const pagesReceived = (resyncPagesRef.current.get(peerPk) ?? 0) + 1
      resyncPagesRef.current.set(peerPk, pagesReceived)
      const cursor = nextResyncCursor(effect.payload, pagesReceived)
      if (cursor !== null) void sendResyncRequest(buildResyncRequestPayload(cursor), wire).catch(() => {})
    },
    [relay],
  )

  // Ruling R1: the vault carries the family ROSTER, so a vault published
  // before a child was added (or revoked, or renamed, or a relay changed) is
  // already out of date. Re-publish whenever that signature changes.
  //
  // Three things here are load-bearing, and all three were wrong first time:
  //
  //  - The effect depends on the SIGNATURE STRING, not on `state.app`. With
  //    `state.app` as a dependency every unrelated state change (an entry, an
  //    ack) re-ran the effect, and its cleanup cancelled a publish that was
  //    still in flight.
  //  - `publishedVaultSigRef` is stamped only AFTER a send that actually left
  //    the outbox. Stamping it up front meant a publish interrupted midway
  //    marked that roster as backed up forever, and the change was never
  //    re-published.
  //  - `cancelled` guards only the DISPATCH, never the publish. An in-flight
  //    publish is allowed to finish: the vault is worth more than the
  //    tidiness of not writing after a re-render, and the `backedUpAt` stamp
  //    it would otherwise lose is only cosmetic by comparison.
  //
  // The first run SEEDS and publishes nothing: a launch is not a change, and
  // re-sealing the mnemonic to the relays on every cold start would be a lot
  // of secret-bearing traffic for no new information. "Back up now" in
  // Settings is the manual fallback if a change was ever missed.
  const publishedVaultSigRef = useRef<string | null>(null)
  const inFlightVaultSigRef = useRef<string | null>(null)
  const vaultSeededRef = useRef(false)

  const signetRootPk = state.app.root !== null && state.app.root.kind === 'signet' ? state.app.root.pubkey : ''
  // `vaultRosterOf`, never `state.app` straight over: `revoked` lives on the
  // ACCOUNTS DOC, not at the top of AppState, so a structural pass of the
  // whole state would silently omit it and a revoke would neither re-publish
  // the vault (ruling R1) nor drop the child from the vault it publishes.
  const vaultSignature = signetRootPk === '' ? '' : vaultRosterSignature(vaultRosterOf(state.app))

  useEffect(() => {
    if (state.app.role !== 'guardian' || signetRootPk === '' || guardianSk === null) return
    if (!vaultSeededRef.current) {
      vaultSeededRef.current = true
      publishedVaultSigRef.current = vaultSignature
      return
    }
    if (!shouldPublishVault(vaultSignature, publishedVaultSigRef.current, inFlightVaultSigRef.current)) return

    let cancelled = false
    inFlightVaultSigRef.current = vaultSignature
    const nowSec = Math.floor(Date.now() / 1000)
    void (async () => {
      try {
        const mnemonic = await loadFamilyMnemonic()
        if (mnemonic === null) return
        // Read the roster fresh: this publish may have been queued behind an
        // earlier one, and what matters is the family as it stands now. The
        // ROOT is read from the same fresh state for the same reason — the
        // vault carries its kind-21236 attestation (item C1), and a root
        // reconnected while this publish was queued must be the one sealed.
        const root = stateRef.current.app.root
        if (root === null || root.kind !== 'signet') return
        const { sent } = await sendVault(
          vaultPayloadFor(vaultRosterOf(stateRef.current.app), mnemonic, guardianFromMnemonic(mnemonic).pk, root.authEvent, nowSec),
          { selfSk: guardianSk, peerPk: root.pubkey, relay, storage: window.localStorage, nowSec },
        )
        if (!sent) return
        publishedVaultSigRef.current = vaultSignature
        if (cancelled) return
        dispatch({
          type: 'updateApp',
          update: (app) =>
            app.root !== null && app.root.kind === 'signet' ? { ...app, root: { ...app.root, backedUpAt: nowSec } } : app,
        })
      } catch {
        // A failed publish stamps nothing, so the next roster change (or
        // "Back up now") tries again.
      } finally {
        if (inFlightVaultSigRef.current === vaultSignature) inFlightVaultSigRef.current = null
      }
    })()
    return () => {
      cancelled = true
    }
    // `relay` and the app state are read through stable references inside:
    // a change to either that MATTERS to this effect already moves
    // `vaultSignature` (the relay list is part of the signature).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultSignature, signetRootPk, state.app.role, guardianSk])

  // Task E4 (v0.2 spec §3.2/§3.3) — the Android foreground relay-keepalive
  // service. ONE effect, keyed on role alone (`shouldRunRelayService`), and
  // deliberately not folded into the engine effects below: those restart on
  // a roster or relay-list change, and restarting the service with them made
  // an ordinary settings edit flicker the ongoing notification and drop the
  // wake lock. A no-op outside the Android shell either way — see shell.ts's
  // own header.
  //
  // Declared BEFORE both engines so React runs its cleanup first: the
  // service is told to stop before the sync it exists to keep alive is torn
  // down, never the other way round.
  useEffect(() => {
    if (!shouldRunRelayService(state.app.role)) return
    startRelayService()
    return () => {
      stopRelayService()
    }
  }, [state.app.role])

  // Multi-peer engine: restart whenever the guardian's peer set changes.
  // Guardian-only for Task 2 — child-side single-peer sync (engine.ts) is
  // wired up in Plan 4 (child-mode).
  useEffect(() => {
    if (state.app.role !== 'guardian' || guardianSk === null) return
    const storage: StorageLike = window.localStorage

    const tokenStore: PairTokenStore = {
      get: () => pairingRef.current?.token ?? null,
      clear: () => dispatch({ type: 'burnPairing' }),
    }

    const stop = startGuardianSync({
      selfSk: guardianSk,
      peerPks: peerPksKey === '' ? [] : peerPksKey.split(','),
      relay,
      storage,
      getState: () => stateRef.current.app,
      setState: (update) => dispatch({ type: 'updateApp', update }),
      onEffect: function onGuardianEffect(effect, notifyOpts?: NotificationToFireOpts) {
        setEffects((prev) => [...prev, effect].slice(-MAX_LOGGED_EFFECTS))
        // Heartbeat/replay traffic (v0.2 spec §2.2) — `forChildScoped` is
        // true here: a guardian compares a child's status against ITS OWN
        // view of THAT child's ledger, never the whole family's.
        handleResilienceEffect(effect, guardianSk, { kind: 'guardian' }, onGuardianEffect)
        // Task 5: persist a spend.request/allowance.claim into
        // AppState.requests so the Approvals inbox has something durable to
        // render (previously only the bounded, in-memory `effects` log
        // above knew about it — Home.tsx's `pendingRequestCount` now reads
        // this registry directly instead, per Task 7). pair.claim is never
        // a decidable request (see ingress.ts's module header) and is
        // excluded here, same as Home.tsx's own stopgap filter.
        if (effect.type === 'request' && effect.payload.op !== 'pair.claim') {
          // nowSec sampled ONCE here, outside the dispatched closure — the
          // same discipline the scheduler effect's runOnce() and every
          // action builder in this file follow (Global Constraints: "no
          // Date.now() in pure logic... obtained once per action"). Reading
          // it INSIDE the updater instead would let React 18 StrictMode's
          // dev-only double-invocation of updaters stamp two different
          // createdAt values across the two calls for what should be one
          // event.
          const nowSec = Math.floor(Date.now() / 1000)
          dispatch({ type: 'updateApp', update: (app) => upsertRequest(app, effect.payload, effect.authorPk, nowSec) })
        }
        // Task E4 (v0.2 spec §3.1) — local/foreground notification, fired
        // only while this device is backgrounded (the visibility check
        // lives in `notificationToFire`/`fireNotification` above).
        // `notifyOpts` carries `{ notify: false }` when this call came from
        // `handleResilienceEffect`'s `reemit` (fix round 1) — a resync
        // replay, not a live delivery — and is passed straight through.
        fireNotification('guardian', effect, notifyOpts)
      },
      getPairingSession: (): MultiPairingSession | null => {
        const session = pairingRef.current
        if (session === null || session.status === 'burned') return null
        const pairingApp = stateRef.current.app
        // Scoped to the child being paired (audit P6). A roster entry that has
        // vanished mid-ceremony gets an empty scope rather than the family's.
        const pairingPk = pairingChildPk(pairingApp, session.childIndex) ?? ''
        return {
          tokenStore,
          mnemonic: session.mnemonic,
          childIndex: session.childIndex,
          childName: session.childName,
          snapshot: snapshotOf(pairingApp, pairingPk),
          relays: session.relays,
          // The offer carries the root too (spec §1.5): a device pairing for
          // the first time has no snapshot history to learn it from later.
          root: rootAttestationOf(stateRef.current.app),
        }
      },
      onPairClaimAnswered: (answered) => {
        // The identity-binding half of pairing is complete (token consumed,
        // devicePk matched). Whatever pairing screen is currently mounted
        // (Task 3's PairDevice) gets first refusal via the ref — sending the
        // resulting PAIR_OFFER and naming the paired device in a success
        // banner is its job, not this generic provider's (see
        // AppContextValue's doc comment) — then the ceremony closes either
        // way.
        onPairClaimAnsweredRef.current?.(answered)
        // Task E4's one pseudo-effect (spec §3.1): pairing has no ingress
        // Effect of its own, so it is synthesised here, right where the
        // answer actually happens — `pairingRef.current` still names the
        // ceremony that was just answered (the `endPairing` dispatch just
        // below clears it, but only takes effect on the NEXT render; this
        // read happens first, synchronously, in the same tick).
        const childName = pairingRef.current?.childName
        if (childName !== undefined) fireNotification('guardian', { type: 'pairAnswered', childName })
        dispatch({ type: 'endPairing' })
      },
      nowSec: () => Math.floor(Date.now() / 1000),
    })

    // Periodic outbox drain (v0.2 spec §2.5) — armed alongside every live
    // engine, torn down with it, so a queue only ever drains while there is
    // something able to send. See `armPeriodicFlush`.
    const disarmFlush = armPeriodicFlush(() => {
      void flush(relay, Math.floor(Date.now() / 1000), storage).catch(() => {})
    })

    return () => {
      disarmFlush()
      stop()
    }
    // guardianSk is a Uint8Array (referentially stable once loaded, since
    // it's only ever set once per session — see the load effect above), so
    // comparing it by reference here is fine; peerPksKey is the actual
    // "did the peer SET change" signal, deliberately a string join rather
    // than the array itself (a fresh array each render would otherwise
    // restart the engine every render for no reason).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.app.role, peerPksKey, guardianSk, relay])

  // Single-peer child engine (sync/engine.ts) — Task 1 of Plan 4
  // (child-mode). Mirrors the guardian effect above in every respect it can:
  // functional `setState` updater dispatched via the SAME `updateApp`
  // action, `stateRef` for a live `getState`, the shared `relay`/`storage`.
  // Restarts whenever the pinned guardian identity or the child's own key
  // changes (both are fixed for the life of a pairing in practice, but
  // guarded the same way `peerPksKey`/`guardianSk` gate the guardian effect,
  // rather than assumed never to change).
  useEffect(() => {
    if (state.app.role !== 'child' || childSk === null || state.app.guardianPubkey === null) return
    const storage: StorageLike = window.localStorage
    const guardianPubkey = state.app.guardianPubkey
    const selfPk = getPublicKey(childSk)
    // Re-bound after the null guard above so the hoisted `beat()` below sees
    // the narrowed type (TypeScript widens a narrowed outer binding inside a
    // function DECLARATION, which a hoisted one could in principle outlive).
    const sessionSk = childSk
    // Pending "did the ENTRY follow its GRANT?" checks, cleared with the engine.
    const grantTimers = new Set<number>()

    const stop = startSync({
      selfSk: childSk,
      pinnedPeerPk: guardianPubkey,
      relay,
      storage,
      getState: () => stateRef.current.app,
      setState: (update) => dispatch({ type: 'updateApp', update }),
      onEffect: function onChildEffect(effect, notifyOpts?: NotificationToFireOpts) {
        setEffects((prev) => [...prev, effect].slice(-MAX_LOGGED_EFFECTS))
        // Heartbeat/replay traffic (v0.2 spec §2.2) — a child's own view is
        // all of its entries, so nothing is scoped by peer here.
        handleResilienceEffect(effect, childSk, { kind: 'child', selfPk }, onChildEffect)
        // Task 1's other half: a GRANT answering this child's own
        // spend.request/allowance.claim (or a scheduler-gated allowance
        // claim this child never itself sent — see
        // `state.ts#recordGrantResult`'s own doc comment for why an unknown
        // reqId is synthesised rather than dropped) is folded into
        // `state.requests` the same way the guardian's onEffect above folds
        // a 'request' effect into it — Task 4's Ask screen renders the
        // result, this task just makes sure nothing is silently lost before
        // that screen exists.
        if (effect.type === 'grant') {
          const nowSec = Math.floor(Date.now() / 1000) // sampled once — see the guardian effect's own comment on this
          dispatch({ type: 'updateApp', update: (app) => recordGrantResult(app, effect.payload, selfPk, nowSec) })
          // A granted spend whose ENTRY has not followed within the grace
          // period was lost on the way: ask to catch up (v0.3).
          const grant = effect.payload
          if (grantAwaitsEntry(stateRef.current.app, grant)) {
            const timer = window.setTimeout(() => {
              grantTimers.delete(timer)
              if (grantAwaitsEntry(stateRef.current.app, grant)) catchUp()
            }, GRANT_ENTRY_GRACE_MS)
            grantTimers.add(timer)
          }
        }
        // A live ENTRY this device could not place (v0.3): its accounts
        // CONFIG never arrived, so ask to catch up now.
        if (effect.type === 'gap') catchUp()
        // The guardian has removed this device (v0.2 spec §4.5). The key
        // goes from memory FIRST, then everything this device holds on disk
        // that could unlock it again: from here on there is nothing left to
        // sign with, so nothing this device could still send.
        //
        // No routing call: which screen shows is derived from state (see
        // App.tsx's own header), and the revocation is already IN state —
        // ingress applied the accounts doc before emitting this effect — so
        // the very next render lands on Unpaired and stays there across
        // reloads, which a one-shot navigation would not.
        if (effect.type === 'revoked') {
          wipeChildSk()
          void clearPin().catch(() => {})
        }
        // Task E4 (v0.2 spec §3.1) — see the guardian effect's own comment
        // on `fireNotification` above; identical wiring, child role.
        // `notifyOpts` (fix round 1) is forwarded straight through, same as
        // the guardian effect.
        fireNotification('child', effect, notifyOpts)
      },
      nowSec: () => Math.floor(Date.now() / 1000),
    })

    // The heartbeat (v0.2 spec §2.2). A child tells its guardian where it
    // thinks it is: on start, so a device coming back from a long spell
    // offline reconciles at once rather than in up to an hour, and then
    // hourly. The status itself is read FRESH from `stateRef` on every beat
    // — the interval outlives any one snapshot of the ledger.
    //
    // Failures are swallowed on purpose: `sendStatus` already enqueues to
    // the durable outbox, so an offline beat is queued, not lost, and the
    // periodic flush will carry it out when the network returns.
    function beat(): void {
      const beatSec = Math.floor(Date.now() / 1000)
      // Scoped to this child's OWN pubkey, not `null`: a device that took a
      // family-wide snapshot at pairing may hold sibling entries, and
      // counting those would leave it permanently "ahead" of a guardian
      // whose view is scoped per child — a resync every hour, for ever
      // (review fix, round 1).
      void sendStatus(statusFor(stateRef.current.app, selfPk, APP_VERSION, beatSec), {
        selfSk: sessionSk,
        peerPk: guardianPubkey,
        relay,
        storage,
        nowSec: beatSec,
      }).catch(() => {})
    }
    beat()
    const heartbeat = window.setInterval(beat, STATUS_INTERVAL_MS)

    // Child-initiated catch-up (v0.3): the heartbeat with `catchUp: true`,
    // which the guardian answers with a scoped snapshot whatever the counts
    // say. Rate-limited here as the guardian would (`catchUpDue`), and read
    // fresh from `stateRef` like every beat.
    function catchUp(): void {
      const nowSec = Math.floor(Date.now() / 1000)
      if (!catchUpDue(lastCatchUpRef.current, nowSec)) return
      lastCatchUpRef.current = nowSec
      void sendStatus(
        { ...statusFor(stateRef.current.app, selfPk, APP_VERSION, nowSec), catchUp: true },
        { selfSk: sessionSk, peerPk: guardianPubkey, relay, storage, nowSec },
      ).catch(() => {})
    }

    // Periodic outbox drain — see the guardian engine's own comment above.
    const disarmFlush = armPeriodicFlush(() => {
      void flush(relay, Math.floor(Date.now() / 1000), storage).catch(() => {})
    })

    return () => {
      disarmFlush()
      window.clearInterval(heartbeat)
      for (const timer of grantTimers) window.clearTimeout(timer)
      grantTimers.clear()
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.app.role, state.app.guardianPubkey, childSk, relay, wipeChildSk])

  // Tear down the OLD pool's connections whenever `relay` above is replaced
  // (relay list changed) or the provider unmounts — `useMemo` alone has no
  // cleanup hook, so without this a relay-settings change (Task 6) would
  // leak the previous `SimplePool`'s live sockets indefinitely.
  //
  // Declared AFTER (below) the guardian-engine and child-engine effects
  // above, deliberately — not just visual grouping. Every one of those
  // effects shares `relay` in its dep array, so a relay-list change tears
  // down and re-runs all of them; React cleans up same-component effects in
  // DECLARATION order, so each engine's own cleanup (`stop()`, which
  // unsubscribes from the pool) must run BEFORE
  // this one closes the pool out from under it — declaring this effect
  // second guarantees that ordering. Declaring it first (the original,
  // carried-forward order) risked the reverse: the pool closing while the
  // engine's `stop()` cleanup was still trying to unsubscribe through it.
  useEffect(() => {
    return () => relay.close?.()
  }, [relay])

  // Scheduler: on mount (once role+key are ready), every 15 minutes, and on
  // window focus (catch-up after the device was asleep/backgrounded).
  //
  // `runSchedulers` runs FRESH inside the dispatched `update` closure —
  // against whatever app the reducer actually hands it, never a `stateRef`
  // snapshot taken when the tick started — for the same reason
  // `sync/multi.ts`'s engine wiring above does: a tick that overlaps with an
  // inbound ledger entry (or another tick) must see that entry's effect on
  // "what's still due" rather than silently overwriting/duplicating it. The
  // entries that update closure actually folds in are stashed into
  // `duePayoutsRef` as a side effect of computing them — ACCUMULATED into an
  // id-keyed Map (`.set(e.id, e)`), never a bare `duePayoutsRef.current =
  // entries` assignment. Found by review: a batched double-dispatch of
  // `runOnce()` (the 15-minute interval firing at nearly the same moment as
  // a `focus` event, or StrictMode's dev-only double-invoke) sends BOTH
  // updaters through the reducer, in order, before either commit is drained
  // — the first updater's `runSchedulers` call finds genuinely due entries
  // and folds them into `app`; the second, running against THAT already-paid
  // `app` (periodKey-keyed idempotence, same as scheduler.ts's own module
  // header describes), correctly finds nothing due. A plain assignment would
  // have the second call's empty `[]` clobber the first's just-stashed
  // entries — they'd still be applied locally (already folded into `app` by
  // the first updater) but the drain effect below would find nothing to
  // send, so nothing ever reaches the child over the wire. Accumulating by
  // id instead means the second (empty) call is a genuine no-op against the
  // Map, and entry ids are already deterministic (schedulerEntryId), so a
  // GENUINE double-invoke of the SAME tick with the SAME due entries just
  // `.set()`s the same id twice — still safe, still side-effect-free (an
  // ACTUAL network call from inside the updater would double-fire under that
  // same double-invoke, which is why sends stay in the separate effect
  // below). That effect drains the Map once the commit reflecting this
  // update has landed, and only then fires the sends.
  useEffect(() => {
    if (state.app.role !== 'guardian' || guardianSk === null) return

    function runOnce(): void {
      const nowSec = Math.floor(Date.now() / 1000)
      dispatch({
        type: 'updateApp',
        update: (app) => {
          const { entries, claims } = runSchedulers(app, nowSec)
          for (const entry of entries) duePayoutsRef.current.set(entry.id, entry)
          let next = entries.reduce((acc, entry) => addEntry(acc, entry), app)
          // Gated allowance periods (choresGate/auditGate) surface as
          // locally-synthesised allowance.claim requests rather than
          // auto-paid entries (scheduler.ts's own module header) — fold
          // them into the SAME requests registry a live wire REQUEST would
          // land in, so the Approvals inbox shows "pocket money ready"
          // rather than the gate silently doing nothing visible. authorPk
          // is the claim's own `child` field: these never cross the wire,
          // so there is no separate wire-authenticated sender to check it
          // against — see upsertRequest's provenance guard, which this
          // trivially satisfies by construction.
          for (const claim of claims) next = upsertRequest(next, claim, claim.child, nowSec)
          return next
        },
      })
    }

    runOnce()
    const interval = window.setInterval(runOnce, SCHEDULER_INTERVAL_MS)
    window.addEventListener('focus', runOnce)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', runOnce)
    }
  }, [state.app.role, guardianSk])

  // Drains whatever the scheduler's updater (above) most recently
  // accumulated — runs after EVERY commit (any `state.app` change, not only
  // scheduler ones), but no-ops immediately unless that specific commit was
  // the scheduler's, since `duePayoutsRef` is empty otherwise. This is what
  // actually SENDS the entries the reducer just folded in — kept out of the
  // updater itself for the StrictMode-purity reason described above.
  useEffect(() => {
    if (duePayoutsRef.current.size === 0 || guardianSk === null) return
    const entries = [...duePayoutsRef.current.values()]
    duePayoutsRef.current.clear()
    const storage: StorageLike = window.localStorage
    const nowSec = Math.floor(Date.now() / 1000)
    // Never seal a payout to a removed device (audit D6) — the scheduler
    // already skips revoked children; this also covers a payout stashed
    // just before the revocation landed.
    const revoked = state.app.docs.accounts.revoked ?? {}
    for (const entry of entries) {
      if (revoked[entry.child] !== undefined) continue
      void sendEntry(entry, { selfSk: guardianSk, peerPk: entry.child, relay, storage, nowSec }).catch(() => {})
    }
  }, [state.app, guardianSk, relay])

  // Child-side chores gate (U9): auto-raise the allowance.claim for any
  // chores-gated period that is due AND complete, whenever this device holds
  // its key — no longer only while the Chores screen happens to be mounted.
  // Same shape as the guardian scheduler above: the pure step
  // (`screens/chores.ts#raiseChoreGateClaims`) runs inside the dispatched
  // updater against the CURRENT app; raised payloads are stashed by reqId
  // and sent by the drain effect below once the commit has landed.
  // Idempotent by construction: a period that already has a claim on record
  // (by periodKey) is skipped, `upsertRequest` refuses a reqId it already
  // holds, and an updater that raises nothing returns the same `app` — so
  // the reducer bails out and re-running on every `state.app` change is a
  // no-op. Triggers: any app change (a new tick or entry can make a period
  // ready), plus the 15-minute interval and `focus` for time passing.
  const raisedClaimsRef = useRef<Map<string, RequestPayload>>(new Map())
  const childCanRaise = state.app.role === 'child' && childSk !== null && state.app.guardianPubkey !== null
  const raiseGateClaims = useCallback((): void => {
    const nowSec = Math.floor(Date.now() / 1000)
    dispatch({
      type: 'updateApp',
      update: (app) => {
        const { app: next, raised } = raiseChoreGateClaims(app, nowSec)
        for (const p of raised) raisedClaimsRef.current.set(p.reqId, p)
        return next
      },
    })
  }, [])
  useEffect(() => {
    if (!childCanRaise) return
    raiseGateClaims()
  }, [childCanRaise, state.app, raiseGateClaims])
  useEffect(() => {
    if (!childCanRaise) return
    const interval = window.setInterval(raiseGateClaims, SCHEDULER_INTERVAL_MS)
    window.addEventListener('focus', raiseGateClaims)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', raiseGateClaims)
    }
  }, [childCanRaise, raiseGateClaims])
  useEffect(() => {
    if (raisedClaimsRef.current.size === 0 || childSk === null || state.app.guardianPubkey === null) return
    const pending = [...raisedClaimsRef.current.values()]
    raisedClaimsRef.current.clear()
    const peerPk = state.app.guardianPubkey
    const storage: StorageLike = window.localStorage
    const nowSec = Math.floor(Date.now() / 1000)
    for (const payload of pending) {
      // Only send what actually landed in state — a StrictMode double-invoke
      // of the updater mints a second reqId that React then discards.
      if (!state.app.requests.some((r) => r.request.reqId === payload.reqId)) continue
      void sendRequest(payload, { selfSk: childSk, peerPk, relay, storage, nowSec }).catch(() => {})
    }
  }, [state.app, childSk, relay])

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      storageError,
      dispatch,
      effects,
      relay,
      guardianSk,
      childSk,
      locked,
      unlockChildSk,
      lockUi,
      wipeChildSk,
      onPairClaimAnsweredRef,
    }),
    [state, storageError, effects, relay, guardianSk, childSk, locked, unlockChildSk, lockUi, wipeChildSk],
  )
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

// Re-exported purely so callers of this module never need to reach into
// nostr-tools directly just to compute "whose pubkey is this device's own"
// from a loaded secret key (used by, e.g., a pairing screen action that
// needs `getPublicKey(guardianSk)` alongside `useApp()`'s state).
export { getPublicKey }
