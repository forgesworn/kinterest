// A text input for entering a money amount, plus the pure parser behind it.
// See internal plan 2026-08-11-parent-mode, Task 4: "amounts
// entered in a MoneyInput (integer-safe: parses '4.50' -> 450, rejects
// >2dp, pure parser parseAmount tested hard)".
//
// Deliberately the mirror image of Money.tsx (components/Money.tsx renders
// minor units OUT; this parses typed text INTO minor units) — kept as its
// own component rather than folded into Money.tsx because the two have no
// shared rendering concerns, only the same currency table.

import type { ChangeEvent, ReactElement } from 'react'
import { currencyOrThrow } from '../domain/money'

/** True when `digits` is either a bare digit run OR strictly 3-digit
 *  comma-grouped ("1,000", "12,345,678") — deliberately NOT "any comma is a
 *  thousands separator, strip and move on": that reading would silently
 *  accept "4,50" as if the comma weren't there at all (450, then ×100 —
 *  a 100x error hiding what is far more likely a European-style decimal
 *  typo, £4.50 mistyped with a comma). An ambiguous or malformed comma
 *  placement must REJECT, never guess. */
function isValidGrouping(digits: string): boolean {
  return /^\d{1,3}(,\d{3})*$/.test(digits) || /^\d+$/.test(digits)
}

/** Parses user-typed `text` into safe-integer minor units for `currencyCode`,
 *  or `null` if it doesn't represent a valid POSITIVE amount for that
 *  currency. Never throws — this is a boundary parser for raw keyboard
 *  input, in the same "total, fail-closed" spirit as wire/payloads.ts's
 *  parseX functions, just for a different kind of untrusted input.
 *
 *  Fiat currencies (GBP/EUR/USD, 2dp): plain decimal text, comma thousands
 *  separators accepted ONLY in strict 3-digit groups ("1,000" -> 100000;
 *  "4,50" is REJECTED, not reinterpreted as 450 — see `isValidGrouping`),
 *  MORE than the currency's decimals is REJECTED outright rather than
 *  rounded or truncated (a typo like "0.005" must not silently become
 *  "0.01" or "0.00" behind the guardian's back — see Global Constraints on
 *  integer money).
 *
 *  BTC (8dp): entered directly as an integer number of SATS, not major-unit
 *  BTC with a decimal point — sats already ARE the minor unit here (see
 *  domain/money.ts), and nobody keys "0.00001234" for a bitcoin gift. A
 *  decimal point in BTC input is therefore always rejected, not merely
 *  "too many decimals" — there is no correct number of them.
 *
 *  Rejects: "", whitespace-only, "-" and any negative amount (this parses
 *  an AMOUNT, never a signed leg — direction is the caller's business, via
 *  which ledger.ts constructor it calls), "0" (every ledger.ts entry
 *  constructor requires a strictly positive amount; asking the guardian to
 *  enter "0" and having it silently vanish is worse than refusing it here —
 *  UNLESS the caller passes `{ allowZero: true }`, see below), a lone "."
 *  or a "." with nothing on one side ("4.", ".5"), a leading "+", scientific
 *  notation ("1e3"), non-numeric junk, and anything that would overflow a
 *  safe integer.
 *
 *  `allowZero` (default false): QuickActions.tsx's "Settle up" is the one
 *  flow that asks for an ACTUAL counted amount, not a positive movement —
 *  a pot that has genuinely been spent down to nothing must still be
 *  settle-able to £0 (v0.2 spec). Every other
 *  caller (Add/Take/Transfer/Exchange, ChildSettings' allowance/interest/
 *  match-cap fields) keeps the strict positive-only default. */
export function parseAmount(text: string, currencyCode: string, opts?: { allowZero?: boolean }): number | null {
  const spec = currencyOrThrow(currencyCode)
  const trimmed = text.trim()
  if (trimmed === '') return null
  const allowZero = opts?.allowZero === true

  if (spec.code === 'BTC') {
    if (!isValidGrouping(trimmed)) return null
    const sats = Number(trimmed.replace(/,/g, ''))
    if (!Number.isSafeInteger(sats) || sats < 0 || (sats === 0 && !allowZero)) return null
    return sats
  }

  const dotIndex = trimmed.indexOf('.')
  const wholePart = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex)
  const fracPart = dotIndex === -1 ? '' : trimmed.slice(dotIndex + 1)
  if (wholePart === '' || !isValidGrouping(wholePart)) return null
  // A second '.' ends up inside fracPart too (e.g. "4.5.0"'s fracPart is
  // "5.0") — the plain-digits check below rejects it the same way as any
  // other non-digit junk, with no special-casing needed.
  if (dotIndex !== -1 && !/^\d+$/.test(fracPart)) return null
  if (fracPart.length > spec.decimals) return null // reject, never round/truncate

  const base = 10 ** spec.decimals
  const minor = Number(wholePart.replace(/,/g, '')) * base + Number(fracPart.padEnd(spec.decimals, '0'))
  if (!Number.isSafeInteger(minor) || minor < 0 || (minor === 0 && !allowZero)) return null
  return minor
}

export function MoneyInput({
  currency,
  rawValue,
  onRawChange,
  label,
  autoFocus,
  allowZero,
}: {
  currency: string
  /** The field's own text, owned by the caller (like `restoreInput` in
   *  Onboarding.tsx) — this component never keeps parsing state of its own,
   *  so the caller can freely call `parseAmount(rawValue, currency)` itself
   *  to decide whether a submit button is enabled. */
  rawValue: string
  onRawChange: (raw: string) => void
  label?: string
  autoFocus?: boolean
  /** Threads straight through to `parseAmount`'s own option of the same
   *  name — QuickActions.tsx's "Settle up" sets this so the field's own
   *  "Enter a valid amount" indicator agrees with the sheet's separate
   *  `parseAmount(raw, currency, { allowZero: true })` call for its submit
   *  button, rather than the two silently disagreeing about whether "0.00"
   *  is valid. */
  allowZero?: boolean
}): ReactElement {
  const spec = currencyOrThrow(currency)
  const parsed = parseAmount(rawValue, currency, { allowZero })
  const invalid = rawValue.trim() !== '' && parsed === null

  function handleChange(e: ChangeEvent<HTMLInputElement>): void {
    onRawChange(e.target.value)
  }

  return (
    <label className="money-input">
      {label && <span className="money-input-label">{label}</span>}
      <input
        className="text-input money-input-field"
        type="text"
        inputMode={spec.code === 'BTC' ? 'numeric' : 'decimal'}
        value={rawValue}
        onChange={handleChange}
        placeholder={spec.code === 'BTC' ? 'Sats' : `0.${'0'.repeat(spec.decimals)}`}
        aria-label={label ?? `Amount (${spec.code})`}
        aria-invalid={invalid}
        autoFocus={autoFocus}
      />
      {invalid && <span className="money-input-error">Enter a valid amount.</span>}
    </label>
  )
}
