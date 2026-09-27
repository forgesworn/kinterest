// Pure form -> config builders behind ChildSettings.tsx. See
// internal plan 2026-08-11-parent-mode, Task 6.
//
// Deliberately mirrors QuickActions.tsx's own split: every function here is
// a total, DOM-free transform over a config doc's list (Account[] /
// AllowanceConfig[] / InterestConfig[] / Chore[]) plus whatever raw text a
// form field held, returning either the next list or `null` for anything
// invalid — never throwing (same "boundary parser, fail closed" spirit as
// components/MoneyInput.tsx's `parseAmount`, which several builders below
// reuse directly rather than re-deriving amount parsing). ChildSettings.tsx
// itself is a thin screen: it owns `useState` for form text, calls one of
// these on submit, and — only on a non-null result — hands the resulting
// list to `store.tsx#stampConfigDoc`/`applyConfigDoc` to publish.
//
// Every list-mutating function is a no-op-safe builder over the FULL config
// doc list, not a single child's slice: `accounts`/`chores` hold every
// child's items in one array (an `Account`/`Chore`'s own `child` field is
// what scopes it), and `allowance`/`interest` hold at most one config per
// child (`upsertByChild` below). This matches how the docs themselves are
// shaped (state/types.ts's `ConfigDocs`) and is why a caller editing one
// child's settings must always pass the WHOLE current list in and publish
// the WHOLE list back out — a doc is full-state replaceable, per
// state/state.ts#applyConfigDoc's own header.

import { currencyOrThrow } from '../domain/money'
import { DENOMINATIONS } from '../domain/audit'
import { parseAmount } from '../components/MoneyInput'
import type { Account } from '../domain/types'
import type { AllowanceConfig } from '../domain/allowance'
import type { InterestConfig } from '../domain/interest'
import type { Chore } from '../domain/chores'

export type AuditCadence = 'weekly' | 'monthly'

// ============================================================================
// Day-bounds validation — mirrors domain/period.ts#dueDays' own bounds
// exactly (weekly: ISO weekday 1-7; monthly: day-of-month 1-31, clamped to
// short months by dueDays itself). Validating here, at the form boundary,
// means a bad day value is refused with a message the guardian can act on
// immediately, rather than surfacing later as an uncaught RangeError deep
// inside the scheduler the next time it runs.
// ============================================================================

export function validDay(cadence: 'weekly' | 'monthly', day: number): boolean {
  if (!Number.isSafeInteger(day)) return false
  return cadence === 'weekly' ? day >= 1 && day <= 7 : day >= 1 && day <= 31
}

// ============================================================================
// Percent -> bps — Task 6's "rateBps via % input ×100 with edge-tested
// conversion e.g. '3.5' -> 350"
// ============================================================================

/** Parses a percent-input string into integer basis points (1% = 100bps),
 *  e.g. "3.5" -> 350, "3.5%" -> 350, "3" -> 300, "0.01" -> 1. A trailing '%'
 *  is stripped first; otherwise this is the exact whole/fraction
 *  decomposition `components/MoneyInput.tsx#parseAmount` uses (deliberately
 *  NOT `Number(text) * 100`, which drags in binary-float error for figures
 *  like "3.5" — see parseAmount's own header on preferring integer digit
 *  arithmetic to floating-point money-adjacent maths).
 *
 *  Rejects: "", whitespace-only, a bare '%', a negative amount, a leading
 *  '+', more than 2 decimal places (a THIRD decimal place would name a
 *  fractional basis point, which cannot exist — "3.555%" has no integer bps
 *  representation, so this is refused rather than rounded, matching
 *  parseAmount's own "reject, never round/truncate" rule for money), anything
 *  that would overflow a safe integer, and — see `MAX_BPS` below — anything
 *  over 1000%. Never throws. */
export function parsePercentToBps(text: string): number | null {
  const trimmed = text.trim().replace(/%\s*$/, '').trim()
  if (trimmed === '') return null

  const dotIndex = trimmed.indexOf('.')
  const wholePart = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex)
  const fracPart = dotIndex === -1 ? '' : trimmed.slice(dotIndex + 1)
  if (wholePart === '' || !/^\d+$/.test(wholePart)) return null
  if (dotIndex !== -1 && !/^\d+$/.test(fracPart)) return null
  if (fracPart.length > 2) return null // reject, never round — a 3rd dp names no real bps

  const bps = Number(wholePart) * 100 + Number(fracPart.padEnd(2, '0'))
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > MAX_BPS) return null
  return bps
}

/** 1000% (100000 bps) — generous headroom for a deliberately inflated
 *  teaching/demo rate, but safely below anything that could reach
 *  `domain/interest.ts#interestMinor`'s own overflow guard
 *  (`balanceMinor * rateBps` must stay a safe integer). Found by review: an
 *  UNBOUNDED `parsePercentToBps` let a guardian type an enormous rate that
 *  then threw a RangeError from TWO places with no error boundary anywhere
 *  to catch it — `ChildSettings.tsx`'s own projection preview, on every
 *  keystroke, and (once saved) `store/scheduler.ts`'s reducer updater, on
 *  EVERY app launch — either of which unmounted the whole React tree
 *  (the guardian app "bricked" until manual localStorage surgery). This cap
 *  is the first of three defence-in-depth layers closing that: see
 *  `ChildSettings.tsx`'s projection preview `try/catch` and
 *  `store/scheduler.ts`'s per-config `try/catch` for the other two — this
 *  one stops the bad value at the FORM boundary, before it is ever saved,
 *  but the other two remain load-bearing regardless (a config already
 *  sitting in state from before this cap existed, a hand-edited
 *  `localStorage` blob, or a future caller of `domain/interest.ts` directly
 *  must never be able to crash the app either). */
const MAX_BPS = 100_000

// ============================================================================
// Accounts — "add/rename/archive; custody + currency fixed at creation"
// ============================================================================

export interface NewAccountInput {
  id: string
  child: string
  name: string
  currency: string
  custody: Account['custody']
}

/** `null` = fine. Otherwise a plain-language error for the user (v0.2 spec
 *  §4.4). A 'physical' account is a real jar of real coins, and the whole
 *  coin-counting ceremony (screens/Audit.tsx, domain/audit.ts) is driven by
 *  `DENOMINATIONS[currency]` — a currency with no denomination table has
 *  nothing to count, so the ceremony would open on an empty list with no
 *  way out. Refusing the pot at creation is the only point at which that is
 *  fixable: custody and currency are both frozen thereafter (see this
 *  module's header). Pure.
 *
 *  `hasOwnProperty`, not a bare index: `DENOMINATIONS` is a plain object, so
 *  a currency string of 'constructor' or 'toString' would otherwise find an
 *  inherited member and read as a currency with coins. */
export function custodyCurrencyError(custody: Account['custody'], currency: string): string | null {
  if (custody !== 'physical') return null
  if (Object.prototype.hasOwnProperty.call(DENOMINATIONS, currency)) return null
  return 'A coin jar needs a currency with real coins — pick pounds, euros or dollars, or choose a different kind of pot.'
}

/** Appends a new account. `id` is minted by the caller (`domain/id.ts#newId`,
 *  the same convention every other entry-shaped id in this app uses) rather
 *  than by this function, so a retried/duplicate submit is the caller's own
 *  idempotency problem to solve, not this pure builder's. `null` for: an
 *  empty (post-trim) name, an unrecognised currency code
 *  (`domain/money.ts#currencyOrThrow`), an `id` already present (a
 *  defensive collision guard — should never fire given `newId`'s randomness,
 *  but a silently-duplicated account id would corrupt every balance fold
 *  keyed by it), or a 'physical' custody in a currency with no coins
 *  (`custodyCurrencyError` just above). */
export function addAccount(accounts: Account[], input: NewAccountInput): Account[] | null {
  const name = input.name.trim()
  if (name === '') return null
  if (accounts.some((a) => a.id === input.id)) return null
  try {
    currencyOrThrow(input.currency)
  } catch {
    return null
  }
  if (custodyCurrencyError(input.custody, input.currency) !== null) return null
  const account: Account = { id: input.id, child: input.child, name, currency: input.currency, custody: input.custody }
  return [...accounts, account]
}

/** Renames an existing account (currency/custody are fixed at creation —
 *  see this module's header — so there is deliberately no `editAccount`
 *  that touches either). `null` for an empty (post-trim) name or an
 *  unknown `id`. */
export function renameAccount(accounts: Account[], id: string, name: string): Account[] | null {
  const trimmed = name.trim()
  if (trimmed === '') return null
  if (!accounts.some((a) => a.id === id)) return null
  return accounts.map((a) => (a.id === id ? { ...a, name: trimmed } : a))
}

/** Archives/unarchives an account — a soft delete, never a removal: every
 *  entry referencing this account by id (domain/ledger.ts's `balances`)
 *  must keep resolving it. `null` for an unknown `id`. */
export function setAccountArchived(accounts: Account[], id: string, archived: boolean): Account[] | null {
  if (!accounts.some((a) => a.id === id)) return null
  return accounts.map((a) => (a.id === id ? { ...a, archived } : a))
}

/** Sets (or clears, via `undefined`) an account's audit-reminder cadence —
 *  see `Account.auditCadence`'s own doc comment (domain/types.ts). `null`
 *  for an unknown `id`. */
export function setAccountAuditCadence(accounts: Account[], id: string, auditCadence: AuditCadence | undefined): Account[] | null {
  if (!accounts.some((a) => a.id === id)) return null
  return accounts.map((a) => {
    if (a.id !== id) return a
    if (auditCadence === undefined) {
      const { auditCadence: _drop, ...rest } = a
      return rest as Account
    }
    return { ...a, auditCadence }
  })
}

// ============================================================================
// Shared: upsert-by-child — allowance/interest hold at most one config per
// child (see this module's header).
// ============================================================================

export function upsertByChild<T extends { child: string }>(configs: T[], next: T): T[] {
  const idx = configs.findIndex((c) => c.child === next.child)
  if (idx === -1) return [...configs, next]
  return configs.map((c, i) => (i === idx ? next : c))
}

// ============================================================================
// Allowance
// ============================================================================

export interface AllowanceFormInput {
  child: string
  account: string
  /** The account's own currency — parses `amountRaw` against it. */
  currency: string
  amountRaw: string
  cadence: 'weekly' | 'monthly'
  day: number
  /** Auto-detected ONCE at creation (`Intl.DateTimeFormat().resolvedOptions().tz`
   *  — the screen's job, per Task 6's brief) and kept stable across edits;
   *  this builder has no opinion on where it came from, only that it is
   *  non-empty. */
  tz: string
  /** Likewise fixed at creation (the schedule's own anchor —
   *  domain/allowance.ts's `allowanceDue`/`legitimatePeriodKeys` scan
   *  forward from it); changing it on every edit would silently reopen or
   *  close already-paid periods. */
  startDay: string
  paused: boolean
  choresGate: boolean
  auditGate: boolean
}

/** `null` for: `amountRaw` failing `parseAmount` (empty, non-positive, wrong
 *  decimals — see that function's own header), an out-of-bounds `day` for
 *  `cadence` (`validDay`), or an empty `tz`/`startDay`. */
export function buildAllowanceConfig(input: AllowanceFormInput): AllowanceConfig | null {
  const amountMinor = parseAmount(input.amountRaw, input.currency)
  if (amountMinor === null) return null
  if (!validDay(input.cadence, input.day)) return null
  if (input.tz.trim() === '' || input.startDay.trim() === '') return null
  return {
    child: input.child,
    account: input.account,
    amountMinor,
    cadence: input.cadence,
    day: input.day,
    tz: input.tz,
    startDay: input.startDay,
    paused: input.paused,
    choresGate: input.choresGate,
    auditGate: input.auditGate,
  }
}

// ============================================================================
// Interest
// ============================================================================

export interface InterestFormInput {
  child: string
  account: string
  /** The account's own currency — parses `matchCapRaw` against it (a money
   *  amount); `rateRaw`/`matchRaw` are percentages, currency-independent. */
  currency: string
  rateRaw: string
  cadence: 'weekly' | 'monthly'
  day: number
  tz: string
  startDay: string
  /** Optional — empty/whitespace-only means "no match configured" (`undefined`
   *  on the resulting config), matching `InterestConfig.matchBps`'s own
   *  optionality rather than treating "0%" and "unset" as the same thing. */
  matchRaw?: string
  /** Optional, same convention as `matchRaw` — a money amount, not a
   *  percentage (`InterestConfig.matchCapMinor`). */
  matchCapRaw?: string
  paused: boolean
}

/** `null` for: `rateRaw` failing `parsePercentToBps`, an out-of-bounds `day`
 *  for `cadence`, an empty `tz`/`startDay`, a non-empty `matchRaw` that
 *  fails `parsePercentToBps`, or a non-empty `matchCapRaw` that fails
 *  `parseAmount`. */
export function buildInterestConfig(input: InterestFormInput): InterestConfig | null {
  const rateBps = parsePercentToBps(input.rateRaw)
  if (rateBps === null) return null
  if (!validDay(input.cadence, input.day)) return null
  if (input.tz.trim() === '' || input.startDay.trim() === '') return null

  let matchBps: number | undefined
  if (input.matchRaw !== undefined && input.matchRaw.trim() !== '') {
    const parsed = parsePercentToBps(input.matchRaw)
    if (parsed === null) return null
    matchBps = parsed
  }

  let matchCapMinor: number | undefined
  if (input.matchCapRaw !== undefined && input.matchCapRaw.trim() !== '') {
    const parsed = parseAmount(input.matchCapRaw, input.currency)
    if (parsed === null) return null
    matchCapMinor = parsed
  }

  return {
    child: input.child,
    account: input.account,
    rateBps,
    cadence: input.cadence,
    day: input.day,
    tz: input.tz,
    startDay: input.startDay,
    paused: input.paused,
    ...(matchBps !== undefined ? { matchBps } : {}),
    ...(matchCapMinor !== undefined ? { matchCapMinor } : {}),
  }
}

// ============================================================================
// Chores — "checklist CRUD"
// ============================================================================

export interface NewChoreInput {
  id: string
  child: string
  name: string
  cadence: Chore['cadence']
}

/** `null` for an empty (post-trim) name or an `id` already present (same
 *  defensive collision guard as `addAccount`). */
export function addChore(chores: Chore[], input: NewChoreInput): Chore[] | null {
  const name = input.name.trim()
  if (name === '') return null
  if (chores.some((c) => c.id === input.id)) return null
  return [...chores, { id: input.id, child: input.child, name, cadence: input.cadence }]
}

export function renameChore(chores: Chore[], id: string, name: string): Chore[] | null {
  const trimmed = name.trim()
  if (trimmed === '') return null
  if (!chores.some((c) => c.id === id)) return null
  return chores.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
}

export function setChoreCadence(chores: Chore[], id: string, cadence: Chore['cadence']): Chore[] | null {
  if (!chores.some((c) => c.id === id)) return null
  return chores.map((c) => (c.id === id ? { ...c, cadence } : c))
}

/** Soft delete, same reasoning as `setAccountArchived`: a `ChoreTick`
 *  references a chore by id (domain/chores.ts's `tickedDays`), so a
 *  genuinely removed chore would orphan its own history. */
export function setChoreArchived(chores: Chore[], id: string, archived: boolean): Chore[] | null {
  if (!chores.some((c) => c.id === id)) return null
  return chores.map((c) => (c.id === id ? { ...c, archived } : c))
}
