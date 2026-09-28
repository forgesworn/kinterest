// Resync tests (v0.2 spec §2.2 comparison rules, §2.4 verified ingest).
//
// The ingest tests are the security tests for this module: every one of them
// is a thing a hostile peer or relay would try, and the assertion is that the
// author/signature rules refuse it. They build REAL signed inner events with
// `finalizeEvent` (never a hand-rolled object), because the whole point of
// §2.4 is that a signature we verify ourselves is the only thing that is
// allowed to move the ledger.

import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { KIND_CHILD_SIG, KIND_CONFIG, KIND_ENTRY, KIND_GRANT } from '../wire/kinds'
import {
  buildChildTickPayload,
  buildConfigPayload,
  buildEntryPayload,
  buildResyncReplyPayload,
  buildStatusPayload,
  RESYNC_PAGE_SIZE,
  type StatusPayload,
} from '../wire/payloads'
import { creditEntry } from '../domain/ledger'
import type { Account } from '../domain/types'
import { emptyState } from '../state/state'
import type { AppState, ConfigDocs } from '../state/types'
import type { Effect } from './ingress'
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
  RESYNC_MAX_PAGES,
  STATUS_INTERVAL_MS,
  STATUS_INTERVAL_SECS,
} from './resync'

const AT = 1000

function makeKeypair() {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

const guardian = makeKeypair()
const child = makeKeypair()
const stranger = makeKeypair()

const account: Account = { id: 'a-ledger', child: child.pk, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }
const entryFixture = creditEntry({ id: 'e-resync-1', child: child.pk, createdAt: AT, author: 'guardian' }, account, 500)
const choresDoc: ConfigDocs['chores'] = { v: 1, issuedAt: 900, chores: [] }
const tickFixture = { id: 't-resync-1', chore: 'c1', day: '2026-09-02', at: AT }

const guardianState: AppState = {
  ...emptyState(),
  role: 'guardian',
  guardianPubkey: guardian.pk,
  self: { pubkey: guardian.pk, childIndex: null },
  children: [{ pubkey: child.pk, name: 'Alex', index: 0 }],
  // Audit P1/P8: an ENTRY binds to a known account, a tick to a known chore.
  docs: {
    ...emptyState().docs,
    accounts: { v: 1, issuedAt: 1, accounts: [account] },
    chores: { v: 1, issuedAt: 1, chores: [{ id: 'c1', child: child.pk, name: 'Bed', cadence: 'daily' }] },
  },
}

const childState: AppState = {
  ...emptyState(),
  role: 'child',
  guardianPubkey: guardian.pk,
  self: { pubkey: child.pk, childIndex: 0 },
  docs: { ...emptyState().docs, accounts: { v: 1, issuedAt: 1, accounts: [account] } },
}

/** The account `entryAt` books to for `pk` — `account` itself for `child`. */
const accountFor = (pk: string): Account => (pk === child.pk ? account : { ...account, id: `a-${pk.slice(0, 12)}`, child: pk })

/** `state` with an accounts doc holding an account for each of `pks`. */
const withAccountsFor = (state: AppState, ...pks: string[]): AppState => ({
  ...state,
  docs: { ...state.docs, accounts: { v: 1, issuedAt: 1, accounts: pks.map(accountFor) } },
})

const mkInner = (sk: Uint8Array, kind: number, payload: unknown, at = AT) =>
  finalizeEvent({ kind, created_at: at, tags: [['t', 'kin-jar']], content: JSON.stringify(payload) }, sk)

const st = (entryCount: number, lastEntryId: string | null, docHighWater: Record<string, number>): StatusPayload =>
  buildStatusPayload({ at: AT, lastEntryId, entryCount, docHighWater, appVersion: '0.2.0' })

// ============================================================================
// compareStatus — spec §2.2
// ============================================================================

describe('compareStatus', () => {
  const local = { entryCount: 5, lastEntryId: 'e5', docHighWater: { chores: 10 } }

  it('ok when identical', () => {
    expect(compareStatus(local, st(5, 'e5', { chores: 10 })).kind).toBe('ok')
  })

  it('snapshot when the peer is behind', () => {
    expect(compareStatus(local, st(3, 'e3', { chores: 10 })).kind).toBe('send-snapshot')
  })

  it('snapshot when the peer has the same count but a different last entry', () => {
    expect(compareStatus(local, st(5, 'e-other', { chores: 10 })).kind).toBe('send-snapshot')
  })

  it('resync when the peer has more entries', () => {
    expect(compareStatus(local, st(7, 'e7', { chores: 10 })).kind).toBe('request-resync')
  })

  it('resync when a doc kind is ahead', () => {
    expect(compareStatus(local, st(5, 'e5', { chores: 11 })).kind).toBe('request-resync')
  })

  it('resync when the peer has a doc kind we have never seen', () => {
    expect(compareStatus(local, st(5, 'e5', { chores: 10, allowance: 1 })).kind).toBe('request-resync')
  })

  // Audit P2: a dropped CONFIG used to leave the child on stale policy for
  // ever, every heartbeat answered 'ok'.
  it('snapshot when the peer is BEHIND on a config doc, entries agreeing', () => {
    const g = { entryCount: 3, lastEntryId: 'e3', docHighWater: { accounts: 2000, chores: 1500 } }
    expect(compareStatus(g, st(3, 'e3', { accounts: 1000, chores: 1500 })).kind).toBe('send-snapshot')
  })

  it('snapshot when the peer has never seen a doc kind we hold', () => {
    expect(compareStatus(local, st(5, 'e5', {})).kind).toBe('send-snapshot')
  })

  it('ok on an empty ledger both sides', () => {
    expect(compareStatus({ entryCount: 0, lastEntryId: null, docHighWater: {} }, st(0, null, {})).kind).toBe('ok')
  })
})

// ============================================================================
// ingestResyncEvents — spec §2.4
// ============================================================================

describe('ingestResyncEvents', () => {
  it('accepts a guardian-signed ENTRY', () => {
    const r = ingestResyncEvents(childState, [mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryFixture))], {
      peerPk: guardian.pk,
      nowSec: 2000,
    })
    expect(r.accepted).toBe(1)
    expect(r.state.entries).toHaveLength(1)
  })

  it('rejects the same event with one byte changed', () => {
    const ev = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryFixture))
    const r = ingestResyncEvents(childState, [{ ...ev, content: ev.content.replace('500', '50000') }], {
      peerPk: guardian.pk,
      nowSec: 2000,
    })
    expect(r.accepted).toBe(0)
    expect(r.rejected[0]!.reason).toBe('signature')
    expect(r.state.entries).toHaveLength(0)
  })

  it('rejects anything that is not even an event shape', () => {
    const r = ingestResyncEvents(childState, [null, { id: 'x' }], { peerPk: guardian.pk, nowSec: 2000 })
    expect(r.rejected.map((x) => x.reason)).toEqual(['shape', 'shape'])
  })

  it('rejects a CONFIG signed by the peer rather than the guardian', () => {
    const r = ingestResyncEvents(guardianState, [mkInner(child.sk, KIND_CONFIG, buildConfigPayload('chores', choresDoc))], {
      peerPk: child.pk,
      nowSec: 2000,
    })
    expect(r.rejected[0]!.reason).toBe('author')
    expect(r.state.docs.chores.issuedAt).toBe(guardianState.docs.chores.issuedAt)
    expect(r.state.innerEvents).toEqual({})
  })

  it('rejects a CHILD_SIG signed by the guardian and an ENTRY from a third key', () => {
    expect(
      ingestResyncEvents(guardianState, [mkInner(guardian.sk, KIND_CHILD_SIG, buildChildTickPayload(tickFixture))], {
        peerPk: child.pk,
        nowSec: 2000,
      }).rejected[0]!.reason,
    ).toBe('author')
    expect(
      ingestResyncEvents(guardianState, [mkInner(stranger.sk, KIND_ENTRY, buildEntryPayload(entryFixture))], {
        peerPk: child.pk,
        nowSec: 2000,
      }).rejected[0]!.reason,
    ).toBe('author')
  })

  it('accepts a CHILD_SIG signed by the authenticated peer', () => {
    const r = ingestResyncEvents(guardianState, [mkInner(child.sk, KIND_CHILD_SIG, buildChildTickPayload(tickFixture))], {
      peerPk: child.pk,
      nowSec: 2000,
    })
    expect(r.accepted).toBe(1)
    expect(r.state.ticks).toHaveLength(1)
    expect(r.effects.some((e) => e.type === 'tick')).toBe(true)
  })

  it('rejects an out-of-set kind and dedupes', () => {
    expect(ingestResyncEvents(childState, [mkInner(guardian.sk, 1, {})], { peerPk: guardian.pk, nowSec: 2000 }).rejected[0]!.reason).toBe(
      'kind',
    )
    const ev = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryFixture))
    const once = ingestResyncEvents(childState, [ev], { peerPk: guardian.pk, nowSec: 2000 })
    expect(ingestResyncEvents(once.state, [ev], { peerPk: guardian.pk, nowSec: 2000 }).rejected[0]!.reason).toBe('duplicate')
  })

  it('dedupes a repeat within the same batch', () => {
    const ev = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryFixture))
    const r = ingestResyncEvents(childState, [ev, ev], { peerPk: guardian.pk, nowSec: 2000 })
    expect(r.accepted).toBe(1)
    expect(r.rejected[0]!.reason).toBe('duplicate')
  })

  it('stores a verified event whose content is not JSON, and counts it as payload', () => {
    const ev = finalizeEvent({ kind: KIND_ENTRY, created_at: AT, tags: [], content: 'not json' }, guardian.sk)
    const r = ingestResyncEvents(childState, [ev], { peerPk: guardian.pk, nowSec: 2000 })
    expect(r.rejected[0]!.reason).toBe('payload')
    expect(r.state.innerEvents[ev.id]).toBeDefined()
    expect(r.state.seenEventIds).toContain(ev.id)
  })

  it('stores the corpus copy JSON-plain, so ingest survives a persist round trip', () => {
    const ev = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryFixture))
    const r = ingestResyncEvents(childState, [ev], { peerPk: guardian.pk, nowSec: 2000 })
    const stored = r.state.innerEvents[ev.id]!
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored)
    expect(Object.getOwnPropertySymbols(stored)).toHaveLength(0)
  })

  it('does not let a far-future CONFIG move docHighWater', () => {
    const doc: ConfigDocs['chores'] = { ...choresDoc, issuedAt: 9_000_000_000 }
    const r = ingestResyncEvents(childState, [mkInner(guardian.sk, KIND_CONFIG, buildConfigPayload('chores', doc))], {
      peerPk: guardian.pk,
      nowSec: 2000,
    })
    expect(r.state.docHighWater.chores ?? 0).toBeLessThan(9_000_000_000)
  })

  it('applies a guardian CONFIG the clamp allows, and reports the config effect', () => {
    const r = ingestResyncEvents(childState, [mkInner(guardian.sk, KIND_CONFIG, buildConfigPayload('chores', choresDoc))], {
      peerPk: guardian.pk,
      nowSec: 2000,
    })
    expect(r.accepted).toBe(1)
    expect(r.state.docHighWater.chores).toBe(900)
    expect(r.effects).toContainEqual({ type: 'config', docKind: 'chores' })
  })

  it('leaves state untouched for an empty batch', () => {
    const r = ingestResyncEvents(childState, [], { peerPk: guardian.pk, nowSec: 2000 })
    expect(r.state).toBe(childState)
    expect(r.accepted).toBe(0)
  })
})

// ============================================================================
// statusFor / resyncPage — spec §2.2
// ============================================================================

const otherChild = makeKeypair()

function entryAt(id: string, forChild: string, createdAt: number) {
  return creditEntry({ id, child: forChild, createdAt, author: 'guardian' }, accountFor(forChild), 100)
}

describe('statusFor', () => {
  const withEntries: AppState = {
    ...guardianState,
    entries: [entryAt('e-a', child.pk, 100), entryAt('e-b', otherChild.pk, 200), entryAt('e-c', child.pk, 300)],
    docHighWater: { chores: 42 },
  }

  it('counts only that child s entries when a child is named', () => {
    const s = statusFor(withEntries, child.pk, '0.2.0', 5000)
    expect(s.entryCount).toBe(2)
    expect(s.lastEntryId).toBe('e-c')
    expect(s.at).toBe(5000)
    expect(s.appVersion).toBe('0.2.0')
    expect(s.docHighWater).toEqual({ chores: 42 })
  })

  it('counts every entry when no child is named (a child s own view)', () => {
    expect(statusFor(withEntries, null, '0.2.0', 5000).entryCount).toBe(3)
    expect(statusFor(withEntries, null, '0.2.0', 5000).lastEntryId).toBe('e-c')
  })

  it('breaks a createdAt tie by id, so both devices name the same last entry', () => {
    const tied: AppState = { ...guardianState, entries: [entryAt('e-z', child.pk, 100), entryAt('e-a', child.pk, 100)] }
    expect(statusFor(tied, null, '0.2.0', 5000).lastEntryId).toBe('e-z')
  })

  it('reports a null lastEntryId on an empty ledger', () => {
    const s = statusFor(guardianState, child.pk, '0.2.0', 5000)
    expect(s).toEqual({ v: 1, type: 'status', at: 5000, lastEntryId: null, entryCount: 0, docHighWater: {}, appVersion: '0.2.0' })
  })
})

describe('resyncPage', () => {
  // The corpus is read, never verified, by this helper — plain fixtures are
  // exactly what a real innerEvents map holds after a persist round trip.
  function corpus(n: number): Record<string, NostrEvent> {
    const m: Record<string, NostrEvent> = {}
    for (let i = 0; i < n; i += 1) {
      const id = `ev-${String(i).padStart(4, '0')}`
      m[id] = { id, pubkey: guardian.pk, created_at: 1000 + i, kind: KIND_ENTRY, tags: [], content: '{}', sig: 'x'.repeat(128) }
    }
    return m
  }

  const big: AppState = { ...childState, innerEvents: corpus(150) }

  it('returns at most RESYNC_PAGE_SIZE events and flags that more remain', () => {
    const page0 = resyncPage(big, null, 0)
    expect(page0.events).toHaveLength(RESYNC_PAGE_SIZE)
    expect(page0.page).toBe(0)
    expect(page0.more).toBe(true)
    expect(page0.events[0]!.id).toBe('ev-0000')
  })

  it('serves the remainder on the next page and stops flagging more', () => {
    const page1 = resyncPage(big, null, 1)
    expect(page1.events).toHaveLength(50)
    expect(page1.page).toBe(1)
    expect(page1.more).toBe(false)
    expect(page1.events[0]!.id).toBe('ev-0100')
  })

  it('resumes strictly after the cursor event', () => {
    const page = resyncPage(big, 'ev-0099', 0)
    expect(page.events).toHaveLength(50)
    expect(page.events[0]!.id).toBe('ev-0100')
    expect(page.more).toBe(false)
  })

  it('sends from the start when the cursor is unknown', () => {
    expect(resyncPage(big, 'e-a-ledger-entry-id', 0).events[0]!.id).toBe('ev-0000')
  })

  it('does NOT treat a ledger entry id as a cursor — it replays from the start', () => {
    // Review fix: the corpus and the ledger sort by different keys, so a
    // ledger-derived cursor could sit after an event we never received and
    // hide it for ever. Only an inner EVENT id is a cursor now; anything
    // else means "send me everything".
    const ev = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryFixture))
    const app: AppState = { ...childState, innerEvents: { [ev.id]: ev, ...corpus(3) } }
    const page = resyncPage(app, entryFixture.id, 0)
    expect(page.events).toHaveLength(4)
    expect(page.events.some((e) => e.id === ev.id)).toBe(true)
  })

  it('is empty and final past the end of the corpus', () => {
    const page = resyncPage(big, null, 2)
    expect(page.events).toEqual([])
    expect(page.more).toBe(false)
  })

  it('orders by created_at then id', () => {
    const app: AppState = {
      ...childState,
      innerEvents: {
        b: { id: 'b', pubkey: guardian.pk, created_at: 10, kind: KIND_ENTRY, tags: [], content: '{}', sig: 'x' },
        a: { id: 'a', pubkey: guardian.pk, created_at: 10, kind: KIND_ENTRY, tags: [], content: '{}', sig: 'x' },
        c: { id: 'c', pubkey: guardian.pk, created_at: 5, kind: KIND_ENTRY, tags: [], content: '{}', sig: 'x' },
      },
    }
    expect(resyncPage(app, null, 0).events.map((e) => e.id)).toEqual(['c', 'a', 'b'])
  })
})

// ============================================================================
// The paged-exchange cursor — the bound on a hostile peer (spec §2.2)
// ============================================================================

describe('nextResyncCursor', () => {
  const reply = (more: boolean, ids: string[]) =>
    buildResyncReplyPayload({
      events: ids.map((id) => ({ id, pubkey: guardian.pk, created_at: 1, kind: KIND_ENTRY, tags: [], content: '{}', sig: 'x' })),
      page: 0,
      more,
    })

  it('is the last event of the page while more remain', () => {
    expect(nextResyncCursor(reply(true, ['a', 'b']), 1)).toBe('b')
  })

  it('stops once the peer says there is nothing more', () => {
    expect(nextResyncCursor(reply(false, ['a']), 1)).toBeNull()
  })

  it('stops at the page cap however much a peer claims to have', () => {
    expect(nextResyncCursor(reply(true, ['a']), RESYNC_MAX_PAGES)).toBeNull()
  })

  it('stops on an empty page that still claims more, rather than looping forever', () => {
    expect(nextResyncCursor(reply(true, []), 1)).toBeNull()
  })

  it('caps an exchange at ten pages and heartbeats hourly', () => {
    expect(RESYNC_MAX_PAGES).toBe(10)
    expect(STATUS_INTERVAL_MS).toBe(60 * 60_000)
  })
})

// ============================================================================
// Fix round 1 — per-child scoping (review CRITICAL)
//
// A guardian's corpus holds every child's events. Serving all of it to
// whichever child asked put sibling data on that child's device AND made the
// two ends permanently disagree: the child's status then counted sibling
// entries while the guardian's own view is scoped per child, so
// `compareStatus` answered 'request-resync' every hour, forever. Both ends
// are fixed — the guardian serves one child's slice, the child refuses an
// entry that is not its own, and both count the same scoped set.
// ============================================================================

describe('resyncPage — scoped to one child', () => {
  const childB = makeKeypair()
  const entryA = entryAt('e-for-a', child.pk, 1000)
  const entryB = entryAt('e-for-b', childB.pk, 1001)

  const evEntryA = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryA), 1000)
  const evEntryB = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryB), 1001)
  const evTickA = mkInner(child.sk, KIND_CHILD_SIG, buildChildTickPayload(tickFixture), 1002)
  const evTickB = mkInner(childB.sk, KIND_CHILD_SIG, buildChildTickPayload({ ...tickFixture, id: 't-b' }), 1003)
  const evConfig = mkInner(guardian.sk, KIND_CONFIG, buildConfigPayload('chores', choresDoc), 1004)
  const evGrant = mkInner(guardian.sk, KIND_GRANT, { v: 1, reqId: 'r1', nonce: 'n1', decision: 'allow', ts: 1005, params: {} }, 1005)
  const evGrantB = mkInner(guardian.sk, KIND_GRANT, { v: 1, reqId: 'r-b', nonce: 'n2', decision: 'deny', ts: 1005, params: {} }, 1005)
  const ask = (reqId: string, pk: string) => ({
    request: { v: 1 as const, op: 'spend.request' as const, reqId, nonce: 'n', child: pk, ts: 1, params: { amountMinor: 1, currency: 'GBP', account: 'a' } },
    authorPk: pk,
    status: 'approved' as const,
    createdAt: 1,
  })
  const evUnreadable = mkInner(guardian.sk, KIND_ENTRY, { v: 99, from: 'a newer build' }, 1006)

  const corpusOf = (evs: typeof evEntryA[]) => Object.fromEntries(evs.map((e) => [e.id, e]))
  const app: AppState = {
    ...guardianState,
    children: [
      { pubkey: child.pk, name: 'Alex', index: 0 },
      { pubkey: childB.pk, name: 'Sam', index: 1 },
    ],
    requests: [ask('r1', child.pk), ask('r-b', childB.pk)],
    innerEvents: corpusOf([evEntryA, evEntryB, evTickA, evTickB, evConfig, evGrant, evGrantB, evUnreadable]),
  }

  it('serves that child s entries, ticks and grants, and nothing of a sibling s', () => {
    const ids = resyncPage(app, null, 0, child.pk).events.map((e) => e.id)
    expect(ids).toContain(evEntryA.id)
    expect(ids).toContain(evTickA.id)
    // CONFIG is withheld: a child's docs reach it by snapshot, narrowed.
    expect(ids).not.toContain(evConfig.id)
    expect(ids).toContain(evGrant.id)
    expect(ids).not.toContain(evEntryB.id)
    expect(ids).not.toContain(evTickB.id)
    // A sibling's GRANT is withheld too.
    expect(ids).not.toContain(evGrantB.id)
  })

  it('withholds an ENTRY it cannot read, rather than guessing whose it is', () => {
    expect(resyncPage(app, null, 0, child.pk).events.map((e) => e.id)).not.toContain(evUnreadable.id)
  })

  it('serves the whole corpus when no child is named (a child replying to its guardian)', () => {
    expect(resyncPage(app, null, 0, null).events).toHaveLength(8)
  })

  it('pages the SCOPED set, so more never reflects a sibling s events', () => {
    const page = resyncPage(app, null, 0, child.pk)
    expect(page.more).toBe(false)
    expect(page.events).toHaveLength(3)
  })
})

describe('ingestResyncEvents — a child refuses an entry that is not its own', () => {
  const sibling = makeKeypair()
  const siblingEntry = entryAt('e-sibling', sibling.pk, 1000)

  it('rejects it as out of scope and does not store it', () => {
    const r = ingestResyncEvents(childState, [mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(siblingEntry))], {
      peerPk: guardian.pk,
      nowSec: 2000,
    })
    expect(r.rejected[0]!.reason).toBe('scope')
    expect(r.state).toBe(childState)
    expect(r.state.innerEvents).toEqual({})
  })

  it('still accepts its own', () => {
    const own = entryAt('e-own', child.pk, 1000)
    const r = ingestResyncEvents(childState, [mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(own))], {
      peerPk: guardian.pk,
      nowSec: 2000,
    })
    expect(r.accepted).toBe(1)
  })

  it('does not apply the scope rule on a guardian, which legitimately holds every child s entries', () => {
    // Authored by the GUARDIAN — the only author allowed to write an entry
    // for a child other than itself (item I2's provenance guard, below).
    const r = ingestResyncEvents(withAccountsFor(guardianState, child.pk, sibling.pk), [mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(siblingEntry))], {
      peerPk: child.pk,
      nowSec: 2000,
    })
    expect(r.accepted).toBe(1)
  })

  // Audit P1 on the REPLAY path: ENTRY is guardian-only, so a child-signed
  // one fails the AUTHOR rule — refused before it is stored, since a corpus
  // must not keep (and later hand on) an event no device may fold.
  it('refuses a child-authored ENTRY naming a sibling at the author rule, and does not store it', () => {
    const r = ingestResyncEvents(guardianState, [mkInner(child.sk, KIND_ENTRY, buildEntryPayload(siblingEntry))], {
      peerPk: child.pk,
      nowSec: 2000,
    })
    expect(r.accepted).toBe(0)
    expect(r.rejected.map((x) => x.reason)).toEqual(['author'])
    expect(r.state.entries).toEqual([])
    expect(r.state.innerEvents).toEqual({})
  })

  it('refuses a child-signed credit to itself labelled author guardian — no minting on replay (audit P1)', () => {
    const forged = { ...entryFixture, id: 'forged-replay', legs: [{ account: account.id, currency: 'GBP', amountMinor: 1_000_000 }] }
    const r = ingestResyncEvents(guardianState, [mkInner(child.sk, KIND_ENTRY, buildEntryPayload(forged))], {
      peerPk: child.pk,
      nowSec: 2000,
    })
    expect(r.rejected.map((x) => x.reason)).toEqual(['author'])
    expect(r.state.entries).toEqual([])
  })
})

describe('ingestResyncEvents — deferral (audit P1/P3)', () => {
  it('defers a guardian ENTRY on an account whose doc has not arrived: not stored, not seen, folded on a later replay', () => {
    const fresh: AppState = { ...childState, docs: emptyState().docs }
    const ev = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryFixture))
    const first = ingestResyncEvents(fresh, [ev], { peerPk: guardian.pk, nowSec: 2000 })
    expect(first.rejected.map((x) => x.reason)).toEqual(['deferred'])
    expect(first.state.innerEvents).toEqual({})
    expect(first.state.seenEventIds).not.toContain(ev.id)

    const accountsEv = mkInner(guardian.sk, KIND_CONFIG, buildConfigPayload('accounts', { v: 1, issuedAt: 5, accounts: [account] }), AT - 1)
    const later = ingestResyncEvents(first.state, [accountsEv, ev], { peerPk: guardian.pk, nowSec: 2000 })
    expect(later.accepted).toBe(2)
    expect(later.state.entries).toEqual([entryFixture])
  })
})

describe('convergence: a fully synced child reports ok, hour after hour', () => {
  const childB = makeKeypair()
  const guardianApp: AppState = {
    ...guardianState,
    entries: [entryAt('e-a1', child.pk, 1000), entryAt('e-b1', childB.pk, 1001), entryAt('e-a2', child.pk, 1002)],
    docHighWater: { chores: 900 },
  }
  // Everything of A's, and nothing of B's — what the scoped resyncPage above
  // actually delivers.
  const childApp: AppState = {
    ...childState,
    entries: [entryAt('e-a1', child.pk, 1000), entryAt('e-a2', child.pk, 1002)],
    docHighWater: { chores: 900 },
  }

  it('is ok in both directions once the child holds its own slice', () => {
    const local = statusFor(guardianApp, child.pk, '0.2.0', 5000)
    const remote = statusFor(childApp, child.pk, '0.2.0', 5000)
    expect(compareStatus(local, remote).kind).toBe('ok')
  })

  it('stays ok even when the child still holds a sibling entry from an old family snapshot', () => {
    const withSibling: AppState = { ...childApp, entries: [...childApp.entries, entryAt('e-b1', childB.pk, 1001)] }
    const remote = statusFor(withSibling, child.pk, '0.2.0', 5000)
    expect(compareStatus(statusFor(guardianApp, child.pk, '0.2.0', 5000), remote).kind).toBe('ok')
  })
})

describe('the first request of an exchange must carry a null cursor', () => {
  // The corpus is ordered by event created_at/id; `status.lastEntryId` is
  // ordered by LEDGER createdAt/id. The two orders are not the same, so a
  // cursor taken from the ledger can sit AFTER an event we are missing —
  // which would then never be sent, at any hour, forever.
  it('delivers an early-sorting CONFIG that a mid-corpus cursor would skip', () => {
    const early = mkInner(guardian.sk, KIND_CONFIG, buildConfigPayload('chores', choresDoc), 10)
    const later = mkInner(guardian.sk, KIND_ENTRY, buildEntryPayload(entryFixture), 500)
    const app: AppState = { ...childState, innerEvents: { [early.id]: early, [later.id]: later } }

    expect(resyncPage(app, null, 0).events.map((e) => e.id)).toContain(early.id)
    expect(resyncPage(app, later.id, 0).events.map((e) => e.id)).not.toContain(early.id)
  })
})

describe('acksFor', () => {
  it('acks only the entries the replaying peer itself authored', () => {
    const effects: Effect[] = [
      { type: 'ack', entryId: 'e1', authorPk: 'peer' },
      { type: 'ack', entryId: 'e2', authorPk: 'someone-else' },
      { type: 'entry', entry: entryFixture, authorPk: 'peer' },
    ]
    expect(acksFor(effects, 'peer')).toEqual(['e1'])
  })

  it('is empty when nothing was ingested', () => {
    expect(acksFor([], 'peer')).toEqual([])
  })
})

// ============================================================================
// Fix round 1 — rate limiting inbound heartbeat/resync traffic (review)
//
// Every inbound `status` costs a full snapshot wrap or a fresh exchange, and
// a fresh exchange resets the requester's page counter — so the 10-page cap
// bounded one exchange while the exchange RATE was the peer's to choose.
// Both are now gated on a minimum gap, and the SERVING side counts pages of
// its own so a peer cannot open an exchange and then page for ever.
// ============================================================================

describe('statusAccepted', () => {
  it('accepts a peer never heard from', () => {
    expect(statusAccepted(new Map(), 'p', 1000)).toBe(true)
  })

  it('ignores a second status inside the gap, and accepts it at the boundary', () => {
    const seen = new Map([['p', 1000]])
    expect(statusAccepted(seen, 'p', 1000 + 1799, 1800)).toBe(false)
    expect(statusAccepted(seen, 'p', 1000 + 1800, 1800)).toBe(true)
  })

  it('gates each peer separately', () => {
    const seen = new Map([['p', 1000]])
    expect(statusAccepted(seen, 'other', 1000, 1800)).toBe(true)
  })

  it('defaults to half the heartbeat interval', () => {
    expect(STATUS_INTERVAL_SECS).toBe(3600)
    const seen = new Map([['p', 0]])
    expect(statusAccepted(seen, 'p', STATUS_INTERVAL_SECS / 2 - 1)).toBe(false)
    expect(statusAccepted(seen, 'p', STATUS_INTERVAL_SECS / 2)).toBe(true)
  })
})

describe('servesResyncPage', () => {
  it('opens an exchange on a null cursor and counts the first page', () => {
    const r = servesResyncPage(undefined, null, 1000, 1800)
    expect(r.serve).toBe(true)
    expect(r.exchange).toEqual({ startedAt: 1000, pagesServed: 1 })
  })

  it('refuses a second exchange inside the gap, keeping the one in progress', () => {
    const open = { startedAt: 1000, pagesServed: 1 }
    const r = servesResyncPage(open, null, 1500, 1800)
    expect(r.serve).toBe(false)
    expect(r.exchange).toBe(open)
  })

  it('allows a fresh exchange once the gap has passed, resetting the count', () => {
    const r = servesResyncPage({ startedAt: 1000, pagesServed: 9 }, null, 2800, 1800)
    expect(r.serve).toBe(true)
    expect(r.exchange).toEqual({ startedAt: 2800, pagesServed: 1 })
  })

  it('serves continuation pages of an open exchange without waiting out the gap', () => {
    const r = servesResyncPage({ startedAt: 1000, pagesServed: 1 }, 'ev-1', 1001, 1800)
    expect(r.serve).toBe(true)
    expect(r.exchange).toEqual({ startedAt: 1000, pagesServed: 2 })
  })

  it('stops serving once the exchange has run to the page cap', () => {
    const spent = { startedAt: 1000, pagesServed: RESYNC_MAX_PAGES }
    const r = servesResyncPage(spent, 'ev-1', 1001, 1800)
    expect(r.serve).toBe(false)
    expect(r.exchange).toBe(spent)
  })

  it('refuses a continuation with no exchange open — a peer must ask from the start', () => {
    expect(servesResyncPage(undefined, 'ev-1', 1000, 1800).serve).toBe(false)
  })
})

describe('catchUpDue (v0.3 child catch-up)', () => {
  it('allows the first ask, then no more than the guardian s own status gap', () => {
    expect(catchUpDue(undefined, AT)).toBe(true)
    expect(catchUpDue(AT, AT + STATUS_INTERVAL_SECS / 2 - 1)).toBe(false)
    expect(catchUpDue(AT, AT + STATUS_INTERVAL_SECS / 2)).toBe(true)
  })
})

describe('compareStatus settles entries before docs (review R6)', () => {
  it('asks for a resync when the peer has more entries, even though it is behind on a doc', () => {
    const local = { entryCount: 1, lastEntryId: 'e1', docHighWater: { chores: 900 } }
    expect(compareStatus(local, st(3, 'e3', { chores: 100 }))).toEqual({ kind: 'request-resync' })
  })
})
