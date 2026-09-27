import { describe, it, expect } from 'vitest'
import vectorsRaw from './vectors/wire-v1.json'
import {
  KIND_REQUEST,
  KIND_GRANT,
  KIND_STATUS,
  KIND_PAIR_OFFER,
  KIND_ENTRY,
  KIND_CONFIG,
  KIND_SNAPSHOT,
  KIND_ACK,
  KIND_CHILD_SIG,
  KIND_VAULT,
  SEAL,
  WRAP,
  MARKER_TAG,
} from './kinds'
import {
  buildEntryPayload,
  parseEntryPayload,
  buildConfigPayload,
  parseConfigPayload,
  buildRequestPayload,
  parseRequestPayload,
  buildGrantPayload,
  parseGrantPayload,
  buildAckPayload,
  parseAckPayload,
  buildSnapshotPayload,
  parseSnapshotPayload,
  buildCheckpointPayload,
  parseCheckpointPayload,
  parseSnapshotOrCheckpointPayload,
  buildChildTickPayload,
  buildChildAuditPayload,
  parseChildSigPayload,
  buildPairOfferPayload,
  parsePairOfferPayload,
  buildVaultPayload,
  parseVaultPayload,
  buildStatusPayload,
  buildResyncRequestPayload,
  buildResyncReplyPayload,
  parseStatusKindPayload,
  RESYNC_PAGE_SIZE,
  RESYNC_MAX_EVENTS_PER_REPLY,
} from './payloads'
import type { Entry } from '../domain/types'
import type { ChoreTick } from '../domain/chores'
import type { AuditResult } from '../domain/audit'

// --- kinds -------------------------------------------------------------------

describe('kinds', () => {
  it('matches the plan Global Constraints kind table', () => {
    expect(SEAL).toBe(13)
    expect(WRAP).toBe(1059)
    expect(KIND_REQUEST).toBe(31111)
    expect(KIND_GRANT).toBe(31112)
    expect(KIND_STATUS).toBe(31114)
    expect(KIND_PAIR_OFFER).toBe(31117)
    expect(KIND_ENTRY).toBe(31120)
    expect(KIND_CONFIG).toBe(31121)
    expect(KIND_SNAPSHOT).toBe(31122)
    expect(KIND_ACK).toBe(31123)
    expect(KIND_CHILD_SIG).toBe(31124)
    expect(KIND_VAULT).toBe(31125)
  })

  it('MARKER_TAG is the name-free relay filter tag', () => {
    expect(MARKER_TAG).toEqual(['t', 'kin-jar'])
  })

  it('no wire constant mentions the app by name', () => {
    const values = [SEAL, WRAP, KIND_REQUEST, KIND_GRANT, KIND_STATUS, KIND_PAIR_OFFER, KIND_ENTRY, KIND_CONFIG, KIND_SNAPSHOT, KIND_ACK, KIND_CHILD_SIG, KIND_VAULT, ...MARKER_TAG]
    for (const v of values) expect(String(v).toLowerCase()).not.toContain('kinterest')
  })
})

// --- golden vectors ------------------------------------------------------------

type ParserName =
  | 'entry'
  | 'config'
  | 'request'
  | 'grant'
  | 'ack'
  | 'snapshot'
  | 'checkpoint'
  | 'childSig'
  | 'pairOffer'
  | 'vault'
  | 'statusKind'

const PARSERS: Record<ParserName, (json: unknown) => unknown> = {
  entry: parseEntryPayload,
  config: parseConfigPayload,
  request: parseRequestPayload,
  grant: parseGrantPayload,
  ack: parseAckPayload,
  snapshot: parseSnapshotPayload,
  checkpoint: parseCheckpointPayload,
  childSig: parseChildSigPayload,
  pairOffer: parsePairOfferPayload,
  vault: parseVaultPayload,
  statusKind: parseStatusKindPayload,
}

interface Vector {
  name: string
  payload: ParserName
  valid?: { input: unknown; expected: unknown }
  malformed: unknown
  malformedOnly?: boolean
  /** The twin is well-formed ON THE WIRE and is refused a layer up (fix
   *  round 2, item C1: a vault carrying a root attestation signed by
   *  somebody else's Signet key). The parser is not the gate — it checks
   *  shape, never a signature — so asserting `null` here would be asserting
   *  the wrong thing in the wrong place. `identity/signetVault.test.ts`
   *  reads the same vector and asserts the rejection where it happens. */
  selectionOnly?: boolean
}

const vectorsFile = vectorsRaw as unknown as { note: string; vectors: Vector[] }

describe('wire-v1 golden vectors', () => {
  it('the vectors file is present, non-empty and carries its frozen-file note', () => {
    expect(vectorsFile.vectors.length).toBeGreaterThan(0)
    expect(vectorsFile.note).toMatch(/frozen/i)
  })

  it('no vector mentions the app by name', () => {
    expect(JSON.stringify(vectorsFile).toLowerCase()).not.toContain('kinterest')
  })

  for (const v of vectorsFile.vectors) {
    const parser = PARSERS[v.payload]

    if (v.valid) {
      const { input, expected } = v.valid
      it(`${v.name}: valid vector parses to deep-equal (extra unknown fields ignored, not rejected)`, () => {
        expect(parser(input)).toEqual(expected)
      })
    }

    if (v.selectionOnly) {
      it(`${v.name}: malformed twin still PARSES — it is refused at the selection layer, not here`, () => {
        expect(parser(v.malformed)).not.toBeNull()
      })
      continue
    }

    it(`${v.name}: malformed twin parses to null`, () => {
      expect(parser(v.malformed)).toBeNull()
    })
  }
})

// --- total-parser robustness (never throws, even on nonsense) -----------------

const ALL_PARSERS = Object.values(PARSERS)
const NONSENSE: unknown[] = [null, undefined, 42, 'hello', [], {}, { v: 2 }, { v: 1, kind: 'nope' }, () => {}]

describe('total parsers', () => {
  for (const parser of ALL_PARSERS) {
    for (const bad of NONSENSE) {
      it(`${parser.name} never throws on ${JSON.stringify(bad) ?? String(bad)}`, () => {
        expect(() => parser(bad)).not.toThrow()
      })
    }
  }

  it('parseSnapshotOrCheckpointPayload dispatches by kind and is total', () => {
    const { input: snapshotInput, expected: snapshotExpected } = vectorsFile.vectors.find(
      (v) => v.name === 'snapshot',
    )!.valid!
    expect(parseSnapshotOrCheckpointPayload(snapshotInput)).toEqual(snapshotExpected)

    const { input: checkpointInput, expected: checkpointExpected } = vectorsFile.vectors.find(
      (v) => v.name === 'checkpoint',
    )!.valid!
    expect(parseSnapshotOrCheckpointPayload(checkpointInput)).toEqual(checkpointExpected)

    expect(parseSnapshotOrCheckpointPayload({ v: 1, kind: 'bogus' })).toBeNull()
    expect(parseSnapshotOrCheckpointPayload(null)).toBeNull()
  })
})

// --- builders round-trip through their own parser -------------------------------

const entry: Entry = {
  v: 1,
  id: 'e-build-1',
  child: 'sam',
  kind: 'credit',
  createdAt: 1700000000,
  author: 'guardian',
  legs: [{ account: 'a-ledger', currency: 'GBP', amountMinor: 500 }],
}

describe('builders', () => {
  it('buildEntryPayload round-trips through parseEntryPayload', () => {
    const built = buildEntryPayload(entry)
    expect(parseEntryPayload(built)).toEqual(built)
  })

  it('buildConfigPayload round-trips through parseConfigPayload', () => {
    const built = buildConfigPayload('accounts', { v: 1, issuedAt: 1700000000, accounts: [] })
    expect(parseConfigPayload(built)).toEqual(built)
  })

  it('buildRequestPayload round-trips through parseRequestPayload', () => {
    const built = buildRequestPayload({
      op: 'allowance.claim',
      reqId: 'r1',
      nonce: 'n1',
      child: 'sam',
      ts: 1700000000,
      params: { periodKey: '2026-W33' },
    })
    expect(parseRequestPayload(built)).toEqual(built)
  })

  // Account.auditCadence (domain/types.ts, Plan 3 Task 6) is additive and
  // optional, but a PRESENT value must be checked to the same closed-set
  // convention every other typed field on an account shape already follows
  // (found by review: isAccountShape previously accepted ANY value here).
  it('parseConfigPayload accepts a well-formed accounts doc with auditCadence set or absent', () => {
    const withCadence = buildConfigPayload('accounts', {
      v: 1,
      issuedAt: 1700000000,
      accounts: [
        { id: 'a1', child: 'sam', name: 'Pocket money', currency: 'GBP', custody: 'ledger', auditCadence: 'weekly' },
        { id: 'a2', child: 'sam', name: 'Savings', currency: 'GBP', custody: 'ledger', auditCadence: 'monthly' },
        { id: 'a3', child: 'sam', name: 'Cash', currency: 'GBP', custody: 'physical' },
      ],
    })
    expect(parseConfigPayload(withCadence)).toEqual(withCadence)
  })

  it('parseConfigPayload rejects an accounts doc whose auditCadence is not weekly/monthly/absent', () => {
    const malformed = buildConfigPayload('accounts', {
      v: 1,
      issuedAt: 1700000000,
      accounts: [{ id: 'a1', child: 'sam', name: 'Pocket money', currency: 'GBP', custody: 'ledger', auditCadence: 'daily' }],
    })
    expect(parseConfigPayload(malformed)).toBeNull()

    const notAString = buildConfigPayload('accounts', {
      v: 1,
      issuedAt: 1700000000,
      accounts: [{ id: 'a1', child: 'sam', name: 'Pocket money', currency: 'GBP', custody: 'ledger', auditCadence: 1 }],
    })
    expect(parseConfigPayload(notAString)).toBeNull()
  })

  it('buildGrantPayload round-trips through parseGrantPayload', () => {
    const built = buildGrantPayload({ reqId: 'r1', nonce: 'n1', decision: 'deny', ts: 1700000000, params: {} })
    expect(parseGrantPayload(built)).toEqual(built)
  })

  it('buildAckPayload round-trips through parseAckPayload', () => {
    const built = buildAckPayload('e1', 1700000000)
    expect(parseAckPayload(built)).toEqual(built)
  })

  it('buildSnapshotPayload round-trips through parseSnapshotPayload', () => {
    const built = buildSnapshotPayload({
      children: [],
      entries: [entry],
      docs: {
        accounts: { v: 1, issuedAt: 1700000000, accounts: [] },
        allowance: { v: 1, issuedAt: 1700000000, configs: [] },
        interest: { v: 1, issuedAt: 1700000000, configs: [] },
        chores: { v: 1, issuedAt: 1700000000, chores: [] },
      },
    })
    expect(parseSnapshotPayload(built)).toEqual(built)
  })

  it('buildCheckpointPayload round-trips through parseCheckpointPayload', () => {
    const built = buildCheckpointPayload({ balances: { 'a-ledger': 500 }, lastEntryId: 'e1', ts: 1700000000 })
    expect(parseCheckpointPayload(built)).toEqual(built)
  })

  it('buildChildTickPayload / buildChildAuditPayload round-trip through parseChildSigPayload', () => {
    const tick: ChoreTick = { id: 't1', chore: 'c1', day: '2026-08-10', at: 1700000000 }
    const builtTick = buildChildTickPayload(tick)
    expect(parseChildSigPayload(builtTick)).toEqual(builtTick)

    const audit: AuditResult = {
      id: 'a1',
      account: 'a-box',
      child: 'sam',
      countedMinor: 1000,
      expectedMinor: 950,
      deltaMinor: 50,
      at: 1700000000,
      author: 'child',
    }
    const builtAudit = buildChildAuditPayload(audit)
    expect(parseChildSigPayload(builtAudit)).toEqual(builtAudit)
  })

  it('buildPairOfferPayload round-trips through parsePairOfferPayload', () => {
    const snapshot = buildSnapshotPayload({
      children: [],
      entries: [],
      docs: {
        accounts: { v: 1, issuedAt: 1700000000, accounts: [] },
        allowance: { v: 1, issuedAt: 1700000000, configs: [] },
        interest: { v: 1, issuedAt: 1700000000, configs: [] },
        chores: { v: 1, issuedAt: 1700000000, chores: [] },
      },
    })
    const built = buildPairOfferPayload({
      childSkHex: '3'.repeat(64),
      childIndex: 1,
      name: 'Sam',
      relays: ['wss://relay.example.com'],
      snapshot,
    })
    expect(parsePairOfferPayload(built)).toEqual(built)
  })
})

// --- v0.2: vault, status and resync payloads -----------------------------------

describe('vault payload', () => {
  // The kind-21236 Signet root attestation every vault must now carry (fix
  // round 2, item C1). Only its SHAPE and kind matter to the parser — the
  // signature is checked a layer up, by `pickNewestVault`, against the
  // Signet identity actually being recovered into.
  const authEvent = {
    id: 'd'.repeat(64),
    pubkey: 'e'.repeat(64),
    created_at: 1756800000,
    kind: 21236,
    tags: [['challenge', 'f'.repeat(64)]],
    content: '',
    sig: '9'.repeat(128),
  }
  const good = {
    v: 1,
    type: 'vault',
    mnemonic: 'abandon about',
    guardianPk: 'a'.repeat(64),
    authEvent,
    createdAt: 1756800000,
  }
  // Orchestrator ruling R1: the vault carries the family roster, so `children`
  // and `relays` are part of the payload. They are ADDITIVE — absent on an
  // older producer's vault — and default to `[]` on parse, which is why the
  // parsed shape below is `good` plus the two empty lists rather than `good`.
  const parsedGood = { ...good, children: [], relays: [] }

  it('parses and ignores unknown fields', () => {
    expect(parseVaultPayload({ ...good, extra: 1 })).toEqual(parsedGood)
  })

  it('refuses a bad guardianPk, empty mnemonic, negative createdAt', () => {
    expect(parseVaultPayload({ ...good, guardianPk: 'zz' })).toBeNull()
    expect(parseVaultPayload({ ...good, mnemonic: '' })).toBeNull()
    expect(parseVaultPayload({ ...good, createdAt: -1 })).toBeNull()
  })

  // Item C1. `authEvent` is REQUIRED, and required with no legacy tolerance:
  // a vault that carries no attestation is a vault nobody can prove belongs
  // to the Signet identity it was addressed to, which is exactly the
  // hijack. Nothing has shipped, so there is no old producer to be kind to.
  it('refuses a vault with no attestation at all', () => {
    const { authEvent: _dropped, ...noAuth } = good
    expect(parseVaultPayload(noAuth)).toBeNull()
  })

  it('refuses an attestation that is not a kind-21236 event', () => {
    expect(parseVaultPayload({ ...good, authEvent: { ...authEvent, kind: 1 } })).toBeNull()
  })

  it('refuses half an event — every NIP-01 field must be there to verify later', () => {
    const { sig: _unsigned, ...halfAnEvent } = authEvent
    expect(parseVaultPayload({ ...good, authEvent: halfAnEvent })).toBeNull()
    expect(parseVaultPayload({ ...good, authEvent: null })).toBeNull()
    expect(parseVaultPayload({ ...good, authEvent: 'nope' })).toBeNull()
  })

  it('refuses an attestation whose id or author is not 64 hex', () => {
    expect(parseVaultPayload({ ...good, authEvent: { ...authEvent, id: 'zz' } })).toBeNull()
    expect(parseVaultPayload({ ...good, authEvent: { ...authEvent, pubkey: 'zz' } })).toBeNull()
  })

  it('keeps a well-formed roster and relay list (R1)', () => {
    const withRoster = {
      ...good,
      children: [{ pubkey: 'b'.repeat(64), name: 'Alex', index: 0 }],
      relays: ['wss://relay.example.com'],
    }
    expect(parseVaultPayload(withRoster)).toEqual(withRoster)
  })

  it('refuses a present-but-malformed roster or relay list', () => {
    expect(parseVaultPayload({ ...good, children: [{ pubkey: 'b'.repeat(64) }] })).toBeNull()
    expect(parseVaultPayload({ ...good, children: 'nope' })).toBeNull()
    expect(parseVaultPayload({ ...good, relays: ['http://relay.example'] })).toBeNull()
  })

  // Phase A review follow-up: a vault must never fail its own parser at
  // recovery time. `relays` is the one field the caller hands over straight
  // from `AppState`, where a hand-edited or migrated entry can be anything.
  it('buildVaultPayload filters relays to wss:// / ws:// so a vault always re-parses', () => {
    const built = buildVaultPayload({
      mnemonic: 'abandon about',
      guardianPk: 'a'.repeat(64),
      authEvent,
      children: [],
      relays: ['wss://relay.example.com', 'http://relay.example', '', 'ws://localhost:7000'],
      createdAt: 1756800000,
    })
    expect(built.relays).toEqual(['wss://relay.example.com', 'ws://localhost:7000'])
    expect(parseVaultPayload(built)).toEqual(built)
  })

  it('buildVaultPayload round-trips through parseVaultPayload', () => {
    const built = buildVaultPayload({
      mnemonic: 'abandon about',
      guardianPk: 'a'.repeat(64),
      authEvent,
      children: [{ pubkey: 'b'.repeat(64), name: 'Alex', index: 0 }],
      relays: ['wss://relay.example.com'],
      createdAt: 1756800000,
    })
    expect(parseVaultPayload(built)).toEqual(built)
  })
})

describe('kind-31114 union parser', () => {
  it('dispatches on type', () => {
    const s = { v: 1, type: 'status', at: 10, lastEntryId: null, entryCount: 0, docHighWater: {}, appVersion: '0.2.0' }
    expect(parseStatusKindPayload(s)).toEqual(s)
    expect(parseStatusKindPayload({ v: 1, type: 'resync.request', since: null })).toEqual({ v: 1, type: 'resync.request', since: null })
    expect(parseStatusKindPayload({ v: 1, type: 'resync.reply', events: [], page: 0, more: false }))
      .toEqual({ v: 1, type: 'resync.reply', events: [], page: 0, more: false })
  })

  it('refuses an unknown type, a non-integer entryCount, an oversized reply', () => {
    expect(parseStatusKindPayload({ v: 1, type: 'nope' })).toBeNull()
    expect(parseStatusKindPayload({ v: 1, type: 'status', at: 10, lastEntryId: null, entryCount: '3', docHighWater: {}, appVersion: 'x' })).toBeNull()
    const many = Array.from({ length: RESYNC_MAX_EVENTS_PER_REPLY + 1 }, () => ({
      id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 1, kind: 31120, tags: [], content: '{}', sig: 'c'.repeat(128) }))
    expect(parseStatusKindPayload({ v: 1, type: 'resync.reply', events: many, page: 0, more: false })).toBeNull()
  })

  it('refuses a malformed event inside a resync reply', () => {
    expect(parseStatusKindPayload({ v: 1, type: 'resync.reply', events: [{}], page: 0, more: false })).toBeNull()
    expect(parseStatusKindPayload({ v: 1, type: 'resync.reply', events: 'nope', page: 0, more: false })).toBeNull()
  })

  it('refuses a resync request whose `since` is neither null nor a non-empty string', () => {
    expect(parseStatusKindPayload({ v: 1, type: 'resync.request', since: 0 })).toBeNull()
    expect(parseStatusKindPayload({ v: 1, type: 'resync.request', since: '' })).toBeNull()
  })

  it('paging constants are the spec values', () => {
    expect(RESYNC_PAGE_SIZE).toBe(100)
    expect(RESYNC_MAX_EVENTS_PER_REPLY).toBe(200)
  })

  it('the three builders round-trip through the union parser', () => {
    const status = buildStatusPayload({
      at: 1756800000,
      lastEntryId: 'e1',
      entryCount: 3,
      docHighWater: { accounts: 1756800000 },
      appVersion: '0.2.0',
    })
    expect(parseStatusKindPayload(status)).toEqual(status)

    const req = buildResyncRequestPayload('e1')
    expect(parseStatusKindPayload(req)).toEqual(req)
    expect(buildResyncRequestPayload(null).since).toBeNull()

    const reply = buildResyncReplyPayload({ events: [], page: 2, more: true })
    expect(parseStatusKindPayload(reply)).toEqual(reply)
  })
})

// --- v0.2: root attestation on offers/snapshots, dismissed grants ---------------

describe('root attestation (spec §1.5)', () => {
  const att = {
    pubkey: 'a'.repeat(64),
    authEvent: {
      id: 'b'.repeat(64),
      pubkey: 'a'.repeat(64),
      kind: 21236,
      created_at: 1,
      tags: [],
      content: '',
      sig: 'c'.repeat(128),
    },
  }
  const offerFixture = vectorsFile.vectors.find((v) => v.name === 'pair-offer')!.valid!.input as Record<string, unknown>
  const snapshotFixture = vectorsFile.vectors.find((v) => v.name === 'snapshot')!.valid!.input as Record<string, unknown>

  it('a pair offer without root still parses (backward compatible)', () => {
    expect(parsePairOfferPayload(offerFixture)).not.toBeNull()
  })

  it('a pair offer with a well-shaped root keeps it', () => {
    expect(parsePairOfferPayload({ ...offerFixture, root: att })?.root).toEqual(att)
  })

  // Phase A review follow-up: the parser is a shape authority, and an event
  // with no `sig` is not event-shaped. Dropping it here keeps the consumer's
  // signature check from being handed something it cannot even reject
  // meaningfully.
  it('drops a root whose authEvent is not fully event-shaped (no sig)', () => {
    const { sig: _sig, ...noSig } = att.authEvent
    const parsed = parsePairOfferPayload({ ...offerFixture, root: { pubkey: att.pubkey, authEvent: noSig } })
    expect(parsed).not.toBeNull()
    expect(parsed?.root).toBeUndefined()
    const snap = parseSnapshotPayload({ ...snapshotFixture, root: { pubkey: att.pubkey, authEvent: { ...att.authEvent, tags: 'nope' } } })
    expect(snap).not.toBeNull()
    expect(snap?.root).toBeUndefined()
  })

  it('a pair offer with a malformed root drops the root, not the offer', () => {
    const parsed = parsePairOfferPayload({ ...offerFixture, root: { pubkey: 'zz', authEvent: att.authEvent } })
    expect(parsed).not.toBeNull()
    expect(parsed?.root).toBeUndefined()
  })

  it('a snapshot carries an optional root under the same rules', () => {
    expect(parseSnapshotPayload(snapshotFixture)?.root).toBeUndefined()
    expect(parseSnapshotPayload({ ...snapshotFixture, root: att })?.root).toEqual(att)
    const wrongKind = { ...att, authEvent: { ...att.authEvent, kind: 1 } }
    const parsed = parseSnapshotPayload({ ...snapshotFixture, root: wrongKind })
    expect(parsed).not.toBeNull()
    expect(parsed?.root).toBeUndefined()
  })

  it('builders thread an optional root through', () => {
    const state = {
      children: [],
      entries: [],
      docs: {
        accounts: { v: 1 as const, issuedAt: 1700000000, accounts: [] },
        allowance: { v: 1 as const, issuedAt: 1700000000, configs: [] },
        interest: { v: 1 as const, issuedAt: 1700000000, configs: [] },
        chores: { v: 1 as const, issuedAt: 1700000000, chores: [] },
      },
    }
    const snapshot = buildSnapshotPayload(state, att)
    expect(parseSnapshotPayload(snapshot)).toEqual(snapshot)
    expect(buildSnapshotPayload(state).root).toBeUndefined()

    const offer = buildPairOfferPayload({
      childSkHex: '3'.repeat(64),
      childIndex: 1,
      name: 'Alex',
      relays: ['wss://relay.example.com'],
      snapshot,
      root: att,
    })
    expect(parsePairOfferPayload(offer)).toEqual(offer)
  })
})

describe('dismissed grants (spec §4.3)', () => {
  it('a grant may be dismissed', () => {
    expect(parseGrantPayload({ v: 1, reqId: 'r', nonce: 'n', decision: 'dismissed', ts: 1, params: {} })?.decision).toBe(
      'dismissed',
    )
  })

  it('an unknown decision is still refused', () => {
    expect(parseGrantPayload({ v: 1, reqId: 'r', nonce: 'n', decision: 'maybe', ts: 1, params: {} })).toBeNull()
  })
})
