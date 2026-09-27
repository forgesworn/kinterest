import { describe, expect, it } from 'vitest'
import type { Account } from '../domain/types'
import type { AllowanceConfig } from '../domain/allowance'
import type { InterestConfig } from '../domain/interest'
import type { Chore } from '../domain/chores'
import {
  addAccount,
  addChore,
  custodyCurrencyError,
  buildAllowanceConfig,
  buildInterestConfig,
  parsePercentToBps,
  renameAccount,
  renameChore,
  setAccountArchived,
  setAccountAuditCadence,
  setChoreArchived,
  setChoreCadence,
  upsertByChild,
  validDay,
  type AllowanceFormInput,
  type InterestFormInput,
  type NewAccountInput,
  type NewChoreInput,
} from './settingsForms'

const CHILD = 'a'.repeat(64)

// ============================================================================
// validDay — mirrors domain/period.ts#dueDays' own bounds
// ============================================================================

describe('validDay', () => {
  it('accepts the full weekly ISO-weekday range 1..7', () => {
    for (let d = 1; d <= 7; d++) expect(validDay('weekly', d)).toBe(true)
  })

  it('rejects weekly days outside 1..7', () => {
    expect(validDay('weekly', 0)).toBe(false)
    expect(validDay('weekly', 8)).toBe(false)
    expect(validDay('weekly', -1)).toBe(false)
  })

  it('accepts the full monthly day-of-month range 1..31', () => {
    expect(validDay('monthly', 1)).toBe(true)
    expect(validDay('monthly', 31)).toBe(true)
  })

  it('rejects monthly days outside 1..31', () => {
    expect(validDay('monthly', 0)).toBe(false)
    expect(validDay('monthly', 32)).toBe(false)
  })

  it('rejects non-integers', () => {
    expect(validDay('weekly', 3.5)).toBe(false)
    expect(validDay('monthly', NaN)).toBe(false)
  })
})

// ============================================================================
// parsePercentToBps — Task 6's own edge case: "3.5%" -> 350
// ============================================================================

describe('parsePercentToBps', () => {
  it('converts a plain percent to bps', () => {
    expect(parsePercentToBps('3.5')).toBe(350)
    expect(parsePercentToBps('3')).toBe(300)
    expect(parsePercentToBps('0.01')).toBe(1)
    expect(parsePercentToBps('100')).toBe(10000)
  })

  it('strips a trailing % sign — the plan\'s own worked example', () => {
    expect(parsePercentToBps('3.5%')).toBe(350)
    expect(parsePercentToBps('3.5 %')).toBe(350)
  })

  it('accepts zero (a legitimate "no interest" rate)', () => {
    expect(parsePercentToBps('0')).toBe(0)
  })

  it('rejects more than 2 decimal places — no such thing as a fractional bps', () => {
    expect(parsePercentToBps('3.555')).toBeNull()
  })

  it('rejects empty, whitespace-only, and a bare %', () => {
    expect(parsePercentToBps('')).toBeNull()
    expect(parsePercentToBps('   ')).toBeNull()
    expect(parsePercentToBps('%')).toBeNull()
  })

  it('rejects negative amounts and non-numeric junk', () => {
    expect(parsePercentToBps('-1')).toBeNull()
    expect(parsePercentToBps('abc')).toBeNull()
    expect(parsePercentToBps('1e3')).toBeNull()
  })

  it('rejects a lone "." or a malformed decimal', () => {
    expect(parsePercentToBps('.')).toBeNull()
    expect(parsePercentToBps('3.')).toBeNull()
    expect(parsePercentToBps('.5')).toBeNull()
  })

  it('accepts the 1000% ceiling exactly', () => {
    expect(parsePercentToBps('1000')).toBe(100000)
  })

  it('rejects anything over the 1000% ceiling', () => {
    expect(parsePercentToBps('1000.01')).toBeNull()
    expect(parsePercentToBps('9999999')).toBeNull()
  })
})

// ============================================================================
// Accounts
// ============================================================================

function accountInput(overrides: Partial<NewAccountInput> = {}): NewAccountInput {
  return { id: 'acc1', child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger', ...overrides }
}

describe('addAccount', () => {
  it('appends a well-formed account', () => {
    const next = addAccount([], accountInput())
    expect(next).toEqual([{ id: 'acc1', child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }])
  })

  it('trims the name', () => {
    const next = addAccount([], accountInput({ name: '  Savings  ' }))
    expect(next?.[0]?.name).toBe('Savings')
  })

  it('rejects an empty (post-trim) name', () => {
    expect(addAccount([], accountInput({ name: '   ' }))).toBeNull()
  })

  it('rejects an unrecognised currency', () => {
    expect(addAccount([], accountInput({ currency: 'XYZ' }))).toBeNull()
  })

  it('rejects a colliding id', () => {
    const existing: Account[] = [{ id: 'acc1', child: CHILD, name: 'Existing', currency: 'GBP', custody: 'ledger' }]
    expect(addAccount(existing, accountInput())).toBeNull()
  })

  it('a coin jar needs a currency with coins', () => {
    expect(custodyCurrencyError('physical', 'GBP')).toBeNull()
    expect(custodyCurrencyError('ledger', 'BTC')).toBeNull()
    expect(custodyCurrencyError('physical', 'BTC')).toMatch(/coin jar needs a currency/)
    expect(addAccount([], accountInput({ currency: 'BTC', custody: 'physical' }))).toBeNull()
  })

  it('a ledger pot in a coinless currency is still fine', () => {
    expect(addAccount([], accountInput({ currency: 'BTC', custody: 'ledger' }))).not.toBeNull()
  })

  it("an inherited Object member is not a currency with coins", () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(custodyCurrencyError('physical', key)).toMatch(/coin jar needs a currency/)
    }
  })

  it('every fiat currency with denominations is an acceptable coin jar', () => {
    for (const code of ['GBP', 'EUR', 'USD']) expect(custodyCurrencyError('physical', code)).toBeNull()
  })

  it('an unrecognised currency is not this check\'s business — addAccount still rejects it', () => {
    expect(custodyCurrencyError('physical', 'XYZ')).toMatch(/coin jar needs a currency/)
    expect(addAccount([], accountInput({ currency: 'XYZ', custody: 'physical' }))).toBeNull()
  })
})

describe('renameAccount', () => {
  const existing: Account[] = [{ id: 'acc1', child: CHILD, name: 'Old name', currency: 'GBP', custody: 'ledger' }]

  it('renames, trimmed', () => {
    const next = renameAccount(existing, 'acc1', '  New name  ')
    expect(next?.[0]?.name).toBe('New name')
  })

  it('leaves currency/custody untouched (fixed at creation)', () => {
    const next = renameAccount(existing, 'acc1', 'New name')
    expect(next?.[0]?.currency).toBe('GBP')
    expect(next?.[0]?.custody).toBe('ledger')
  })

  it('rejects an empty name', () => {
    expect(renameAccount(existing, 'acc1', '  ')).toBeNull()
  })

  it('rejects an unknown id', () => {
    expect(renameAccount(existing, 'nope', 'New name')).toBeNull()
  })
})

describe('setAccountArchived', () => {
  const existing: Account[] = [{ id: 'acc1', child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }]

  it('archives and unarchives', () => {
    const archived = setAccountArchived(existing, 'acc1', true)
    expect(archived?.[0]?.archived).toBe(true)
    const restored = setAccountArchived(archived!, 'acc1', false)
    expect(restored?.[0]?.archived).toBe(false)
  })

  it('rejects an unknown id', () => {
    expect(setAccountArchived(existing, 'nope', true)).toBeNull()
  })
})

describe('setAccountAuditCadence', () => {
  const existing: Account[] = [{ id: 'acc1', child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger' }]

  it('sets a cadence', () => {
    const next = setAccountAuditCadence(existing, 'acc1', 'monthly')
    expect(next?.[0]?.auditCadence).toBe('monthly')
  })

  it('clears a cadence back to unset', () => {
    const withCadence = setAccountAuditCadence(existing, 'acc1', 'weekly')!
    const cleared = setAccountAuditCadence(withCadence, 'acc1', undefined)
    expect(cleared?.[0]?.auditCadence).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(cleared?.[0], 'auditCadence')).toBe(false)
  })

  it('rejects an unknown id', () => {
    expect(setAccountAuditCadence(existing, 'nope', 'weekly')).toBeNull()
  })

  it('leaves every other field untouched', () => {
    const next = setAccountAuditCadence(existing, 'acc1', 'weekly')
    expect(next?.[0]).toEqual({ id: 'acc1', child: CHILD, name: 'Pocket money', currency: 'GBP', custody: 'ledger', auditCadence: 'weekly' })
  })
})

// ============================================================================
// upsertByChild
// ============================================================================

describe('upsertByChild', () => {
  it('appends when no config exists yet for this child', () => {
    const next = upsertByChild<{ child: string; v: number }>([], { child: CHILD, v: 1 })
    expect(next).toEqual([{ child: CHILD, v: 1 }])
  })

  it('replaces the existing config for this child, leaving others untouched', () => {
    const other = { child: 'b'.repeat(64), v: 1 }
    const existing = { child: CHILD, v: 1 }
    const next = upsertByChild([other, existing], { child: CHILD, v: 2 })
    expect(next).toEqual([other, { child: CHILD, v: 2 }])
  })
})

// ============================================================================
// Allowance
// ============================================================================

function allowanceInput(overrides: Partial<AllowanceFormInput> = {}): AllowanceFormInput {
  return {
    child: CHILD,
    account: 'acc1',
    currency: 'GBP',
    amountRaw: '5.00',
    cadence: 'weekly',
    day: 6,
    tz: 'Europe/London',
    startDay: '2026-01-01',
    paused: false,
    choresGate: false,
    auditGate: false,
    ...overrides,
  }
}

describe('buildAllowanceConfig', () => {
  it('builds a valid config', () => {
    const cfg = buildAllowanceConfig(allowanceInput())
    expect(cfg).toEqual<AllowanceConfig>({
      child: CHILD,
      account: 'acc1',
      amountMinor: 500,
      cadence: 'weekly',
      day: 6,
      tz: 'Europe/London',
      startDay: '2026-01-01',
      paused: false,
      choresGate: false,
      auditGate: false,
    })
  })

  it('rejects an amount that fails parseAmount', () => {
    expect(buildAllowanceConfig(allowanceInput({ amountRaw: '0' }))).toBeNull()
    expect(buildAllowanceConfig(allowanceInput({ amountRaw: '' }))).toBeNull()
    expect(buildAllowanceConfig(allowanceInput({ amountRaw: '0.005' }))).toBeNull()
  })

  it('rejects an out-of-bounds day for the cadence', () => {
    expect(buildAllowanceConfig(allowanceInput({ cadence: 'weekly', day: 8 }))).toBeNull()
    expect(buildAllowanceConfig(allowanceInput({ cadence: 'monthly', day: 32 }))).toBeNull()
  })

  it('rejects an empty tz or startDay', () => {
    expect(buildAllowanceConfig(allowanceInput({ tz: '' }))).toBeNull()
    expect(buildAllowanceConfig(allowanceInput({ startDay: '' }))).toBeNull()
  })
})

// ============================================================================
// Interest
// ============================================================================

function interestInput(overrides: Partial<InterestFormInput> = {}): InterestFormInput {
  return {
    child: CHILD,
    account: 'acc1',
    currency: 'GBP',
    rateRaw: '3.5',
    cadence: 'monthly',
    day: 1,
    tz: 'Europe/London',
    startDay: '2026-01-01',
    paused: false,
    ...overrides,
  }
}

describe('buildInterestConfig', () => {
  it('builds a valid config without match/cap', () => {
    const cfg = buildInterestConfig(interestInput())
    expect(cfg).toEqual<InterestConfig>({
      child: CHILD,
      account: 'acc1',
      rateBps: 350,
      cadence: 'monthly',
      day: 1,
      tz: 'Europe/London',
      startDay: '2026-01-01',
      paused: false,
    })
  })

  it('includes matchBps/matchCapMinor when both are supplied', () => {
    const cfg = buildInterestConfig(interestInput({ matchRaw: '1.5', matchCapRaw: '10.00' }))
    expect(cfg?.matchBps).toBe(150)
    expect(cfg?.matchCapMinor).toBe(1000)
  })

  it('leaves match fields unset when the raw text is empty/whitespace', () => {
    const cfg = buildInterestConfig(interestInput({ matchRaw: '', matchCapRaw: '   ' }))
    expect(cfg?.matchBps).toBeUndefined()
    expect(cfg?.matchCapMinor).toBeUndefined()
  })

  it('rejects a rate that fails parsePercentToBps', () => {
    expect(buildInterestConfig(interestInput({ rateRaw: '3.555' }))).toBeNull()
    expect(buildInterestConfig(interestInput({ rateRaw: '' }))).toBeNull()
  })

  it('rejects a non-empty match rate that fails parsePercentToBps', () => {
    expect(buildInterestConfig(interestInput({ matchRaw: '3.555' }))).toBeNull()
  })

  it('rejects a non-empty match cap that fails parseAmount', () => {
    expect(buildInterestConfig(interestInput({ matchCapRaw: '0' }))).toBeNull()
  })

  it('rejects an out-of-bounds day for the cadence', () => {
    expect(buildInterestConfig(interestInput({ cadence: 'monthly', day: 0 }))).toBeNull()
  })
})

// ============================================================================
// Chores
// ============================================================================

function choreInput(overrides: Partial<NewChoreInput> = {}): NewChoreInput {
  return { id: 'chore1', child: CHILD, name: 'Feed the cat', cadence: 'daily', ...overrides }
}

describe('addChore', () => {
  it('appends a well-formed chore', () => {
    const next = addChore([], choreInput())
    expect(next).toEqual([{ id: 'chore1', child: CHILD, name: 'Feed the cat', cadence: 'daily' }])
  })

  it('rejects an empty name', () => {
    expect(addChore([], choreInput({ name: '  ' }))).toBeNull()
  })

  it('rejects a colliding id', () => {
    const existing: Chore[] = [{ id: 'chore1', child: CHILD, name: 'Existing', cadence: 'daily' }]
    expect(addChore(existing, choreInput())).toBeNull()
  })
})

describe('renameChore / setChoreCadence / setChoreArchived', () => {
  const existing: Chore[] = [{ id: 'chore1', child: CHILD, name: 'Feed the cat', cadence: 'daily' }]

  it('renames, trimmed', () => {
    expect(renameChore(existing, 'chore1', '  Walk the dog  ')?.[0]?.name).toBe('Walk the dog')
  })

  it('rejects renaming to empty or an unknown id', () => {
    expect(renameChore(existing, 'chore1', '  ')).toBeNull()
    expect(renameChore(existing, 'nope', 'x')).toBeNull()
  })

  it('changes cadence', () => {
    expect(setChoreCadence(existing, 'chore1', 'weekly')?.[0]?.cadence).toBe('weekly')
  })

  it('archives and unarchives', () => {
    const archived = setChoreArchived(existing, 'chore1', true)
    expect(archived?.[0]?.archived).toBe(true)
    expect(setChoreArchived(archived!, 'chore1', false)?.[0]?.archived).toBe(false)
  })

  it('rejects an unknown id for cadence/archive', () => {
    expect(setChoreCadence(existing, 'nope', 'weekly')).toBeNull()
    expect(setChoreArchived(existing, 'nope', true)).toBeNull()
  })
})
