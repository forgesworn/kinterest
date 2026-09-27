import { assertPositiveMinor, currencyOrThrow } from './money'
import type { Account, Entry, EntryKind, Leg } from './types'

const ENTRY_KINDS: readonly EntryKind[] = ['credit', 'debit', 'transfer', 'exchange', 'interest', 'adjustment']
const TWO_LEG_KINDS: readonly EntryKind[] = ['transfer', 'exchange']
const ONE_LEG_KINDS: readonly EntryKind[] = ['credit', 'debit', 'interest', 'adjustment']

export interface EntryMeta {
  id: string
  child: string
  createdAt: number
  author: 'guardian' | 'child'
  note?: string
  link?: string
  requestId?: string
}

function base(meta: EntryMeta, kind: EntryKind, legs: Leg[]): Entry {
  return { v: 1, kind, legs, ...meta }
}

function ownAccount(meta: EntryMeta, account: Account): void {
  if (account.child !== meta.child)
    throw new RangeError(`account ${account.id} belongs to child ${account.child}, not ${meta.child}`)
}

export function creditEntry(meta: EntryMeta, account: Account, amountMinor: number, category?: string): Entry {
  assertPositiveMinor(amountMinor)
  ownAccount(meta, account)
  return { ...base(meta, 'credit', [{ account: account.id, currency: account.currency, amountMinor }]), category }
}

export function debitEntry(meta: EntryMeta, account: Account, amountMinor: number, category?: string): Entry {
  assertPositiveMinor(amountMinor)
  ownAccount(meta, account)
  return { ...base(meta, 'debit', [{ account: account.id, currency: account.currency, amountMinor: -amountMinor }]), category }
}

export function transferEntry(meta: EntryMeta, from: Account, to: Account, amountMinor: number): Entry {
  assertPositiveMinor(amountMinor)
  ownAccount(meta, from)
  ownAccount(meta, to)
  if (from.id === to.id) throw new RangeError('transfer needs two different accounts, got the same account twice')
  if (from.currency !== to.currency)
    throw new RangeError(`transfer legs must share a currency (${from.currency} vs ${to.currency}); use an exchange`)
  return base(meta, 'transfer', [
    { account: from.id, currency: from.currency, amountMinor: -amountMinor },
    { account: to.id, currency: to.currency, amountMinor },
  ])
}

export function exchangeEntry(
  meta: EntryMeta,
  from: Account,
  fromAmountMinor: number,
  to: Account,
  toAmountMinor: number,
): Entry {
  assertPositiveMinor(fromAmountMinor)
  assertPositiveMinor(toAmountMinor)
  ownAccount(meta, from)
  ownAccount(meta, to)
  if (from.currency === to.currency)
    throw new RangeError(`exchange needs two currencies, got ${from.currency} twice; use a transfer`)
  return base(meta, 'exchange', [
    { account: from.id, currency: from.currency, amountMinor: -fromAmountMinor },
    { account: to.id, currency: to.currency, amountMinor: toAmountMinor },
  ])
}

// The sync layer must call this on every entry received from a paired
// device before folding it in — balances() itself stays a total,
// validation-free fold and trusts its input completely.
export function assertEntry(e: Entry): void {
  if (e.v !== 1) throw new RangeError(`unsupported entry version: ${e.v}`)
  if (typeof e.id !== 'string' || e.id === '') throw new RangeError('entry id must be a non-empty string')
  if (typeof e.child !== 'string' || e.child === '') throw new RangeError('entry child must be a non-empty string')
  if (!ENTRY_KINDS.includes(e.kind)) throw new RangeError(`unknown entry kind: ${e.kind}`)
  if (!Number.isSafeInteger(e.createdAt) || e.createdAt < 0)
    throw new RangeError(`createdAt must be a safe integer >= 0, got ${e.createdAt}`)
  if (e.author !== 'guardian' && e.author !== 'child') throw new RangeError(`unknown author: ${e.author}`)
  if (!Array.isArray(e.legs) || e.legs.length < 1 || e.legs.length > 2)
    throw new RangeError(`entry must have 1 or 2 legs, got ${Array.isArray(e.legs) ? e.legs.length : typeof e.legs}`)
  for (const leg of e.legs) {
    if (typeof leg.account !== 'string' || leg.account === '')
      throw new RangeError('leg account must be a non-empty string')
    currencyOrThrow(leg.currency)
    if (!Number.isSafeInteger(leg.amountMinor) || leg.amountMinor === 0)
      throw new RangeError(`leg amountMinor must be a non-zero safe integer, got ${leg.amountMinor}`)
  }
  if (TWO_LEG_KINDS.includes(e.kind) && e.legs.length !== 2)
    throw new RangeError(`${e.kind} entries need exactly 2 legs, got ${e.legs.length}`)
  if (ONE_LEG_KINDS.includes(e.kind) && e.legs.length !== 1)
    throw new RangeError(`${e.kind} entries need exactly 1 leg, got ${e.legs.length}`)
  if (e.reverses !== undefined && (typeof e.reverses !== 'string' || e.reverses === ''))
    throw new RangeError('reverses must be a non-empty string when present')
  // Adjustment fields (audit S3): optional, so an entry without them — any
  // stored or on-the-wire adjustment from before they were set — still
  // parses; when present they must be well-formed and on an adjustment.
  if (e.auditId !== undefined && (typeof e.auditId !== 'string' || e.auditId === ''))
    throw new RangeError('auditId must be a non-empty string when present')
  if (e.countedMinor !== undefined) {
    if (e.kind !== 'adjustment') throw new RangeError(`countedMinor is only valid on an adjustment, got ${e.kind}`)
    if (!Number.isSafeInteger(e.countedMinor) || e.countedMinor < 0)
      throw new RangeError(`countedMinor must be a safe integer >= 0, got ${e.countedMinor}`)
  }
  assertLedgerInvariants(e)
}

// The money rules of each kind (audit D5). A reversal (`reverses` set —
// see reverseEntry) carries the original's kind with every leg negated, so
// the one-leg sign rules flip for it; the two-leg rules are symmetric.
function assertLedgerInvariants(e: Entry): void {
  const sign = e.reverses === undefined ? 1 : -1
  switch (e.kind) {
    case 'credit':
    case 'interest':
      if (e.legs[0]!.amountMinor * sign <= 0)
        throw new RangeError(`${e.kind} leg must be ${sign > 0 ? 'positive' : 'negative (reversal)'}, got ${e.legs[0]!.amountMinor}`)
      return
    case 'debit':
      if (e.legs[0]!.amountMinor * sign >= 0)
        throw new RangeError(`debit leg must be ${sign > 0 ? 'negative' : 'positive (reversal)'}, got ${e.legs[0]!.amountMinor}`)
      return
    case 'transfer': {
      const [a, b] = e.legs as [Leg, Leg]
      if (a.account === b.account) throw new RangeError('transfer legs must name two different accounts')
      if (a.currency !== b.currency) throw new RangeError(`transfer legs must share a currency (${a.currency} vs ${b.currency})`)
      if (a.amountMinor + b.amountMinor !== 0)
        throw new RangeError(`transfer legs must sum to 0, got ${a.amountMinor} + ${b.amountMinor}`)
      return
    }
    case 'exchange': {
      const [a, b] = e.legs as [Leg, Leg]
      if (a.account === b.account) throw new RangeError('exchange legs must name two different accounts')
      if (a.currency === b.currency) throw new RangeError(`exchange legs must be in different currencies, got ${a.currency} twice`)
      if (Math.sign(a.amountMinor) === Math.sign(b.amountMinor))
        throw new RangeError(`exchange legs must have opposite signs, got ${a.amountMinor} and ${b.amountMinor}`)
      return
    }
    case 'adjustment':
      return // a signed delta: either direction is legitimate
  }
}

/**
 * Context-aware check of an entry against the family's accounts
 * (`docs.accounts.accounts`) — audit D5. Every leg's account must exist,
 * belong to `entry.child`, and be in the leg's currency. Throws RangeError
 * otherwise. Pure. Call it alongside `assertEntry` wherever an entry from
 * another device is accepted.
 */
export function assertEntryAgainst(accounts: readonly Account[], entry: Entry): void {
  for (const leg of entry.legs) {
    const account = accounts.find((a) => a.id === leg.account)
    if (account === undefined) throw new RangeError(`unknown account: ${leg.account}`)
    if (account.child !== entry.child)
      throw new RangeError(`account ${leg.account} belongs to child ${account.child}, not ${entry.child}`)
    if (account.currency !== leg.currency)
      throw new RangeError(`leg currency ${leg.currency} does not match account ${leg.account}'s currency ${account.currency}`)
  }
}

export function balances(entries: Iterable<Entry>): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of entries)
    for (const leg of e.legs) out.set(leg.account, (out.get(leg.account) ?? 0) + leg.amountMinor)
  return out
}

// Deliberately does NOT carry periodKey forward onto the reversal:
// allowanceDue()/interestDue() build their paid-set from entries that carry
// a periodKey, so a reversal without one cannot re-enter that set — which is
// exactly what reopens the period for re-payment.
export function reverseEntry(original: Entry, meta: EntryMeta): Entry {
  if (meta.child !== original.child)
    throw new RangeError(`reversal child ${meta.child} does not match original entry child ${original.child}`)
  const legs = original.legs.map((l) => ({ ...l, amountMinor: -l.amountMinor }))
  return { ...base(meta, original.kind, legs), reverses: original.id, category: original.category }
}

// Scheduler-created payouts carry a deterministic id ending in the due day
// they pay for (store/scheduler.ts#schedulerEntryId:
// `sched:<kind>:<child>:<account>:<YYYY-MM-DD>`).
const SCHEDULED_ID = /^sched:(?:allowance|interest|match):.+:(\d{4}-\d{2}-\d{2})$/

/** The due day a guardian-authored scheduler payout pays for, or null for
 *  any other entry. */
export function scheduledDueDay(e: Pick<Entry, 'id' | 'author'>): string | null {
  if (e.author !== 'guardian') return null
  const m = SCHEDULED_ID.exec(e.id)
  return m ? m[1]! : null
}

export function sortForDisplay(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
