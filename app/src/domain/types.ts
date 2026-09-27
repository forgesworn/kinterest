export interface Account {
  id: string
  child: string
  name: string
  currency: string
  custody: 'ledger' | 'physical' | 'external'
  archived?: boolean
  /** How often a guardian is reminded to physically audit this account
   *  against the ledger (Plan 3, Task 6) — the audit *ceremony* itself is
   *  child-side (Plan 4); this is only the reminder cadence a guardian sets
   *  per account. Additive/optional: wire/payloads.ts's `isAccountShape`
   *  never enumerated a closed field set, so an older snapshot/device that
   *  predates this field parses this account exactly as before (field
   *  simply absent), and a newer device reading an older doc sees `undefined`
   *  — the same "no audit cadence set" state as never having set one. */
  auditCadence?: 'weekly' | 'monthly'
}

export type EntryKind = 'credit' | 'debit' | 'transfer' | 'exchange' | 'interest' | 'adjustment'

export interface Leg {
  account: string
  currency: string
  amountMinor: number // signed
}

export interface Entry {
  v: 1
  id: string
  child: string
  kind: EntryKind
  createdAt: number // unix seconds
  author: 'guardian' | 'child'
  legs: Leg[]
  category?: string
  note?: string
  link?: string
  requestId?: string
  reverses?: string
  auditId?: string
  periodKey?: string
}
