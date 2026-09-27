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
  /** A ULID (domain/id.ts#newId) for anything a person does. Two kinds of
   *  entry deliberately use a deterministic id instead, contrary to v1's
   *  "entryId is a ULID" (audit S5): scheduler payouts
   *  (`sched:<kind>:<child>:<account>:<due day>`, store/scheduler.ts) and
   *  approved requests (`grant:<reqId>`, store/store.tsx). The same payout
   *  must get the same id however many times, or on however many devices,
   *  it is computed — `addEntry` dedupes by id, and that is what makes a
   *  re-run catch-up or a retried approval idempotent. A random ULID would
   *  let two computations of one payout both land. Keep them. */
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
  /** `adjustment` only: the audit this adjustment resolves (v1 §Entries:
   *  "requires the audit reference"). Optional on the type so entries stored
   *  or sent before it was set by every builder still parse (audit S3). */
  auditId?: string
  /** `adjustment` only: the counted total, minor units (v1 §Entries: an
   *  adjustment "carries the counted total and the delta"; the delta is the
   *  leg). Additive/optional for the same reason as `auditId`. */
  countedMinor?: number
  periodKey?: string
}
