// sync/resync.ts — the heartbeat comparison and the verified ingest of
// replayed events (v0.2 spec §2.2 and §2.4).
//
// Two devices that have both been offline, or that share a relay which
// silently dropped an event, drift apart in a way no amount of retrying a
// single send can fix: neither knows what the other is missing. The `status`
// heartbeat is the "here is my view" message that makes the drift VISIBLE,
// `compareStatus` is the whole decision about what to do about it, and
// `ingestResyncEvents` is the receiving half of the repair.
//
// The security position is worth stating up front, because this module is
// where a peer's own claims meet our ledger. We never trust JSON state from a
// peer. A `resync.reply` is a bag of RAW SIGNED inner events, and the only
// thing that ever moves this device's ledger is a signature this module
// verified itself (`verifyEvent`, which recomputes the NIP-01 id from the
// content, so a relaying peer cannot alter one byte) plus an author rule that
// says which key was allowed to sign that kind in the first place. A hostile
// child, or a hostile relay, can withhold events (indistinguishable from
// being offline — the next heartbeat retries) and can re-send events we
// already hold (deduped, free). It cannot forge, alter, roll back, or
// resurrect anything. See spec §2.4's "Security argument, explicitly".

import { verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import { KIND_CHILD_SIG, KIND_CONFIG, KIND_ENTRY, KIND_GRANT } from '../wire/kinds'
import {
  buildResyncReplyPayload,
  buildStatusPayload,
  isNostrEventShape,
  parseEntryPayload,
  RESYNC_PAGE_SIZE,
  type ResyncReplyPayload,
  type StatusPayload,
} from '../wire/payloads'
import type { AppState } from '../state/types'
import { dispatchInner, toStoredEvent, MAX_SEEN_EVENT_IDS, type Effect } from './ingress'
import { retainCorpus } from './corpus'

// ---------------------------------------------------------------------------
// §2.2 — comparison
// ---------------------------------------------------------------------------

/** What a received `status` says we should do about the gap between us. */
export type LagVerdict = { kind: 'ok' } | { kind: 'send-snapshot' } | { kind: 'request-resync' }

/** This device's own view of the same ledger the remote `status` describes —
 *  on the guardian, of THAT child's entries only (see `statusFor`). */
export interface LocalStatusView {
  entryCount: number
  lastEntryId: string | null
  docHighWater: Record<string, number>
}

/**
 * Pure. Spec §2.2's three rules, in order:
 *
 *  1. The peer is BEHIND — fewer entries than us, or the same-or-fewer
 *     entries with a different last entry id (the "same count, different
 *     history" case: a relay withheld one of ours and delivered one of
 *     theirs), or an older high-water on any config doc kind we hold (audit
 *     P2). We heal that by sending a snapshot.
 *  2. We are BEHIND — the peer has more entries, or is ahead on any config
 *     doc kind (including one we have never seen at all). We ask for a
 *     resync.
 *  3. Otherwise the two views agree.
 *
 * Rule 1 is checked before rule 2 deliberately: a divergence that satisfies
 * both is one where we hold entries the peer does not, and sending what we
 * have is strictly more useful than asking for what they have (they will
 * compare our snapshot and ask us in turn if they are still ahead).
 */
export function compareStatus(local: LocalStatusView, remote: StatusPayload): LagVerdict {
  if (remote.entryCount < local.entryCount) return { kind: 'send-snapshot' }
  if (remote.lastEntryId !== local.lastEntryId && remote.entryCount <= local.entryCount) return { kind: 'send-snapshot' }
  // Behind on a config doc (audit P2): a relay that dropped one CONFIG left
  // the peer on stale policy, and without this every heartbeat said 'ok'.
  // A snapshot carries every doc; LWW makes the ones it already has no-ops.
  for (const [docKind, highWater] of Object.entries(local.docHighWater)) {
    if (highWater > (remote.docHighWater[docKind] ?? 0)) return { kind: 'send-snapshot' }
  }
  if (remote.entryCount > local.entryCount) return { kind: 'request-resync' }
  for (const [docKind, highWater] of Object.entries(remote.docHighWater)) {
    if (highWater > (local.docHighWater[docKind] ?? 0)) return { kind: 'request-resync' }
  }
  return { kind: 'ok' }
}

// ---------------------------------------------------------------------------
// §2.4 — verified ingest
// ---------------------------------------------------------------------------

export interface IngestResyncOpts {
  /** The AUTHENTICATED peer whose `resync.reply` this is — the seal author of
   *  the wrap that carried it, never anything read out of the payload. This
   *  is what the CHILD_SIG/ENTRY author rules below are checked against, so
   *  passing a payload-supplied value here would give away the whole
   *  security property. */
  peerPk: string
  /** unix SECONDS — the receiver's own clock, for the CONFIG issuedAt clamp
   *  that rides along inside `dispatchInner`. */
  nowSec: number
}

/** Why one event of a batch was refused. Dev-log detail — never surfaced to
 *  a user, who can do nothing about a peer's bad page. */
export type IngestRejection = {
  id: string
  /** `scope` is the per-child rule (review fix): a correctly authored,
   *  correctly signed ENTRY that simply belongs to a SIBLING. Distinct from
   *  `author` because nothing is wrong with the event — it is just not this
   *  device's business, and it is neither folded nor stored. */
  reason: 'shape' | 'signature' | 'kind' | 'author' | 'scope' | 'duplicate' | 'payload' | 'deferred'
}

export interface IngestResult {
  state: AppState
  accepted: number
  rejected: IngestRejection[]
  effects: Effect[]
}

/** The inner kinds a `resync.reply` may carry (spec §2.1). Anything else is
 *  refused at step 3 — an ACK is re-derivable, a REQUEST is answered or
 *  stale, a SNAPSHOT is regenerated from current state, and none of them is
 *  ever replayed. */
const INGESTABLE_KINDS: readonly number[] = [KIND_ENTRY, KIND_CONFIG, KIND_GRANT, KIND_CHILD_SIG]

/** Duplicated from `ingress.ts#markSeen` (which is private there) rather than
 *  widening that module's surface: same bounded-FIFO semantics, same cap. */
function markSeen(state: AppState, id: string): AppState {
  if (state.seenEventIds.includes(id)) return state
  const next = [...state.seenEventIds, id]
  const trimmed = next.length > MAX_SEEN_EVENT_IDS ? next.slice(next.length - MAX_SEEN_EVENT_IDS) : next
  return { ...state, seenEventIds: trimmed }
}

/** The child a stored ENTRY belongs to, or null if this build cannot read it
 *  (a newer build's payload, or one that never parsed). Total — a corpus is
 *  not a place to throw. */
function entryChildOf(ev: NostrEvent): string | null {
  try {
    const parsed = parseEntryPayload(JSON.parse(ev.content))
    return parsed === null ? null : parsed.entry.child
  } catch {
    return null
  }
}

/**
 * Step 4b — the per-child scope rule (review fix). Pure.
 *
 * A CHILD device holds exactly one child's ledger. An ENTRY belonging to a
 * sibling is correctly signed by the guardian and passes the author rule, so
 * without this it would be folded straight into this child's `entries` —
 * putting a sibling's money on the wrong phone, and (worse) making the two
 * ends of the heartbeat permanently disagree: the child would then count
 * sibling entries while the guardian counts only this child's, so
 * `compareStatus` would answer 'request-resync' every hour for ever.
 *
 * An ENTRY this build cannot parse is let through rather than refused: we
 * cannot tell whose it is, it is never folded into the ledger either way, and
 * keeping it preserves the forward-compatibility property of the corpus
 * (spec §2.3). The guardian's own scoping in `resyncPage` is the primary
 * defence; this is the receiving end's own check.
 *
 * The rule does not apply on a guardian, which legitimately holds every
 * child's entries.
 */
function inScope(state: AppState, ev: NostrEvent): boolean {
  if (ev.kind !== KIND_ENTRY) return true
  if (state.role !== 'child' || state.self.pubkey === null) return true
  const forChild = entryChildOf(ev)
  return forChild === null || forChild === state.self.pubkey
}

/**
 * Step 4 — the author-authorisation rule, the one a hostile child must not be
 * able to bend. Pure.
 *
 *  - CONFIG/GRANT: the guardian and nobody else. Only the guardian signs
 *    policy and decisions; without this a child could replay a CONFIG it
 *    minted itself and rewrite the family's accounts.
 *  - CHILD_SIG: the AUTHENTICATED peer, and never the guardian. A child may
 *    replay its own ticks and audits, not another child's, and a guardian has
 *    no business signing one at all.
 *  - ENTRY: the guardian and nobody else (audit P1). No child flow authors
 *    an entry — a child's spend is a REQUEST answered by the guardian's own
 *    ENTRY — so a child-signed one is a forgery attempt by definition.
 */
function authorAuthorised(state: AppState, ev: NostrEvent, peerPk: string): boolean {
  switch (ev.kind) {
    case KIND_CONFIG:
    case KIND_GRANT:
      return state.guardianPubkey !== null && ev.pubkey === state.guardianPubkey
    case KIND_CHILD_SIG:
      return ev.pubkey === peerPk && ev.pubkey !== state.guardianPubkey
    case KIND_ENTRY:
      return state.guardianPubkey !== null && ev.pubkey === state.guardianPubkey
    default:
      return false
  }
}

/**
 * `verifyEvent` recomputes the id and checks the schnorr signature — the
 * load-bearing check of this whole module. Two things it does defensively:
 *
 *  - It verifies a JSON-PLAIN COPY (`toStoredEvent`), never the object handed
 *    to us. `nostr-tools` caches a verification result as a `Symbol(verified)`
 *    property on the event, and `verifyEvent` SHORT-CIRCUITS on it: an
 *    attacker (or an in-process caller spreading a finalised event, which is
 *    how this was found) who hands over an object carrying that symbol would
 *    otherwise have every signature check answer `true` without a single byte
 *    being hashed. Copying only the seven NIP-01 fields drops it.
 *  - It is wrapped, so a structurally odd event (a non-hex id, a malformed
 *    sig) is a `false`, never a throw: every parser and gate in this codebase
 *    is total.
 */
function verifiesSafely(ev: NostrEvent): boolean {
  try {
    return verifyEvent(toStoredEvent(ev))
  } catch {
    return false
  }
}

/**
 * Folds a page of replayed inner events into `state`, failing closed at every
 * step (spec §2.4). Pure and total.
 *
 * Order matters and is exactly the spec's: shape, signature, kind, author,
 * dedupe, payload. Signature before kind and author because an unverified
 * event's `kind` and `pubkey` fields mean nothing at all — they are just
 * numbers and strings a peer typed.
 *
 * An event whose fold `dispatchInner` DEFERS (see its `DispatchResult`) is
 * reported as `deferred` and is neither marked seen nor stored, so a later
 * replay can still fold it.
 *
 * An event that verifies and is authorised but whose payload this build
 * cannot use (not JSON, or a parser/guard that produced no change) is
 * reported as `payload` yet still MARKED SEEN and still STORED in
 * `innerEvents`: it is a genuine, correctly-authored event, possibly minted
 * by a newer build, and this device must be able to hand it on to a third
 * device that does understand it (spec §2.3). Only the ledger declines it.
 *
 * The fold itself goes through `dispatchInner`, the same path live wire
 * traffic takes, so there is exactly ONE implementation of the direction
 * guards, the issuedAt clamp and every parser. `retainCorpus` is applied
 * once at the end of the batch rather than per event — the bound is on what
 * is kept, not on how it got there.
 */
export function ingestResyncEvents(state: AppState, events: unknown[], opts: IngestResyncOpts): IngestResult {
  let next = state
  let accepted = 0
  const rejected: IngestRejection[] = []
  const effects: Effect[] = []
  let corpusChanged = false

  for (const candidate of events) {
    if (!isNostrEventShape(candidate)) {
      const id = typeof (candidate as { id?: unknown } | null)?.id === 'string' ? String((candidate as { id: string }).id) : ''
      rejected.push({ id, reason: 'shape' })
      continue
    }
    const ev = candidate
    if (!verifiesSafely(ev)) {
      rejected.push({ id: ev.id, reason: 'signature' })
      continue
    }
    if (!INGESTABLE_KINDS.includes(ev.kind)) {
      rejected.push({ id: ev.id, reason: 'kind' })
      continue
    }
    if (!authorAuthorised(next, ev, opts.peerPk)) {
      rejected.push({ id: ev.id, reason: 'author' })
      continue
    }
    if (!inScope(next, ev)) {
      rejected.push({ id: ev.id, reason: 'scope' })
      continue
    }
    // Dedupe against BOTH registries, and against the running state rather
    // than the caller's snapshot, so a page that repeats an event inside
    // itself is caught too.
    if (next.seenEventIds.includes(ev.id) || ev.id in next.innerEvents) {
      rejected.push({ id: ev.id, reason: 'duplicate' })
      continue
    }

    let payload: unknown
    let parsedOk = true
    try {
      payload = JSON.parse(ev.content)
    } catch {
      parsedOk = false
    }

    const base = next
    const dispatched = parsedOk ? dispatchInner(base, ev.kind, payload, ev.pubkey, opts.nowSec) : null
    // A deferred refusal (a doc beyond the clock-skew window, an entry on an
    // account whose doc has not arrived) is about WHEN, not WHAT: leave the
    // event un-seen and un-stored so the next replay can fold it (audit P3).
    if (dispatched !== null && dispatched.deferred === true) {
      rejected.push({ id: ev.id, reason: 'deferred' })
      continue
    }

    // It verified and it is authorised: it is ours to keep whatever the
    // payload turns out to be (see the doc comment above).
    const folded = dispatched === null ? base : dispatched.state
    const seen = markSeen(folded, ev.id)
    next = { ...seen, innerEvents: { ...seen.innerEvents, [ev.id]: toStoredEvent(ev) } }
    corpusChanged = true
    if (dispatched === null || (dispatched.state === base && dispatched.effects.length === 0)) {
      rejected.push({ id: ev.id, reason: 'payload' })
      continue
    }
    effects.push(...dispatched.effects)
    accepted += 1
  }

  if (corpusChanged) next = { ...next, innerEvents: retainCorpus(next.innerEvents) }

  return { state: next, accepted, rejected, effects }
}

// ---------------------------------------------------------------------------
// §2.2 — building the two outbound payloads
// ---------------------------------------------------------------------------

/** Ledger order, and the tiebreak that makes two devices agree on which
 *  entry is "last": `createdAt`, then id. Both sides sort the same set the
 *  same way, so `lastEntryId` is a genuine equality check rather than a
 *  race between two arrival orders. */
function lastEntryIdOf(entries: readonly { id: string; createdAt: number }[]): string | null {
  let last: { id: string; createdAt: number } | null = null
  for (const entry of entries) {
    if (last === null || entry.createdAt > last.createdAt || (entry.createdAt === last.createdAt && entry.id > last.id)) last = entry
  }
  return last === null ? null : last.id
}

/**
 * This device's `status` heartbeat (spec §2.2). Pure — `nowSec` and
 * `appVersion` are both parameters, the latter because a pure helper has no
 * business reading `import.meta` (and because a test wants to pin it).
 *
 * `forChildPk` scopes the entry count: the GUARDIAN compares against its view
 * of ONE child's ledger (only entries whose `child` is that peer), a CHILD
 * against all of its own. The two are the same set by construction, which is
 * exactly what makes `compareStatus`'s count comparison meaningful.
 */
export function statusFor(app: AppState, forChildPk: string | null, appVersion: string, nowSec: number): StatusPayload {
  const entries = forChildPk === null ? app.entries : app.entries.filter((e) => e.child === forChildPk)
  return buildStatusPayload({
    at: nowSec,
    lastEntryId: lastEntryIdOf(entries),
    entryCount: entries.length,
    docHighWater: app.docHighWater,
    appVersion,
  })
}

/**
 * One page of the lossless corpus, in answer to a `resync.request`. Pure.
 *
 * The corpus is ordered CONFIG first, then by `created_at` then id
 * (`corpusOrder`) — the same stable order on every device, so a cursor means
 * the same thing to both ends.
 *
 * `forChildPk` SCOPES the reply (review fix). A guardian's corpus holds every
 * child's events, and serving all of it to whichever child asked would put a
 * sibling's ledger on that child's phone. Named a child, this serves only:
 * ENTRY events for that child, CHILD_SIG events that child itself signed, and
 * the family's CONFIG and GRANT events (policy is family-wide, and a GRANT
 * payload does not name a child at all — see `wire/payloads.ts#GrantPayload`
 * — so there is nothing to scope it by). An ENTRY this build cannot read is
 * WITHHELD rather than guessed at: failing closed costs a replay, guessing
 * would cost a leak. `null` means "everything", which is what a child
 * replying to its own guardian sends — the guardian already holds it all, and
 * a recovering guardian genuinely wants whatever the child kept.
 *
 * `since` is a CURSOR, and it is ONLY ever an inner EVENT id: the id of the
 * last event of the previous page of THIS exchange. It is deliberately never
 * a ledger entry id (`status.lastEntryId`), because the two are sorted by
 * different keys — the corpus by `created_at`/event id, the ledger by
 * `createdAt`/entry id — so a ledger-derived cursor can sit AFTER an event
 * we never received, which would then never be sent again at any hour. The
 * FIRST request of an exchange therefore always carries `null`: a full
 * replay, which dedupe makes nearly free. An unknown cursor sends from the
 * start for the same reason.
 *
 * `page` offsets by whole pages from the cursor, and `more` says whether
 * anything is left after this one.
 */
export function resyncPage(app: AppState, since: string | null, page: number, forChildPk: string | null = null): ResyncReplyPayload {
  const ordered = Object.values(app.innerEvents)
    .filter((ev) => servesTo(ev, forChildPk))
    .sort(corpusOrder)

  let start = 0
  if (since !== null) {
    const cursor = ordered.findIndex((ev) => ev.id === since)
    if (cursor !== -1) start = cursor + 1
  }

  const from = start + page * RESYNC_PAGE_SIZE
  const events = ordered.slice(from, from + RESYNC_PAGE_SIZE)
  return buildResyncReplyPayload({ events, page, more: ordered.length > from + events.length })
}

/**
 * The order a corpus is served in: CONFIG first, then everything by
 * `created_at`, then id. Pure; a total order, so both ends of an exchange
 * mean the same thing by a cursor.
 *
 * Policy goes first because the rest depends on it: an ENTRY or CHILD_SIG
 * naming an account or chore whose doc has not been folded yet is deferred,
 * and would wait for the NEXT exchange. With superseded docs pruned
 * (`sync/corpus.ts`), the surviving doc can be much younger than the entries
 * it describes, so serving by age alone would defer most of a replay.
 */
function corpusOrder(a: NostrEvent, b: NostrEvent): number {
  const ca = a.kind === KIND_CONFIG ? 0 : 1
  const cb = b.kind === KIND_CONFIG ? 0 : 1
  if (ca !== cb) return ca - cb
  if (a.created_at !== b.created_at) return a.created_at - b.created_at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Whether one corpus event belongs in a reply scoped to `forChildPk` — see
 *  `resyncPage`. Pure. */
function servesTo(ev: NostrEvent, forChildPk: string | null): boolean {
  if (forChildPk === null) return true
  if (ev.kind === KIND_ENTRY) return entryChildOf(ev) === forChildPk
  if (ev.kind === KIND_CHILD_SIG) return ev.pubkey === forChildPk
  return true
}


// ---------------------------------------------------------------------------
// §2.2 — bounding the exchange
// ---------------------------------------------------------------------------

/** How often a child device tells its guardian where it thinks it is. Hourly:
 *  the heartbeat is a repair mechanism, not a sync mechanism — live traffic
 *  already carries everything, and this only has to catch what a relay or an
 *  offline spell lost. */
export const STATUS_INTERVAL_MS = 60 * 60_000

/** Pages one `resync.request` may draw out of a peer before the requester
 *  stops asking. At `RESYNC_PAGE_SIZE` events a page that is a thousand
 *  events — far more than a real gap — and it is what stops a hostile peer
 *  turning "I am behind" into an unbounded conversation. A genuinely larger
 *  gap is not lost, merely deferred: the next heartbeat starts a fresh
 *  exchange from wherever this one got to. */
export const RESYNC_MAX_PAGES = 10

/**
 * The cursor to ask the next page with, or `null` to stop. Pure.
 *
 * Stops on three things, all of them the peer's word being worth nothing on
 * its own: it said there is no more; it has already been asked
 * `RESYNC_MAX_PAGES` times; or it sent an empty page while still claiming
 * more (the loop that would otherwise never end, since an empty page moves
 * no cursor).
 */
export function nextResyncCursor(reply: ResyncReplyPayload, pagesReceived: number): string | null {
  if (!reply.more || pagesReceived >= RESYNC_MAX_PAGES) return null
  const last = reply.events[reply.events.length - 1]
  return last === undefined ? null : last.id
}

/**
 * The entry ids to ACK back to `peerPk` after an ingest (review fix). Pure.
 *
 * `dispatchInner` raises an `ack` effect for every ENTRY it folds, and the
 * live engines send those themselves — but a replayed page goes through this
 * module instead, so without this every entry recovered by a resync would
 * show as never-delivered in the sender's own feed
 * (`screens/feed.ts#toFeedRow`'s `acked`), for ever.
 *
 * Only the events the REPLAYING PEER itself authored are acked. An entry we
 * authored ourselves and are merely being handed back needs no ack, and one
 * authored by a third party is not this peer's to be told about.
 */
export function acksFor(effects: readonly Effect[], peerPk: string): string[] {
  return effects.filter((e) => e.type === 'ack' && e.authorPk === peerPk).map((e) => (e as { entryId: string }).entryId)
}

// ---------------------------------------------------------------------------
// Rate limiting inbound heartbeat/resync traffic (review fix, round 1)
// ---------------------------------------------------------------------------

/** {@link STATUS_INTERVAL_MS} in unix SECONDS, the unit the wire uses. */
export const STATUS_INTERVAL_SECS = STATUS_INTERVAL_MS / 1000

/**
 * Whether to act on a `status` from `peerPk`. Pure.
 *
 * Answering a heartbeat is not free: it costs either a whole-state snapshot
 * wrap or a fresh resync exchange, and starting a fresh exchange resets the
 * requester's page counter — so without this the 10-page cap bounded ONE
 * exchange while the exchange RATE belonged to the peer. A legitimate child
 * beats once an hour, so half that is a gap no honest device ever notices,
 * and a flood becomes at most two answers an hour per peer.
 *
 * Ignoring is the right response, not disconnecting: a peer beating too often
 * is far more likely to be a buggy build or a relay re-delivering than an
 * attack, and the next accepted beat repairs whatever the ignored ones would
 * have.
 */
export function statusAccepted(
  lastSeenAtByPeer: ReadonlyMap<string, number>,
  peerPk: string,
  nowSec: number,
  minGapSec: number = STATUS_INTERVAL_SECS / 2,
): boolean {
  const last = lastSeenAtByPeer.get(peerPk)
  return last === undefined || nowSec - last >= minGapSec
}

/** One peer's in-progress resync exchange, from the SERVING side. */
export interface ResyncExchange {
  /** unix SECONDS the exchange was opened. */
  startedAt: number
  /** Pages served in it so far, including the one being decided. */
  pagesServed: number
}

/**
 * Whether to serve a `resync.request` from a peer, and the exchange state
 * that follows. Pure.
 *
 * The same gap `statusAccepted` uses cannot simply be applied to every
 * request: a paged exchange NEEDS a request per page, and gating those would
 * break paging outright. So the gap gates only the START of an exchange (a
 * null cursor, which is the only way one begins — see `resyncPage`), and
 * continuation pages are bounded instead by the serving side's own count,
 * capped at {@link RESYNC_MAX_PAGES}. Together that is at most one exchange
 * per gap per peer and at most ten pages in it — the requester's own cap
 * mirrored on the side that pays for it.
 *
 * A continuation with no exchange open is refused: a peer has to ask from the
 * start, which is the thing that is rate-limited.
 */
export function servesResyncPage(
  exchange: ResyncExchange | undefined,
  since: string | null,
  nowSec: number,
  minGapSec: number = STATUS_INTERVAL_SECS / 2,
): { serve: boolean; exchange: ResyncExchange | undefined } {
  if (since === null) {
    if (exchange !== undefined && nowSec - exchange.startedAt < minGapSec) return { serve: false, exchange }
    return { serve: true, exchange: { startedAt: nowSec, pagesServed: 1 } }
  }
  if (exchange === undefined || exchange.pagesServed >= RESYNC_MAX_PAGES) return { serve: false, exchange }
  return { serve: true, exchange: { startedAt: exchange.startedAt, pagesServed: exchange.pagesServed + 1 } }
}

// ---------------------------------------------------------------------------
// Child-initiated catch-up (v0.3)
// ---------------------------------------------------------------------------

/**
 * Whether a CHILD may send a catch-up `status` now, given when it last sent
 * one (`lastAt`, unix SECONDS, `undefined` if never). Pure.
 *
 * Only the guardian used to compare statuses, so a child had no way to say
 * "I know I am behind": a lost GRANT or a lost accounts CONFIG sat unhealed
 * until an unrelated count mismatch. A catch-up status (`catchUp: true`) asks
 * the guardian for a snapshot outright.
 *
 * It is bounded by the SAME gap the guardian applies to every inbound
 * status (`statusAccepted`, half the heartbeat interval), on both ends: the
 * child does not ask more often than the guardian would answer, and the
 * guardian gates catch-ups per peer in their own bucket — so "I am behind"
 * costs the guardian at most two extra snapshots an hour per child.
 */
export function catchUpDue(lastAt: number | undefined, nowSec: number, minGapSec: number = STATUS_INTERVAL_SECS / 2): boolean {
  return lastAt === undefined || nowSec - lastAt >= minGapSec
}
