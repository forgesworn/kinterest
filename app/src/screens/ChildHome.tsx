// The child's landing screen: the jar (brand mark as UI) + a big balance, an
// accounts strip, an interest panel, and the child-language feed below. See
// internal plan 2026-08-11-child-mode, Task 3.
//
// Mirrors Home.tsx/ChildDetail.tsx's own split: pure, exported, DOM-free
// helpers (tested directly in ChildHome.test.ts, no React involved) plus a
// thin render shell underneath. Three groups of pure logic live here:
//   - `childOwnAccounts`/`childOwnEntries` — the ONE thing every other
//     helper and the render body itself is built on top of. The guardian
//     now sends each child only its own rows, but a device that ran an
//     older build may still hold a sibling's accounts or entries it was
//     sent then, so filtering by `state.self.pubkey` is not an optimisation
//     here: the child UI must never render a sibling's data. Every other function below takes
//     already-filtered `accounts`/`entries` rather than a whole `AppState`,
//     so there is exactly one place a future call site could get this wrong.
//   - the jar's own balance/high-water tracking (`jarState`, built on
//     `jarHighWaterMinor`) — derived purely from entry history, never a
//     separately persisted field (see components/Jar.tsx's own header on why
//     `highWaterMinor` is a plain argument, not something jarFill itself
//     remembers). `jarState`'s own doc comment covers a review finding worth
//     repeating here: `jarFill`'s balance and high-water arguments MUST be
//     computed over the SAME account scope, or a converted second-currency
//     balance can inflate the fill relative to a high-water mark that never
//     tracked it.
//   - the interest panel's three friendly formatters (rate/countdown/
//     projection) — reusing Home.tsx's own `nextDueDay` (exported for
//     exactly this) and domain/interest.ts's `project`, never re-deriving
//     either's due-day/compounding maths.

import type { ReactElement } from 'react'
import { balances, sortForDisplay } from '../domain/ledger'
import { dayKey } from '../domain/period'
import { project, projectBalance } from '../domain/interest'
import type { InterestConfig } from '../domain/interest'
import type { Account, Entry } from '../domain/types'
import type { AppState } from '../state/types'
import { Button, Card, EmptyState, ListRow, Screen } from '../components/ui'
import { Money } from '../components/Money'
import { Jar, jarFill } from '../components/Jar'
import { useApp } from '../store/store'
import { approxTotal, nextDueDay } from './Home'
import { shortNpub } from './familyRoot'
import { buildChildFeed } from './childFeed'

// ============================================================================
// Self-scoping — see this module's header. The one gate every other helper
// and the screen body itself is built on.
// ============================================================================

export function childOwnAccounts(app: AppState): Account[] {
  if (app.self.pubkey === null) return []
  return app.docs.accounts.accounts.filter((a) => a.child === app.self.pubkey && !a.archived)
}

export function childOwnEntries(app: AppState): Entry[] {
  if (app.self.pubkey === null) return []
  return app.entries.filter((e) => e.child === app.self.pubkey)
}

// ============================================================================
// The jar's high-water mark — the largest running balance `entries` has ever
// shown across `accountIds`, folded chronologically. Pure; never persisted
// separately (see this module's header).
// ============================================================================

/** Restricted to a single set of same-currency accounts, same reasoning as
 *  Home.tsx's own `approxTotal`: summing minor units across currencies is
 *  meaningless, and there is no per-point-in-time exchange rate to convert
 *  by (only the MOST RECENT one — feed.ts's `lastExchangeRate` — which would
 *  misrepresent history). A documented v1 simplification: a child holding a
 *  second currency's jar growth in that currency is not reflected in this
 *  total's high-water mark. `entries` need not be pre-filtered to
 *  `accountIds` — legs naming any other account are simply ignored. */
export function jarHighWaterMinor(entries: Entry[], accountIds: readonly string[]): number {
  const ids = new Set(accountIds)
  let running = 0
  let max = 0
  for (const entry of sortForDisplay(entries)) {
    for (const leg of entry.legs) {
      if (ids.has(leg.account)) running += leg.amountMinor
    }
    if (running > max) max = running
  }
  return max
}

/** Sums `accounts`' balances per currency — the shape `approxTotal` wants.
 *  Mirrors Home.tsx's own private `balancesByCurrency` (not exported there —
 *  small enough, and specific enough to this screen's own account list, that
 *  duplicating it here is clearer than widening that module's exports). */
function balancesByCurrency(accounts: Account[], entryBalances: Map<string, number>): { currency: string; balanceMinor: number }[] {
  const byCurrency = new Map<string, number>()
  for (const account of accounts) {
    const bal = entryBalances.get(account.id) ?? 0
    byCurrency.set(account.currency, (byCurrency.get(account.currency) ?? 0) + bal)
  }
  return [...byCurrency.entries()].map(([currency, balanceMinor]) => ({ currency, balanceMinor }))
}

export interface JarState {
  currency: string
  balanceMinor: number
  highWaterMinor: number
  fill: number
}

/** The jar hero's whole balance/fill computation, bundled so its numerator
 *  and denominator can never drift apart the way they did before this fix:
 *  `jarFill`'s two arguments MUST share the same account scope, or a
 *  converted second-currency balance can inflate the fill relative to a
 *  high-water mark that never tracked it (found by review — an EARLIER
 *  version of this function fed `jarFill` a `total` computed over EVERY
 *  account via `approxTotal`, converting a foreign-currency balance into
 *  `homeCurrency`, while `highWaterMinor` stayed scoped to `homeAccounts`
 *  only; a child with, say, a BTC pot worth £50 today would see the jar
 *  read as if it held £50 more than its own history ever recorded).
 *
 *  `accounts` -> `homeCurrency` (the FIRST active account's currency —
 *  Home.tsx's own convention; no family-wide currency setting exists) ->
 *  `homeAccounts`, the SAME filtered set feeding both `approxTotal` (via
 *  `balancesByCurrency`, restricted to `homeAccounts` so it never converts a
 *  foreign currency in — `total.approx` is therefore always `false` here)
 *  and `jarHighWaterMinor`. A second-currency pot is simply never part of
 *  the jar's own maths; it still appears, with its own balance/currency, in
 *  the accounts strip below (ChildHome's own render body) — this is a
 *  deliberate v1 scope-narrowing, not a lost feature: "the jar shows
 *  home-currency reality", per review.
 *
 *  `accounts` must be non-empty (ChildHome's own empty-state branch handles
 *  that case before ever calling this). */
export function jarState(accounts: Account[], entries: Entry[]): JarState {
  const homeCurrency = accounts[0]!.currency
  const homeAccounts = accounts.filter((a) => a.currency === homeCurrency)
  const homeAccountIds = homeAccounts.map((a) => a.id)
  const entryBalances = balances(entries)
  const total = approxTotal(balancesByCurrency(homeAccounts, entryBalances), homeCurrency, entries)
  const highWaterMinor = jarHighWaterMinor(entries, homeAccountIds)
  return { currency: homeCurrency, balanceMinor: total.totalMinor, highWaterMinor, fill: jarFill(total.totalMinor, highWaterMinor) }
}

// ============================================================================
// Interest panel — friendly formatters. No pubkeys/bps/period keys reach the
// child: `friendlyInterestRate` turns raw bps + a weekday/day-of-month number
// into "2% every Friday"/"2% on the 1st of the month"; `interestCountdownLabel`
// turns a due day into "wait N more weeks"; `nextInterestProjection` is the
// ONE next payment's compounded result (domain/interest.ts's own `project`,
// never re-derived).
// ============================================================================

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function weekdayName(isoWeekday: number): string {
  const clamped = Math.min(Math.max(Math.trunc(isoWeekday), 1), 7)
  return WEEKDAY_NAMES[clamped - 1]!
}

function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/** Integer basis points -> a percent string, e.g. `200` -> "2%", `350` ->
 *  "3.5%", `1` -> "0.01%". The inverse direction of
 *  screens/settingsForms.ts#parsePercentToBps (that module only ever PARSES
 *  a guardian's typed input; this is the first place anything needs to go
 *  the other way, for child-facing display). Total against garbage input
 *  (never reaches a throw mid-render) — degrades to "0%", same "fail closed
 *  in a render path" spirit as ChildSettings.tsx's own projection-preview
 *  guard. */
export function formatBpsAsPercent(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return '0%'
  const whole = Math.trunc(bps / 100)
  const frac = Math.round(bps) % 100
  if (frac === 0) return `${whole}%`
  const fracStr = frac % 10 === 0 ? String(frac / 10) : String(frac).padStart(2, '0')
  return `${whole}.${fracStr}%`
}

/** "2% every Friday" (weekly) / "2% on the 1st of the month" (monthly) —
 *  the ONLY place `cfg.day`/`cfg.cadence` reach the child as prose rather
 *  than a raw number/enum. */
export function friendlyInterestRate(cfg: Pick<InterestConfig, 'rateBps' | 'cadence' | 'day'>): string {
  const pct = formatBpsAsPercent(cfg.rateBps)
  const when = cfg.cadence === 'weekly' ? `every ${weekdayName(cfg.day)}` : `on the ${ordinal(cfg.day)} of the month`
  return `${pct} ${when}`
}

/** 'YYYY-MM-DD' -> a UTC timestamp for that calendar day — the same regex
 *  shape domain/period.ts's own private `parse` uses (not itself exported,
 *  so this is a small, deliberate duplicate rather than a widened export for
 *  one caller). A malformed key (should never happen — both call sites below
 *  come from `dayKey`/`nextDueDay`) degrades to epoch 0 rather than an
 *  `undefined`-propagating `NaN`, keeping `daysBetween` a total function. */
function utcMsOf(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return 0
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 'YYYY-MM-DD' day-key arithmetic, same technique domain/period.ts's own
 *  functions use internally (no timezone of its own — both keys are already
 *  resolved to a specific calendar day by the caller). */
function daysBetween(fromDayKey: string, toDayKey: string): number {
  return Math.round((utcMsOf(toDayKey) - utcMsOf(fromDayKey)) / 86_400_000)
}

/** `dueDay`/`todayDayKey` are both 'YYYY-MM-DD' — `dueDay` from
 *  `nextDueDay` (Home.tsx, exported for exactly this reuse), `todayDayKey`
 *  from `domain/period.ts#dayKey`. `null` (no interest set up, or paused) ->
 *  a calm "not set up" line rather than a blank panel. */
export function interestCountdownLabel(dueDay: string | null, todayDayKey: string): string {
  if (dueDay === null) return 'No interest day set up yet'
  const days = daysBetween(todayDayKey, dueDay)
  if (days <= 0) return 'Interest day is today!'
  if (days === 1) return 'Interest day is tomorrow!'
  if (days < 7) return `Interest day in ${days} days`
  const weeks = Math.ceil(days / 7)
  return `Wait ${weeks} more week${weeks === 1 ? '' : 's'} for interest day`
}

/** The balance after exactly the NEXT interest payment (one compounding
 *  period of `domain/interest.ts#project`, no further deposits assumed) —
 *  the "→ £X" half of "wait N more weeks → £X". `null` on any arithmetic
 *  failure (an absurd `rateBps`/`currentBalanceMinor` overflowing safe-
 *  integer maths) rather than throwing mid-render — same guard
 *  ChildSettings.tsx's own projection preview applies to the SAME
 *  underlying `project` call. */
export function nextInterestProjection(rateBps: number, currentBalanceMinor: number): number | null {
  try {
    const [projected] = project(currentBalanceMinor, rateBps, 1)
    return projected ?? null
  } catch {
    return null
  }
}

/** How far ahead the child's "leave it" projection looks (v1 spec: "leave
 *  it 4 more weeks and it's £X") — counted in interest periods, so a
 *  monthly schedule reads "4 more months". */
export const PROJECTION_PERIODS = 4

/** The "leave it" line's words and amount: the balance after
 *  `PROJECTION_PERIODS` compounding interest payments, no further deposits
 *  (domain/interest.ts#projectBalance). `null` on any arithmetic failure
 *  rather than throwing mid-render. */
export function leaveItProjection(
  cfg: Pick<InterestConfig, 'rateBps' | 'cadence'>,
  currentBalanceMinor: number,
): { label: string; minor: number } | null {
  try {
    const minor = projectBalance(currentBalanceMinor, cfg.rateBps, PROJECTION_PERIODS)
    const unit = cfg.cadence === 'weekly' ? 'weeks' : 'months'
    return { label: `Leave it ${PROJECTION_PERIODS} more ${unit} and it's`, minor }
  } catch {
    return null
  }
}

// ============================================================================
// Screen
// ============================================================================

// `onAsk`/`onChores`/`onAudit` — screens/ChildShell.tsx (Tasks 4/5) — open the
// three screens this jar home is the launchpad for: asking for money
// (screens/Ask.tsx), today's chores (screens/Chores.tsx), and the coin-count
// audit ceremony (screens/Audit.tsx). Neither screen's own state (the
// pending-asks list, the chores gate, the count-in-progress) is duplicated
// here — this is still just the jar + feed, with three buttons onto them.
// `onAudit` is always shown, same as `onAsk`/`onChores` — Audit.tsx owns its
// own "no physical pots yet" empty state, exactly like Ask.tsx's "no pots"
// and Chores.tsx's "no chores".
export function ChildHome({ onAsk, onChores, onAudit }: { onAsk: () => void; onChores: () => void; onAudit: () => void }): ReactElement {
  const { state } = useApp()
  const { app } = state
  const selfPk = app.self.pubkey

  if (selfPk === null) {
    return (
      <Screen title="Jar">
        <EmptyState title="Almost there">Ask whoever set this up to finish pairing this device.</EmptyState>
      </Screen>
    )
  }

  const accounts = childOwnAccounts(app)
  const entries = childOwnEntries(app)
  const entryBalances = balances(entries)
  const nowSec = Math.floor(Date.now() / 1000)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  if (accounts.length === 0) {
    return (
      <Screen title="Jar">
        <EmptyState title="Your jar is on its way">
          Ask whoever set this up to add your first pot.
        </EmptyState>
      </Screen>
    )
  }

  // See jarState's own doc comment: the jar's balance and its high-water
  // mark must share the SAME account scope (home-currency only), or a
  // converted second-currency balance can inflate fill without ever having
  // grown the high-water mark that's supposed to cap it.
  const jar = jarState(accounts, entries)

  const interestCfg = app.docs.interest.configs.find((c) => c.child === selfPk && !c.paused)
  const interestAccount = interestCfg !== undefined ? accounts.find((a) => a.id === interestCfg.account) : undefined
  const interestBalance = interestAccount !== undefined ? entryBalances.get(interestAccount.id) ?? 0 : 0
  const interestTodayKey = dayKey(nowSec, interestCfg?.tz ?? tz)
  const interestDueDay = interestCfg !== undefined ? nextDueDay(interestCfg, nowSec) : null
  const interestProjected = interestCfg !== undefined ? nextInterestProjection(interestCfg.rateBps, interestBalance) : null
  const leaveIt = interestCfg !== undefined && interestBalance > 0 ? leaveItProjection(interestCfg, interestBalance) : null

  const feedGroups = buildChildFeed(entries, accounts, tz, nowSec)

  // The family root, quietly (v0.2 spec §1.8): a child device only ever
  // holds a root that VERIFIED against the guardian it paired with
  // (pairing.ts#acceptPairOffer), so showing it is showing a checked fact.
  const root = app.root
  const familyLine =
    root !== null && root.kind === 'signet'
      ? `Family of ${root.displayName !== undefined && root.displayName.trim() !== '' ? root.displayName : shortNpub(root.pubkey)}`
      : null

  return (
    <Screen title="Your jar">
      <div className="jar-hero">
        <Jar fill={jar.fill} />
        <div className="jar-hero-balance">
          <Money currency={jar.currency} minor={jar.balanceMinor} size="lg" />
        </div>
        {familyLine !== null && <p className="card-sub">{familyLine}</p>}
      </div>

      <Card>
        {accounts.map((a) => (
          <ListRow key={a.id} title={a.name} trailing={<Money currency={a.currency} minor={entryBalances.get(a.id) ?? 0} />} />
        ))}
      </Card>

      <div className="quick-actions-row">
        <Button variant="quiet" onClick={onAsk}>
          Ask
        </Button>
        <Button variant="quiet" onClick={onChores}>
          Chores
        </Button>
        <Button variant="quiet" onClick={onAudit}>
          Count your jar
        </Button>
      </div>

      {interestCfg !== undefined && interestAccount !== undefined && (
        <Card>
          <p className="card-title">Interest</p>
          <p className="card-sub">{friendlyInterestRate(interestCfg)}</p>
          <p className="card-sub">{interestCountdownLabel(interestDueDay, interestTodayKey)}</p>
          {interestProjected !== null && interestDueDay !== null && (
            <p className="card-sub">
              Then you'll have <Money currency={interestAccount.currency} minor={interestProjected} size="sm" />
            </p>
          )}
          {leaveIt !== null && interestDueDay !== null && (
            <p className="card-sub">
              {leaveIt.label} <Money currency={interestAccount.currency} minor={leaveIt.minor} size="sm" />
            </p>
          )}
        </Card>
      )}

      {feedGroups.length === 0 ? (
        <EmptyState title="Nothing here yet">Money moved for you will show up here.</EmptyState>
      ) : (
        feedGroups.map((group) => (
          <div key={group.dayKey} className="feed-group">
            <h2 className="feed-day">{group.label}</h2>
            <Card>
              {group.rows.map((row) => (
                <ListRow
                  key={row.id}
                  leading={
                    <span className="feed-icon" aria-hidden="true">
                      {row.icon}
                    </span>
                  }
                  title={row.title}
                  sub={row.sub}
                  trailing={<Money currency={row.currency} minor={row.amountMinor} size="sm" />}
                />
              ))}
            </Card>
          </div>
        ))
      )}
    </Screen>
  )
}
