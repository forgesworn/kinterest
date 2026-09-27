import { describe, expect, it } from 'vitest'
import { emptyState } from '../state/state'
import type { AppState, StoredRequest } from '../state/types'
import { buildRequestPayload } from '../wire/payloads'
import { grantFor, grantsFor } from './snapshot'

const spend = (reqId: string, child: string) =>
  buildRequestPayload({ op: 'spend.request', reqId, nonce: `n-${reqId}`, child, ts: 1, params: { amountMinor: 500, currency: 'GBP', account: 'a1' } })
const claim = (reqId: string, child: string) =>
  buildRequestPayload({ op: 'allowance.claim', reqId, nonce: `n-${reqId}`, child, ts: 1, params: { periodKey: '2026-W36' } })

const row = (request: StoredRequest['request'], status: StoredRequest['status'], decidedAt: number, extra: Partial<StoredRequest> = {}): StoredRequest => ({
  request,
  authorPk: request.child,
  status,
  createdAt: 1,
  ...(status !== 'pending' ? { decidedAt } : {}),
  ...extra,
})

describe('grantFor', () => {
  it('rebuilds the GRANT buildGrantDecision sent, params included', () => {
    expect(grantFor(row(spend('r1', 'sam'), 'approved', 9, { grantedAmountMinor: 300 }))).toEqual({
      v: 1, reqId: 'r1', nonce: 'n-r1', decision: 'allow', ts: 9, params: { amountMinor: 300 },
    })
    expect(grantFor(row(spend('r2', 'sam'), 'denied', 9))?.params).toEqual({})
    expect(grantFor(row(claim('r3', 'sam'), 'dismissed', 9))).toMatchObject({ decision: 'dismissed', params: { periodKey: '2026-W36' } })
    expect(grantFor(row(spend('r4', 'sam'), 'pending', 0))).toBeNull()
  })
})

describe('grantsFor', () => {
  it('carries only the addressed child s decided asks, newest first', () => {
    const app: AppState = {
      ...emptyState(),
      requests: [
        row(spend('old', 'sam'), 'denied', 5),
        row(spend('new', 'sam'), 'approved', 8, { grantedAmountMinor: 500 }),
        row(spend('pending', 'sam'), 'pending', 0),
        row(spend('sibling', 'alex'), 'approved', 9, { grantedAmountMinor: 500 }),
      ],
    }
    expect(grantsFor(app, 'sam').map((g) => g.reqId)).toEqual(['new', 'old'])
    expect(JSON.stringify(grantsFor(app, 'sam'))).not.toContain('sibling')
  })
})
