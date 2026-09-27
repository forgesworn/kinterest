import { assertMinor } from './money'
import type { Account, Entry } from './types'
import type { EntryMeta } from './ledger'

export interface Denomination {
  label: string
  minor: number
}

export const DENOMINATIONS: Record<string, Denomination[]> = {
  GBP: [
    { label: '1p', minor: 1 }, { label: '2p', minor: 2 }, { label: '5p', minor: 5 },
    { label: '10p', minor: 10 }, { label: '20p', minor: 20 }, { label: '50p', minor: 50 },
    { label: '£1', minor: 100 }, { label: '£2', minor: 200 },
    { label: '£5 note', minor: 500 }, { label: '£10 note', minor: 1000 },
    { label: '£20 note', minor: 2000 }, { label: '£50 note', minor: 5000 },
  ],
  EUR: [
    { label: '1c', minor: 1 }, { label: '2c', minor: 2 }, { label: '5c', minor: 5 },
    { label: '10c', minor: 10 }, { label: '20c', minor: 20 }, { label: '50c', minor: 50 },
    { label: '€1', minor: 100 }, { label: '€2', minor: 200 },
    { label: '€5 note', minor: 500 }, { label: '€10 note', minor: 1000 },
    { label: '€20 note', minor: 2000 }, { label: '€50 note', minor: 5000 },
  ],
  USD: [
    { label: '1¢', minor: 1 }, { label: '5¢', minor: 5 }, { label: '10¢', minor: 10 },
    { label: '25¢', minor: 25 }, { label: '$1', minor: 100 },
    { label: '$5 note', minor: 500 }, { label: '$10 note', minor: 1000 },
    { label: '$20 note', minor: 2000 }, { label: '$50 note', minor: 5000 },
  ],
}

export function countTotal(counts: { minor: number; qty: number }[]): number {
  let total = 0
  for (const { minor, qty } of counts) {
    assertMinor(minor)
    if (minor <= 0) throw new RangeError(`denomination must be positive, got ${minor}`)
    if (!Number.isSafeInteger(qty) || qty < 0) throw new RangeError(`bad quantity: ${qty}`)
    total += minor * qty
  }
  assertMinor(total)
  return total
}

export interface AuditResult {
  id: string
  account: string
  child: string
  countedMinor: number
  expectedMinor: number
  deltaMinor: number
  at: number // unix seconds
  author: 'guardian' | 'child'
}

export function auditResult(
  meta: { id: string; at: number; author: 'guardian' | 'child' },
  account: Account,
  countedMinor: number,
  expectedMinor: number,
): AuditResult {
  assertMinor(countedMinor)
  assertMinor(expectedMinor)
  return {
    id: meta.id,
    account: account.id,
    child: account.child,
    countedMinor,
    expectedMinor,
    deltaMinor: countedMinor - expectedMinor,
    at: meta.at,
    author: meta.author,
  }
}

export function adjustmentEntry(audit: AuditResult, account: Account, meta: EntryMeta): Entry | null {
  if (audit.deltaMinor === 0) return null
  if (audit.account !== account.id)
    throw new RangeError(`audit ${audit.id} is for account ${audit.account}, got ${account.id}`)
  if (meta.child !== account.child)
    throw new RangeError(`adjustment child ${meta.child} does not match account child ${account.child}`)
  return {
    v: 1,
    kind: 'adjustment',
    legs: [{ account: account.id, currency: account.currency, amountMinor: audit.deltaMinor }],
    auditId: audit.id,
    countedMinor: audit.countedMinor,
    ...meta,
  }
}
