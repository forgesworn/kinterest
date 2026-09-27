import { describe, expect, it } from 'vitest'
import { emptyState } from '../state/state'
import type { StoredRequest } from '../state/types'
import type { RequestPayload } from '../wire/payloads'
import { askChip, buildSpendRequest, childOwnRequests, freshNonce, freshReqId } from './ask'

const CHILD = 'sam-pk'
const SIBLING = 'ash-pk'
const NOW = 1_755_000_000

const spendRequest = (overrides: Partial<RequestPayload> = {}): RequestPayload => ({
  v: 1,
  op: 'spend.request',
  reqId: 'req-1',
  nonce: 'nonce-1',
  child: CHILD,
  ts: NOW,
  params: { amountMinor: 500, currency: 'GBP', account: 'acc-1' },
  ...overrides,
})

const claimRequest = (overrides: Partial<RequestPayload> = {}): RequestPayload => ({
  v: 1,
  op: 'allowance.claim',
  reqId: 'req-2',
  nonce: 'nonce-2',
  child: CHILD,
  ts: NOW,
  params: { periodKey: '2026-W33' },
  ...overrides,
})

const stored = (request: RequestPayload, overrides: Partial<StoredRequest> = {}): StoredRequest => ({
  request,
  authorPk: request.child,
  status: 'pending',
  createdAt: NOW,
  ...overrides,
})

// ============================================================================
// childOwnRequests
// ============================================================================

describe('childOwnRequests', () => {
  it('returns only this self child\'s own requests, excluding anything for a sibling', () => {
    const app = { ...emptyState(), self: { pubkey: CHILD, childIndex: 0 } }
    app.requests = [stored(spendRequest()), stored(spendRequest({ reqId: 'req-3', child: SIBLING }))]
    const own = childOwnRequests(app)
    expect(own.map((r) => r.request.reqId)).toEqual(['req-1'])
  })

  it('self.pubkey null (not yet paired/unlocked) -> no requests at all', () => {
    const app = { ...emptyState(), self: { pubkey: null, childIndex: null } }
    app.requests = [stored(spendRequest())]
    expect(childOwnRequests(app)).toEqual([])
  })
})

// ============================================================================
// freshReqId / freshNonce
// ============================================================================

describe('freshReqId / freshNonce', () => {
  it('mint a different value on every call', () => {
    expect(freshReqId(NOW)).not.toBe(freshReqId(NOW))
    expect(freshNonce()).not.toBe(freshNonce())
  })

  it('freshNonce is a non-empty hex string', () => {
    expect(freshNonce()).toMatch(/^[0-9a-f]+$/)
  })
})

// ============================================================================
// buildSpendRequest
// ============================================================================

describe('buildSpendRequest', () => {
  it('builds a spend.request with the given amount/account/currency, fresh reqId/nonce', () => {
    const payload = buildSpendRequest({ child: CHILD, accountId: 'acc-1', amountMinor: 650, currency: 'GBP', nowSec: NOW })
    expect(payload.op).toBe('spend.request')
    expect(payload.child).toBe(CHILD)
    expect(payload.ts).toBe(NOW)
    expect(payload.params).toEqual({ amountMinor: 650, currency: 'GBP', account: 'acc-1' })
    expect(payload.reqId.length).toBeGreaterThan(0)
    expect(payload.nonce.length).toBeGreaterThan(0)
  })

  it('two builds from the same inputs mint different reqId/nonce (never accidentally deduped)', () => {
    const a = buildSpendRequest({ child: CHILD, accountId: 'acc-1', amountMinor: 650, currency: 'GBP', nowSec: NOW })
    const b = buildSpendRequest({ child: CHILD, accountId: 'acc-1', amountMinor: 650, currency: 'GBP', nowSec: NOW })
    expect(a.reqId).not.toBe(b.reqId)
    expect(a.nonce).not.toBe(b.nonce)
  })

  it('includes a trimmed note/link only when non-blank', () => {
    const withBoth = buildSpendRequest({
      child: CHILD,
      accountId: 'acc-1',
      amountMinor: 500,
      currency: 'GBP',
      note: '  Lego set  ',
      link: '  https://example.com/lego  ',
      nowSec: NOW,
    })
    expect(withBoth.params.note).toBe('Lego set')
    expect(withBoth.params.link).toBe('https://example.com/lego')

    const withNeither = buildSpendRequest({ child: CHILD, accountId: 'acc-1', amountMinor: 500, currency: 'GBP', note: '   ', link: '', nowSec: NOW })
    expect(withNeither.params.note).toBeUndefined()
    expect(withNeither.params.link).toBeUndefined()
  })
})

// ============================================================================
// askChip
// ============================================================================

describe('askChip', () => {
  it('a fresh pending ask reads "Waiting to hear back"', () => {
    const chip = askChip(stored(spendRequest()), NOW + 60)
    expect(chip).toEqual({ kind: 'pending', label: 'Waiting to hear back', tone: 'amber' })
  })

  it('a pending ask right at the 48h boundary is still "pending"', () => {
    const chip = askChip(stored(spendRequest(), { createdAt: NOW }), NOW + 48 * 3600 - 1)
    expect(chip.kind).toBe('pending')
  })

  it('a pending ask 48h or older reads "No reply yet"', () => {
    const chip = askChip(stored(spendRequest(), { createdAt: NOW }), NOW + 48 * 3600)
    expect(chip).toEqual({ kind: 'no-reply-yet', label: 'No reply yet', tone: 'neutral' })
  })

  it('denied reads "Not this time"', () => {
    const chip = askChip(stored(spendRequest(), { status: 'denied', decidedAt: NOW + 10 }), NOW + 20)
    expect(chip).toEqual({ kind: 'denied', label: 'Not this time', tone: 'bad' })
  })

  it('approved spend.request for the FULL amount reads plain "Approved!"', () => {
    const chip = askChip(stored(spendRequest(), { status: 'approved', decidedAt: NOW + 10, grantedAmountMinor: 500 }), NOW + 20)
    expect(chip.kind).toBe('approved')
  })

  it('approved spend.request for LESS than asked reads a kind "a bit less" message, not a bare number mismatch', () => {
    const chip = askChip(stored(spendRequest(), { status: 'approved', decidedAt: NOW + 10, grantedAmountMinor: 300 }), NOW + 20)
    expect(chip.kind).toBe('approved-less')
    expect(chip.tone).toBe('good')
  })

  it('approved spend.request with no recorded grantedAmountMinor falls back to "asked" (never mis-tagged as partial)', () => {
    const chip = askChip(stored(spendRequest(), { status: 'approved', decidedAt: NOW + 10 }), NOW + 20)
    expect(chip.kind).toBe('approved')
  })

  it('approved allowance.claim is always plain "Approved!" — no partial-grant concept', () => {
    const chip = askChip(stored(claimRequest(), { status: 'approved', decidedAt: NOW + 10 }), NOW + 20)
    expect(chip.kind).toBe('approved')
  })
})

// ============================================================================
// askChip — 'dismissed' (v0.2 spec §4.3)
// ============================================================================

describe('askChip: dismissed', () => {
  it('shows "Not now", ahead of the pending/no-reply branch, even after 48h', () => {
    const row = stored(spendRequest(), { status: 'dismissed' })
    expect(askChip(row, NOW)).toEqual({ kind: 'dismissed', label: 'Not now', tone: 'neutral' })
    expect(askChip(row, NOW + 200 * 3600)).toEqual({ kind: 'dismissed', label: 'Not now', tone: 'neutral' })
  })

  it('applies to an allowance claim too', () => {
    expect(askChip(stored(claimRequest(), { status: 'dismissed' }), NOW).label).toBe('Not now')
  })

  it('leaves a genuinely unanswered ask on "No reply yet" after 48h', () => {
    expect(askChip(stored(spendRequest()), NOW + 49 * 3600).kind).toBe('no-reply-yet')
  })
})
