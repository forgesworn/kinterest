import { describe, expect, it } from 'vitest'
import { exchangeEntry } from '../domain/ledger'
import type { AllowanceConfig } from '../domain/allowance'
import type { InterestConfig } from '../domain/interest'
import type { Account } from '../domain/types'
import type { StoredRequest } from '../state/types'
import { approxTotal, familyChildren, nextDates, pendingRequestCount } from './Home'

// Pure-logic coverage only — Home.tsx's screen half is a thin `useApp()` +
// render shell, matching PairDevice.tsx's own split (pairingRemainingSecs
// tested directly, the component itself not mounted).

const CHILD = 'sam'
const spending: Account = { id: 'acc-spend', child: CHILD, name: 'Spending', currency: 'GBP', custody: 'ledger' }
const btc: Account = { id: 'acc-btc', child: CHILD, name: 'Bitcoin', currency: 'BTC', custody: 'ledger' }
const AT = 1_755_000_000

describe('approxTotal', () => {
  it('sums same-currency balances with no conversion needed, approx: false', () => {
    const total = approxTotal([{ currency: 'GBP', balanceMinor: 500 }, { currency: 'GBP', balanceMinor: 250 }], 'GBP', [])
    expect(total).toEqual({ currency: 'GBP', totalMinor: 750, approx: false })
  })

  it('converts a foreign-currency balance using the last-used exchange rate, marks approx: true', () => {
    // £10.00 -> 20,000 sats implies 1 BTC (100,000,000 sats) = £50,000, so
    // 5,000 sats convert to £2.50.
    const exchange = exchangeEntry({ id: 'x1', child: CHILD, createdAt: AT, author: 'guardian' }, spending, 1000, btc, 20000)
    const total = approxTotal([{ currency: 'GBP', balanceMinor: 1000 }, { currency: 'BTC', balanceMinor: 5000 }], 'GBP', [exchange])
    expect(total.currency).toBe('GBP')
    expect(total.totalMinor).toBe(1000 + 250)
    expect(total.approx).toBe(true)
  })

  it('excludes a currency with no known rate from the total, but still marks approx: true', () => {
    const total = approxTotal([{ currency: 'GBP', balanceMinor: 1000 }, { currency: 'BTC', balanceMinor: 5000 }], 'GBP', [])
    expect(total.totalMinor).toBe(1000) // BTC leg excluded, not guessed
    expect(total.approx).toBe(true)
  })

  it('skips zero balances entirely (no spurious approx flag from an empty foreign account)', () => {
    const total = approxTotal([{ currency: 'GBP', balanceMinor: 1000 }, { currency: 'BTC', balanceMinor: 0 }], 'GBP', [])
    expect(total).toEqual({ currency: 'GBP', totalMinor: 1000, approx: false })
  })

  it('empty balances -> zero total, not approx', () => {
    expect(approxTotal([], 'GBP', [])).toEqual({ currency: 'GBP', totalMinor: 0, approx: false })
  })
})

describe('nextDates', () => {
  const allowanceCfg: AllowanceConfig = { child: CHILD, account: spending.id, amountMinor: 500, cadence: 'weekly', day: 5, tz: 'UTC', startDay: '2026-08-01' }
  const interestCfg: InterestConfig = { child: CHILD, account: spending.id, rateBps: 100, cadence: 'monthly', day: 1, tz: 'UTC', startDay: '2026-01-01' }
  const friday = Date.UTC(2026, 7, 14, 9, 0) / 1000 // Friday 2026-08-14 (allowance day = ISO Friday = 5)

  it('finds the next due day for allowance and interest independently', () => {
    const dates = nextDates(allowanceCfg, interestCfg, friday)
    expect(dates.allowance).toBe('2026-08-21') // next Friday after today
    expect(dates.interest).toBe('2026-09-01') // next 1st-of-month after today
  })

  it('returns null for whichever config is undefined', () => {
    expect(nextDates(undefined, interestCfg, friday).allowance).toBeNull()
    expect(nextDates(allowanceCfg, undefined, friday).interest).toBeNull()
    expect(nextDates(undefined, undefined, friday)).toEqual({ allowance: null, interest: null })
  })

  it('returns null for a paused config rather than its next due day', () => {
    const paused: AllowanceConfig = { ...allowanceCfg, paused: true }
    expect(nextDates(paused, undefined, friday).allowance).toBeNull()
  })

  it('excludes a due day that falls exactly today — "next" means upcoming, not due-now', () => {
    // On the allowance's own due weekday, the immediate next hit must be a
    // full cadence later, not today itself.
    const dates = nextDates(allowanceCfg, undefined, friday)
    expect(dates.allowance).not.toBe('2026-08-14')
  })

  it('never returns a due day before a future startDay', () => {
    // Cadence day (Friday) unchanged, but the schedule itself doesn't start
    // until 2026-09-01 (a Tuesday), which is AHEAD of `friday` (today,
    // 2026-08-14). The nearest calendar Friday after TODAY (2026-08-21) is
    // still before startDay and must never be returned — the correct
    // answer is the first Friday on/after startDay, 2026-09-04.
    const futureStart: AllowanceConfig = { ...allowanceCfg, startDay: '2026-09-01' }
    const dates = nextDates(futureStart, undefined, friday)
    expect(dates.allowance).toBe('2026-09-04')
    expect(dates.allowance! >= futureStart.startDay).toBe(true)
  })
})

describe('pendingRequestCount', () => {
  const other = 'other-child'

  function stored(reqId: string, child: string, status: StoredRequest['status'] = 'pending'): StoredRequest {
    return {
      request: { v: 1, op: 'spend.request', reqId, nonce: 'n', child, ts: AT, params: {} },
      authorPk: child,
      status,
      createdAt: AT,
    }
  }

  it('counts pending requests for the given child', () => {
    const requests = [stored('r1', CHILD), stored('r2', CHILD)]
    expect(pendingRequestCount(requests, CHILD)).toBe(2)
  })

  it('ignores requests belonging to a different child', () => {
    const requests = [stored('r1', CHILD), stored('r2', other)]
    expect(pendingRequestCount(requests, CHILD)).toBe(1)
  })

  it('excludes decided (approved/denied/dismissed) requests — only \'pending\' counts', () => {
    const requests = [stored('r1', CHILD, 'approved'), stored('r2', CHILD, 'denied'), stored('r3', CHILD, 'dismissed'), stored('r4', CHILD, 'pending')]
    expect(pendingRequestCount(requests, CHILD)).toBe(1)
  })

  it('a duplicate reqId already recorded (relay replay) is never double-counted — the registry itself dedupes', () => {
    // upsertRequest (state/state.ts) refuses a second record for the same
    // reqId, so this registry can never actually contain two entries for
    // one reqId — this test documents that pendingRequestCount does not
    // need its own reqId-dedupe on top of that invariant.
    const requests = [stored('r1', CHILD)]
    expect(pendingRequestCount(requests, CHILD)).toBe(1)
  })

  it('empty requests -> 0', () => {
    expect(pendingRequestCount([], CHILD)).toBe(0)
  })
})

describe('familyChildren', () => {
  it('excludes an archived child', () => {
    const children = [
      { pubkey: 'a'.repeat(64), name: 'Alex', index: 0 },
      { pubkey: 'b'.repeat(64), name: 'Bo', index: 1, archived: 500 },
    ]
    expect(familyChildren(children)).toEqual([{ pubkey: 'a'.repeat(64), name: 'Alex', index: 0 }])
  })

  it('keeps a child whose device was revoked but who is not archived', () => {
    // Revoking a device and removing a child are two separate actions —
    // see familyChildren's own doc comment.
    const children = [{ pubkey: 'a'.repeat(64), name: 'Alex', index: 0 }]
    expect(familyChildren(children)).toHaveLength(1)
  })

  it('empty family -> empty list', () => {
    expect(familyChildren([])).toEqual([])
  })
})
