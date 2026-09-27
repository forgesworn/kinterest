import { describe, it, expect } from 'vitest'
import type { Entry } from '../domain/types'
import { buildGrantPayload, buildRequestPayload, type GrantPayload, type RequestPayload } from '../wire/payloads'
import type { ChoreTick } from '../domain/chores'
import type { AuditResult } from '../domain/audit'
import { emptyState, addEntry, applyConfigDoc, upsertRequest, recordRequestDecision, requestAlreadyDecided, recordGrantResult, recordTick, recordAudit, retainInnerEvents, activeChildren, configRecipients, selfRevokedAt, MAX_RETAINED_CHILD_SIG } from './state'

const entry = (id: string, overrides: Partial<Entry> = {}): Entry => ({
  v: 1,
  id,
  child: 'sam',
  kind: 'credit',
  createdAt: 1000,
  author: 'guardian',
  legs: [{ account: 'a-ledger', currency: 'GBP', amountMinor: 500 }],
  ...overrides,
})

describe('emptyState', () => {
  it('starts unset, with no children/entries and empty config docs at issuedAt 0', () => {
    const s = emptyState()
    expect(s.v).toBe(1)
    expect(s.role).toBe('unset')
    expect(s.guardianPubkey).toBeNull()
    expect(s.self).toEqual({ pubkey: null, childIndex: null })
    expect(s.children).toEqual([])
    expect(s.entries).toEqual([])
    expect(s.acks).toEqual({})
    expect(s.ticks).toEqual([])
    expect(s.audits).toEqual([])
    expect(s.requests).toEqual([])
    expect(s.docHighWater).toEqual({})
    expect(s.seenEventIds).toEqual([])
    expect(s.docs.accounts).toEqual({ v: 1, issuedAt: 0, accounts: [] })
    expect(s.docs.allowance).toEqual({ v: 1, issuedAt: 0, configs: [] })
    expect(s.docs.interest).toEqual({ v: 1, issuedAt: 0, configs: [] })
    expect(s.docs.chores).toEqual({ v: 1, issuedAt: 0, chores: [] })
  })

  it('two calls produce independent objects (no shared mutable state)', () => {
    const a = emptyState()
    const b = emptyState()
    expect(a).not.toBe(b)
    a.entries.push(entry('e1'))
    expect(b.entries).toEqual([])
  })
})

describe('addEntry', () => {
  it('appends a valid new entry immutably', () => {
    const s0 = emptyState()
    const s1 = addEntry(s0, entry('e1'))
    expect(s1).not.toBe(s0)
    expect(s1.entries).toEqual([entry('e1')])
    expect(s0.entries).toEqual([]) // s0 untouched
  })

  it('dedupes by id: a repeat returns the exact same state reference', () => {
    const s0 = emptyState()
    const s1 = addEntry(s0, entry('e1'))
    const s2 = addEntry(s1, entry('e1', { note: 'a different payload, same id' }))
    expect(s2).toBe(s1)
    expect(s2.entries).toHaveLength(1)
  })

  it('propagates assertEntry rejection for a malformed entry, leaving state untouched', () => {
    const s0 = emptyState()
    expect(() => addEntry(s0, entry('e1', { kind: 'bogus' as Entry['kind'] }))).toThrow(RangeError)
    expect(s0.entries).toEqual([])
  })

  it('propagates assertEntry rejection for an entry with zero legs', () => {
    const s0 = emptyState()
    expect(() => addEntry(s0, entry('e1', { legs: [] }))).toThrow(RangeError)
  })
})

describe('recordTick', () => {
  const tick = (id: string, overrides: Partial<ChoreTick> = {}): ChoreTick => ({
    id,
    chore: 'c1',
    day: '2026-08-10',
    at: 1000,
    ...overrides,
  })

  it('appends a fresh tick immutably', () => {
    const s0 = emptyState()
    const s1 = recordTick(s0, tick('tick:c1:2026-08-10'))
    expect(s1).not.toBe(s0)
    expect(s1.ticks).toEqual([tick('tick:c1:2026-08-10')])
    expect(s0.ticks).toEqual([]) // s0 untouched
  })

  it('dedupes by id: a repeat returns the exact same state reference', () => {
    const s0 = emptyState()
    const s1 = recordTick(s0, tick('tick:c1:2026-08-10'))
    const s2 = recordTick(s1, tick('tick:c1:2026-08-10', { at: 9999 }))
    expect(s2).toBe(s1)
    expect(s2.ticks).toHaveLength(1)
  })

  it('a different id for the same chore/day is a distinct tick (no cross-id dedupe)', () => {
    const s0 = emptyState()
    const s1 = recordTick(s0, tick('tick:c1:2026-08-10'))
    const s2 = recordTick(s1, tick('other-id'))
    expect(s2.ticks).toHaveLength(2)
  })
})

describe('recordAudit', () => {
  const audit = (id: string, overrides: Partial<AuditResult> = {}): AuditResult => ({
    id,
    account: 'a-box',
    child: 'sam',
    countedMinor: 767,
    expectedMinor: 767,
    deltaMinor: 0,
    at: 1000,
    author: 'child',
    ...overrides,
  })

  it('appends a fresh audit immutably', () => {
    const s0 = emptyState()
    const s1 = recordAudit(s0, audit('au1'))
    expect(s1).not.toBe(s0)
    expect(s1.audits).toEqual([audit('au1')])
    expect(s0.audits).toEqual([]) // s0 untouched
  })

  it('dedupes by id: a repeat returns the exact same state reference', () => {
    const s0 = emptyState()
    const s1 = recordAudit(s0, audit('au1'))
    const s2 = recordAudit(s1, audit('au1', { at: 9999, countedMinor: 1 }))
    expect(s2).toBe(s1)
    expect(s2.audits).toHaveLength(1)
  })

  it('a different id is a distinct audit (no cross-id dedupe)', () => {
    const s0 = emptyState()
    const s1 = recordAudit(s0, audit('au1'))
    const s2 = recordAudit(s1, audit('au2'))
    expect(s2.audits).toHaveLength(2)
  })
})

describe('applyConfigDoc', () => {
  const docAt = (issuedAt: number) => ({ v: 1 as const, issuedAt, accounts: [] })

  it('applies a doc newer than the high-water mark and updates it', () => {
    const s0 = emptyState()
    const doc = docAt(100)
    const s1 = applyConfigDoc(s0, 'accounts', doc)
    expect(s1).not.toBe(s0)
    expect(s1.docs.accounts).toEqual(doc)
    expect(s1.docHighWater.accounts).toBe(100)
  })

  it('applies a strictly later doc on top of an earlier one', () => {
    const s0 = emptyState()
    const s1 = applyConfigDoc(s0, 'accounts', docAt(100))
    const s2 = applyConfigDoc(s1, 'accounts', docAt(200))
    expect(s2.docs.accounts.issuedAt).toBe(200)
    expect(s2.docHighWater.accounts).toBe(200)
  })

  it('refuses an older doc (anti-rollback): state unchanged, same reference', () => {
    const s0 = emptyState()
    const s1 = applyConfigDoc(s0, 'accounts', docAt(200))
    const s2 = applyConfigDoc(s1, 'accounts', docAt(100))
    expect(s2).toBe(s1)
    expect(s2.docs.accounts.issuedAt).toBe(200)
  })

  it('refuses an equal-issuedAt doc (anti-rollback): state unchanged, same reference', () => {
    const s0 = emptyState()
    const s1 = applyConfigDoc(s0, 'accounts', docAt(200))
    const s2 = applyConfigDoc(s1, 'accounts', docAt(200))
    expect(s2).toBe(s1)
  })

  it('tracks high-water marks independently per doc kind', () => {
    const s0 = emptyState()
    const s1 = applyConfigDoc(s0, 'accounts', docAt(100))
    const s2 = applyConfigDoc(s1, 'allowance', { v: 1, issuedAt: 50, configs: [] })
    expect(s2.docHighWater).toEqual({ accounts: 100, allowance: 50 })
    expect(s2.docs.accounts.issuedAt).toBe(100)
    expect(s2.docs.allowance.issuedAt).toBe(50)
  })
})

// ============================================================================
// Request registry — AppState.requests (Task 5: Approvals inbox)
// ============================================================================

const CHILD = 'sam'

function req(reqId: string, overrides: Partial<RequestPayload> = {}): RequestPayload {
  return buildRequestPayload({
    op: 'spend.request',
    reqId,
    nonce: `n-${reqId}`,
    child: CHILD,
    ts: 1000,
    params: { amountMinor: 150, currency: 'GBP', account: 'acc1' },
    ...overrides,
  })
}

describe('upsertRequest', () => {
  it('records a freshly-seen request as pending', () => {
    const s0 = emptyState()
    const s1 = upsertRequest(s0, req('r1'), CHILD, 1000)
    expect(s1.requests).toHaveLength(1)
    expect(s1.requests[0]).toEqual({ request: req('r1'), authorPk: CHILD, status: 'pending', createdAt: 1000 })
  })

  it('a reqId already present (still pending) is left untouched — same state reference back', () => {
    const s0 = emptyState()
    const s1 = upsertRequest(s0, req('r1'), CHILD, 1000)
    const s2 = upsertRequest(s1, req('r1'), CHILD, 2000) // a later "arrival" of the same reqId
    expect(s2).toBe(s1)
  })

  // "relay replay must not resurrect" — the plan's binding rule, tested
  // explicitly: once a request has been decided, a replay of the ORIGINAL
  // wrap (same reqId arriving again) must never reset it back to 'pending'.
  it('replay-resurrection: a reqId already DECIDED is left untouched, never reset to pending', () => {
    const s0 = emptyState()
    const s1 = upsertRequest(s0, req('r1'), CHILD, 1000)
    const s2 = recordRequestDecision(s1, req('r1'), CHILD, 'denied', 1500)
    expect(s2.requests[0]!.status).toBe('denied')

    const replayed = upsertRequest(s2, req('r1'), CHILD, 9000) // the relay redelivers the same REQUEST wrap
    expect(replayed).toBe(s2) // untouched
    expect(replayed.requests[0]!.status).toBe('denied') // still denied, not reset to pending
  })

  it('provenance guard: authorPk must equal request.child, a mismatch is dropped', () => {
    const s0 = emptyState()
    const s1 = upsertRequest(s0, req('r1'), 'someone-else', 1000)
    expect(s1).toBe(s0)
    expect(s1.requests).toEqual([])
  })
})

describe('requestAlreadyDecided', () => {
  it('false for an unseen reqId', () => {
    expect(requestAlreadyDecided(emptyState(), 'r1')).toBe(false)
  })

  it('false while still pending', () => {
    const s1 = upsertRequest(emptyState(), req('r1'), CHILD, 1000)
    expect(requestAlreadyDecided(s1, 'r1')).toBe(false)
  })

  it('true once approved/denied/dismissed', () => {
    const s1 = recordRequestDecision(emptyState(), req('r1'), CHILD, 'approved', 1000)
    expect(requestAlreadyDecided(s1, 'r1')).toBe(true)
  })
})

describe('recordRequestDecision', () => {
  it('flips an existing pending record to the given status, stamping decidedAt', () => {
    const s1 = upsertRequest(emptyState(), req('r1'), CHILD, 1000)
    const s2 = recordRequestDecision(s1, req('r1'), CHILD, 'approved', 2000, 100)
    expect(s2.requests[0]).toEqual({ request: req('r1'), authorPk: CHILD, status: 'approved', createdAt: 1000, decidedAt: 2000, grantedAmountMinor: 100 })
  })

  it('creates an already-decided record when none existed yet (a direct caller that skipped upsertRequest)', () => {
    const s1 = recordRequestDecision(emptyState(), req('r1'), CHILD, 'denied', 2000)
    expect(s1.requests).toHaveLength(1)
    expect(s1.requests[0]!.status).toBe('denied')
    expect(s1.requests[0]!.createdAt).toBe(2000) // no earlier record to inherit createdAt from
  })

  // The carried defect this closes (SDD ledger, Task 3 -> Task 5
  // MUST-CARRY): "no idempotency check against request.reqId... answering
  // the same request twice... creates two ledger entries."
  it('idempotent: a reqId already decided is left untouched by a second call, even with a DIFFERENT status', () => {
    const s1 = recordRequestDecision(emptyState(), req('r1'), CHILD, 'approved', 1000, 150)
    const s2 = recordRequestDecision(s1, req('r1'), CHILD, 'denied', 2000) // a second, contradictory decision
    expect(s2).toBe(s1)
    expect(s2.requests[0]!.status).toBe('approved') // unchanged
  })

  it('provenance guard: authorPk must equal request.child, a mismatch is dropped', () => {
    const s0 = emptyState()
    const s1 = recordRequestDecision(s0, req('r1'), 'someone-else', 'denied', 1000)
    expect(s1).toBe(s0)
  })

  it('leaves other requests in the registry untouched', () => {
    const s1 = upsertRequest(emptyState(), req('r1'), CHILD, 1000)
    const s2 = upsertRequest(s1, req('r2'), CHILD, 1100)
    const s3 = recordRequestDecision(s2, req('r1'), CHILD, 'dismissed', 2000)
    expect(s3.requests.find((r) => r.request.reqId === 'r2')!.status).toBe('pending')
  })
})

// ============================================================================
// recordGrantResult — the child device's own fold of an inbound GRANT into
// state.requests. See internal plan 2026-08-11-child-mode,
// Task 1.
// ============================================================================

describe('recordGrantResult', () => {
  const grant = (reqId: string, overrides: Partial<GrantPayload> = {}): GrantPayload =>
    buildGrantPayload({ reqId, nonce: `n-${reqId}`, decision: 'allow', ts: 2000, params: {}, ...overrides })

  it('a KNOWN pending reqId is flipped to approved/denied, mirroring recordRequestDecision', () => {
    const s0 = upsertRequest(emptyState(), req('r1'), CHILD, 1000)
    const s1 = recordGrantResult(s0, grant('r1', { decision: 'allow' }), CHILD, 2000)
    expect(s1.requests).toHaveLength(1)
    expect(s1.requests[0]!.status).toBe('approved')
    expect(s1.requests[0]!.request).toEqual(req('r1')) // the ORIGINAL request is preserved, not replaced
  })

  // v0.2 spec §4.3: 'dismissed' is a THIRD outcome, not a flavour of deny —
  // the child's chip must read "Not now", never "Not this time".
  it('a dismissed GRANT records a dismissed status, not a denial', () => {
    const s0 = upsertRequest(emptyState(), req('r1'), CHILD, 1000)
    const s1 = recordGrantResult(s0, grant('r1', { decision: 'dismissed' }), CHILD, 2000)
    expect(s1.requests[0]!.status).toBe('dismissed')
  })

  it('a dismissed GRANT for an UNKNOWN reqId synthesises a dismissed row', () => {
    const s1 = recordGrantResult(emptyState(), grant('scheduler:alex:acc1:2026-W32', { decision: 'dismissed', params: { periodKey: '2026-W32' } }), CHILD, 2000)
    expect(s1.requests).toHaveLength(1)
    expect(s1.requests[0]!.status).toBe('dismissed')
    expect(s1.requests[0]!.request.params).toEqual({ periodKey: '2026-W32' })
  })

  it('a KNOWN spend.request approved with a clamped amount records grantedAmountMinor from the GRANT', () => {
    const s0 = upsertRequest(emptyState(), req('r1'), CHILD, 1000) // asked 150
    const s1 = recordGrantResult(s0, grant('r1', { decision: 'allow', params: { amountMinor: 100 } }), CHILD, 2000)
    expect(s1.requests[0]!.grantedAmountMinor).toBe(100)
  })

  it('a KNOWN reqId denied is flipped to denied, no grantedAmountMinor', () => {
    const s0 = upsertRequest(emptyState(), req('r1'), CHILD, 1000)
    const s1 = recordGrantResult(s0, grant('r1', { decision: 'deny' }), CHILD, 2000)
    expect(s1.requests[0]!.status).toBe('denied')
    expect(s1.requests[0]!.grantedAmountMinor).toBeUndefined()
  })

  it('an UNKNOWN reqId does not throw and creates a synthetic already-decided row', () => {
    const s0 = emptyState()
    expect(() => recordGrantResult(s0, grant('scheduler:sam:acc1:2026-W32'), CHILD, 2000)).not.toThrow()

    const s1 = recordGrantResult(s0, grant('scheduler:sam:acc1:2026-W32'), CHILD, 2000)
    expect(s1.requests).toHaveLength(1)
    const row = s1.requests[0]!
    expect(row.status).toBe('approved')
    expect(row.request.reqId).toBe('scheduler:sam:acc1:2026-W32')
    expect(row.request.op).toBe('allowance.claim')
    expect(row.request.child).toBe(CHILD) // this device — a GRANT is only ever addressed to the child it concerns
    expect(row.authorPk).toBe(CHILD)
    expect(row.decidedAt).toBe(2000)
  })

  it('an UNKNOWN reqId denied still synthesises a row, status denied', () => {
    const s1 = recordGrantResult(emptyState(), grant('scheduler:sam:acc1:2026-W32', { decision: 'deny' }), CHILD, 2000)
    expect(s1.requests[0]!.status).toBe('denied')
  })

  it('an UNKNOWN reqId carrying a periodKey lifts it into the synthetic row\'s params', () => {
    const s1 = recordGrantResult(
      emptyState(),
      grant('scheduler:sam:acc1:2026-W32', { params: { periodKey: '2026-W32' } }),
      CHILD,
      2000,
    )
    expect(s1.requests[0]!.request.params).toEqual({ periodKey: '2026-W32' })
  })

  it('idempotent: a second GRANT for the same (now-decided) reqId is a no-op, even with a different decision', () => {
    const s0 = upsertRequest(emptyState(), req('r1'), CHILD, 1000)
    const s1 = recordGrantResult(s0, grant('r1', { decision: 'allow' }), CHILD, 2000)
    const s2 = recordGrantResult(s1, grant('r1', { decision: 'deny' }), CHILD, 3000)
    expect(s2).toBe(s1)
    expect(s2.requests[0]!.status).toBe('approved')
  })

  it('idempotent for an UNKNOWN reqId too: a redelivered GRANT does not synthesise a second row', () => {
    const s1 = recordGrantResult(emptyState(), grant('scheduler:sam:acc1:2026-W32'), CHILD, 2000)
    const s2 = recordGrantResult(s1, grant('scheduler:sam:acc1:2026-W32', { decision: 'deny' }), CHILD, 3000)
    expect(s2).toBe(s1)
    expect(s2.requests).toHaveLength(1)
    expect(s2.requests[0]!.status).toBe('approved')
  })

  it('leaves other requests in the registry untouched', () => {
    const s0 = upsertRequest(emptyState(), req('r2'), CHILD, 1100)
    const s1 = recordGrantResult(s0, grant('scheduler:sam:acc1:2026-W32'), CHILD, 2000)
    expect(s1.requests.find((r) => r.request.reqId === 'r2')!.status).toBe('pending')
  })
})

// --- v0.2: the lossless inner-event corpus and per-child revocation -------------

const ev = (id: string, kind: number, at: number) => ({
  id,
  pubkey: 'a'.repeat(64),
  kind,
  created_at: at,
  tags: [],
  content: '{}',
  sig: 'c'.repeat(128),
})

describe('retainInnerEvents', () => {
  it('retains every ENTRY/CONFIG/GRANT and only the newest 500 CHILD_SIG', () => {
    const m: Record<string, ReturnType<typeof ev>> = { e: ev('e', 31120, 1), c: ev('c', 31121, 1), g: ev('g', 31112, 1) }
    for (let i = 0; i < 600; i++) m[`s${i}`] = ev(`s${i}`, 31124, i)
    const kept = retainInnerEvents(m)
    expect(Object.keys(kept).filter((k) => kept[k]!.kind === 31124)).toHaveLength(MAX_RETAINED_CHILD_SIG)
    expect(kept.e).toBeDefined()
    expect(kept.c).toBeDefined()
    expect(kept.g).toBeDefined()
    expect(kept.s0).toBeUndefined()
    expect(kept.s599).toBeDefined()
  })

  it('drops events of any other kind', () => {
    expect(retainInnerEvents({ n: ev('n', 1, 1) })).toEqual({})
  })

  it('breaks a created_at tie by id, ascending, so the choice is deterministic', () => {
    const m: Record<string, ReturnType<typeof ev>> = {}
    for (let i = 0; i < MAX_RETAINED_CHILD_SIG + 1; i++) m[`s${String(i).padStart(4, '0')}`] = ev(`s${String(i).padStart(4, '0')}`, 31124, 7)
    const kept = retainInnerEvents(m)
    expect(Object.keys(kept)).toHaveLength(MAX_RETAINED_CHILD_SIG)
    expect(kept.s0000).toBeUndefined()
    expect(kept[`s${String(MAX_RETAINED_CHILD_SIG).padStart(4, '0')}`]).toBeDefined()
  })

  it('is a no-op on an already-small corpus and never mutates its input', () => {
    const m = { e: ev('e', 31120, 1) }
    expect(retainInnerEvents(m)).toEqual(m)
    expect(Object.keys(m)).toEqual(['e'])
  })
})

describe('activeChildren', () => {
  it('excludes revoked pubkeys', () => {
    const s = { ...emptyState(), children: [{ pubkey: 'a'.repeat(64), name: 'Alex', index: 0 }] }
    s.docs.accounts = { ...s.docs.accounts, revoked: { ['a'.repeat(64)]: 100 } }
    expect(activeChildren(s)).toHaveLength(0)
  })

  it('keeps every child when nothing is revoked', () => {
    const s = { ...emptyState(), children: [{ pubkey: 'a'.repeat(64), name: 'Alex', index: 0 }] }
    expect(activeChildren(s)).toHaveLength(1)
  })
})

// Who a family-wide config doc is actually fanned out to (fix round 1): a
// revoked device must stop RECEIVING policy as well as stop being listened to.
describe('configRecipients', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const roster = () => ({
    ...emptyState(),
    children: [
      { pubkey: A, name: 'Alex', index: 0 },
      { pubkey: B, name: 'Bo', index: 1 },
    ],
  })

  it('is every child when nothing is revoked', () => {
    expect(configRecipients(roster())).toEqual([A, B])
  })

  it('excludes a revoked device', () => {
    const s = roster()
    s.docs.accounts = { ...s.docs.accounts, revoked: { [A]: 100 } }
    expect(configRecipients(s)).toEqual([B])
  })

  it('is empty for a family with no children', () => {
    expect(configRecipients(emptyState())).toEqual([])
  })
})

// The child-side counterpart: what App.tsx gates the Unpaired screen on
// (v0.2 spec §4.5). State-derived, so it survives a reload.
describe('selfRevokedAt', () => {
  const PK = 'a'.repeat(64)
  const childState = () => ({ ...emptyState(), role: 'child' as const, self: { pubkey: PK, childIndex: 0 } })

  it('is the revocation time when this device is the revoked one', () => {
    const s = childState()
    s.docs.accounts = { ...s.docs.accounts, revoked: { [PK]: 1500 } }
    expect(selfRevokedAt(s)).toBe(1500)
  })

  it('is null when nothing is revoked, or when someone ELSE is', () => {
    expect(selfRevokedAt(childState())).toBeNull()
    const s = childState()
    s.docs.accounts = { ...s.docs.accounts, revoked: { ['b'.repeat(64)]: 1500 } }
    expect(selfRevokedAt(s)).toBeNull()
  })

  it('is null on a guardian device, and on one with no self pubkey', () => {
    const g = { ...emptyState(), role: 'guardian' as const, self: { pubkey: PK, childIndex: null } }
    g.docs.accounts = { ...g.docs.accounts, revoked: { [PK]: 1500 } }
    expect(selfRevokedAt(g)).toBeNull()
    const noSelf = { ...emptyState(), role: 'child' as const }
    noSelf.docs.accounts = { ...noSelf.docs.accounts, revoked: { [PK]: 1500 } }
    expect(selfRevokedAt(noSelf)).toBeNull()
  })

  it('is null for a revocation stamped at 0, only if absent — 0 is a real time', () => {
    const s = childState()
    s.docs.accounts = { ...s.docs.accounts, revoked: { [PK]: 0 } }
    expect(selfRevokedAt(s)).toBe(0)
  })
})

describe('recordGrantResult synthetic rows take their op from the GRANT (audit D9)', () => {
  const g = (reqId: string, overrides: Partial<GrantPayload> = {}): GrantPayload =>
    buildGrantPayload({ reqId, nonce: `n-${reqId}`, decision: 'allow', ts: 2000, params: {}, ...overrides })

  it('an unknown spend reqId (local state lost) is recorded as a spend with the granted amount, not a claim', () => {
    const s1 = recordGrantResult(emptyState(), g('01JSPENDREQ', { params: { amountMinor: 250 } }), CHILD, 2000)
    const row = s1.requests[0]!
    expect(row.request.op).toBe('spend.request')
    expect(row.request.params).toEqual({ amountMinor: 250 })
    expect(row.grantedAmountMinor).toBe(250)
    expect(row.synthetic).toBe(true)
  })
  it('a denied unknown spend is a spend too; a periodKey or scheduler reqId still marks a claim', () => {
    expect(recordGrantResult(emptyState(), g('01JSPENDREQ', { decision: 'deny' }), CHILD, 2000).requests[0]!.request.op).toBe('spend.request')
    expect(recordGrantResult(emptyState(), g('01JCLAIM', { params: { periodKey: '2026-W32' } }), CHILD, 2000).requests[0]!.request.op).toBe('allowance.claim')
    expect(recordGrantResult(emptyState(), g('scheduler:sam:acc1:2026-W32', { decision: 'deny' }), CHILD, 2000).requests[0]!.request.op).toBe('allowance.claim')
  })
  it('a known reqId is never marked synthetic', () => {
    const s0 = upsertRequest(emptyState(), req('r1'), CHILD, 1000)
    expect(recordGrantResult(s0, g('r1'), CHILD, 2000).requests[0]!.synthetic).toBeUndefined()
  })
})
