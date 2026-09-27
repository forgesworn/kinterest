import type { ReactElement } from 'react'
import { moneyParts } from '../domain/money'
import type { MoneyParts } from '../domain/money'

// moneyParts is the shared structured breakdown behind formatMinor's string
// output (domain/money.ts) — re-exported here so existing importers of
// './Money' keep working. Money styles the sign, symbol, digits and unit
// independently (serif tabular digits, coloured sign, small-caps unit)
// without re-parsing formatted text.
export { moneyParts }
export type { MoneyParts }

export type MoneySize = 'sm' | 'md' | 'lg'

// Credits (money coming in) are picked out in --good; debits stay plain
// --ink, deliberately un-alarming — see Global Constraints (banking-app
// warmth, not a red-ink ledger). Zero counts as a debit (nothing arrived).
export function Money({
  currency,
  minor,
  size = 'md',
  className = '',
}: {
  currency: string
  minor: number
  size?: MoneySize
  className?: string
}): ReactElement {
  const parts = moneyParts(currency, minor)
  const tone = minor > 0 ? 'credit' : 'debit'
  return (
    <span className={`money money-${size} money-${tone} ${className}`.trim()}>
      {parts.sign}
      {parts.prefix}
      {parts.whole}
      {parts.fraction !== null && <span className="money-frac">.{parts.fraction}</span>}
      {parts.suffix !== null && <span className="money-unit"> {parts.suffix}</span>}
    </span>
  )
}
