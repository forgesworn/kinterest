import { IndexedDataStorage, flushDataStorage } from '../platform/dataStorage'
// Outbound wire traffic — every gift-wrapped event this app sends goes
// through one of these named helpers. See
// internal plan 2026-08-10-wire-identity-pairing, Task 7.
//
// Each helper: builds the typed payload, wraps it (wire/giftwrap.ts) to the
// peer's pubkey, enqueues it to the LOCAL durable outbox (wire/outbox.ts),
// then attempts an immediate flush against `relay`. `storage` is deliberately
// a REQUIRED field on `PublishOpts` rather than falling back to outbox.ts's
// own default: that default re-evaluates `defaultStorage()` on every call
// with no injected storage, which in a Node/test environment (no real
// `localStorage`) hands back a FRESH empty in-memory map each time — items
// enqueued in one call would never be seen by a later call's flush. Real
// browser callers can still pass `window.localStorage` explicitly; the point
// is that "which durable queue this device is using" must be a caller
// decision, not an accident of default-parameter re-evaluation, and it must
// also never be shared between two different devices/peers in the same
// process (each device's outbox is genuinely separate).

import type { NostrEvent } from 'nostr-tools/pure'
import { wrapFor } from '../wire/giftwrap'
import { enqueue, flush, outboxEvents, type StorageLike } from '../wire/outbox'
import type { RelayLike } from '../wire/relayClient'
import {
  KIND_ACK,
  KIND_CHILD_SIG,
  KIND_CONFIG,
  KIND_ENTRY,
  KIND_GRANT,
  KIND_PAIR_OFFER,
  KIND_REQUEST,
  KIND_SNAPSHOT,
  KIND_STATUS,
  KIND_VAULT,
} from '../wire/kinds'
import {
  buildAckPayload,
  buildChildAuditPayload,
  buildChildTickPayload,
  buildConfigPayload,
  buildEntryPayload,
  type CheckpointPayload,
  type ConfigDocKind,
  type GrantPayload,
  type PairOfferPayload,
  type RequestPayload,
  type ResyncReplyPayload,
  type ResyncRequestPayload,
  type SnapshotPayload,
  type StatusPayload,
  type VaultPayload,
} from '../wire/payloads'
import type { AuditResult } from '../domain/audit'
import type { ChoreTick } from '../domain/chores'
import type { Entry } from '../domain/types'
import type { ConfigDocs } from '../state/types'
import { scopeDoc } from './snapshot'

export interface PublishOpts {
  /** The sender's own secret key — inners are always fully signed here. */
  selfSk: Uint8Array
  /** The recipient's pubkey — the gift wrap is addressed to them. */
  peerPk: string
  relay: RelayLike
  /** This device's durable outbox storage (see module header). */
  storage: StorageLike
  nowSec: number
  /** Used only to notify a retired device of its revocation. */
  directPeer?: boolean
}

export interface PublishResult {
  event: NostrEvent
  /** True once this event has left the local outbox — some relay accepted
   *  it during this call's flush. False means it is durably queued (offline
   *  / every relay rejected / timed out) and will be retried on a future
   *  flush — airplane mode must never read as `sent: true`. */
  sent: boolean
  /** Every recipient either accepted delivery or has a durable queued copy. */
  queued?: boolean
}

async function sendOne(innerKind: number, payload: unknown, opts: PublishOpts): Promise<PublishResult> {
  const event = wrapFor({
    innerKind,
    payload,
    authorSk: opts.selfSk,
    recipientPk: opts.peerPk,
    nowSec: opts.nowSec,
  })
  try {
    enqueue(event, opts.nowSec, opts.storage)
  } catch {
    // Storage full or blocked: the event could not be queued, so
    // a failure used to lose it without a trace. Publish it directly instead;
    // `sent` then says whether it got out, and a caller that cares can retry.
    const result = await opts.relay.publish(event).catch(() => 'rejected' as const)
    return { event, sent: result === 'accepted', queued:false }
  }
  // Commit the offline queue before publishing; a failed write is retained
  // in memory and reported by the storage banner while relay delivery proceeds.
  const durable = !(opts.storage instanceof IndexedDataStorage) || await flushDataStorage(opts.storage)
  await flush(opts.relay, opts.nowSec, opts.storage)
  const stillQueued = outboxEvents(opts.storage).some((e) => e.id === event.id)
  return { event, sent: !stillQueued, queued: stillQueued && durable }
}

async function send(innerKind: number, payload: unknown, opts: PublishOpts): Promise<PublishResult> {
  const peers = opts.directPeer ? [opts.peerPk] : opts.relay.family?.recipients(opts.peerPk) ?? [opts.peerPk]
  if (peers.length === 0) throw new Error('No authorised device for this child')
  let result: PublishResult | undefined
  let allSent = true, allDelivered = true
  for (const peerPk of peers) {
    result = await sendOne(innerKind, payload, { ...opts, peerPk })
    allSent &&= result.sent
    allDelivered &&= result.sent || result.queued === true
  }
  return { event: result!.event, sent: allSent, queued: allDelivered }
}

export function sendCorrection(correction: Entry[], opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_ENTRY, { v: 1, entry: correction[0], correction }, opts)
}

export function sendEntry(entry: Entry, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_ENTRY, buildEntryPayload(entry), opts)
}

/** Sends a config doc to ONE child, narrowed to that child's own rows
 *  (`snapshot.ts#scopeDoc`): its accounts, its allowance and interest
 *  configs, its chores, and its own `revoked` row. Each recipient gets its
 *  own guardian-signed view with the doc's kind and `issuedAt`, so no child
 *  ever holds a sibling's settings. The guardian keeps the full doc. */
export function sendConfig<K extends ConfigDocKind>(
  docKind: K,
  doc: ConfigDocs[K],
  opts: PublishOpts,
): Promise<PublishResult> {
  return send(KIND_CONFIG, buildConfigPayload(docKind, scopeDoc(docKind, doc, opts.relay.family?.childForPeer(opts.peerPk) ?? opts.peerPk)), opts)
}

export function sendAck(entryId: string, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_ACK, buildAckPayload(entryId, opts.nowSec), opts)
}

export function sendTick(tick: ChoreTick, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_CHILD_SIG, buildChildTickPayload(tick), opts)
}

export function sendAudit(audit: AuditResult, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_CHILD_SIG, buildChildAuditPayload(audit), opts)
}

export function sendRequest(payload: RequestPayload, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_REQUEST, payload, opts)
}

export function sendGrant(payload: GrantPayload, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_GRANT, payload, opts)
}

export function sendSnapshot(
  payload: SnapshotPayload | CheckpointPayload,
  opts: PublishOpts,
): Promise<PublishResult> {
  return send(KIND_SNAPSHOT, payload, opts)
}

/** Sends the guardian's PAIR_OFFER — the wire step after
 *  `ingress.ts#handlePairClaimWrap` has already gated the claim through
 *  `consumeToken` and built the offer via `pairing.ts#answerPairClaim`. Not
 *  itself part of the pinned-peer sync traffic (kind KIND_PAIR_OFFER is
 *  never dispatched by `ingress.ts#handleWrap`) — kept here purely because
 *  it shares the same wrap/enqueue/flush plumbing as everything else. */
export function sendPairOffer(payload: PairOfferPayload, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_PAIR_OFFER, payload, opts)
}

/** The Signet-encrypted family vault (v0.2 spec §1.6), addressed to the
 *  family's My Signet root pubkey rather than to a child — `opts.peerPk` is
 *  the root identity here. Same wrap/enqueue/flush plumbing as every other
 *  helper; the wrap is marker-tagged `kin-jar` like the rest, so the recovery
 *  subscription's `{kinds:[1059], '#p':[signetPk], '#t':['kin-jar']}` filter
 *  finds it. */
export function sendVault(payload: VaultPayload, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_VAULT, payload, opts)
}

/** Child -> guardian heartbeat (v0.2 spec §2.2). */
export function sendStatus(payload: StatusPayload, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_STATUS, payload, opts)
}

/** "Send me what I am missing" — either direction (v0.2 spec §2.2). */
export function sendResyncRequest(payload: ResyncRequestPayload, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_STATUS, payload, opts)
}

/** One page of raw signed inner events in answer to a resync request. */
export function sendResyncReply(payload: ResyncReplyPayload, opts: PublishOpts): Promise<PublishResult> {
  return send(KIND_STATUS, payload, opts)
}
