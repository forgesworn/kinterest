// The guardian's family overview — one card per child. See
// internal plan 2026-08-11-parent-mode, Task 4.
//
// Three pure helpers exported and tested directly, PairDevice.tsx's pattern
// (a screen-local pure function plus its own sibling test, no DOM needed):
//   - `approxTotal` — a child's balance across every account, converted
//     into one "home" currency via the last-used exchange rate implied by
//     that child's own prior exchanges (feed.ts's `lastExchangeRate` — see
//     that module's header for why it's shared with QuickActions.tsx's
//     `suggestRate` rather than re-implemented here).
//   - `nextDates` — the next upcoming allowance/interest due day, via
//     domain/period.ts's `dueDays` run FORWARD from today rather than the
//     scheduler's own backward "what's overdue" scan (domain/allowance.ts's
//     `allowanceDue`/domain/interest.ts's `interestDue`).
//   - `pendingRequestCount` — counts a child's still-'pending' requests
//     straight out of `AppState.requests` (Task 5's durable, dedupe-by-reqId
//     registry — see state/state.ts's `upsertRequest`/`recordRequestDecision`
//     and StoredRequest's own doc comment on why 'dismissed'/'denied' are
//     statuses, never deletions). This REPLACES an earlier stopgap that
//     scanned `AppContextValue.effects` (store.tsx's bounded, in-memory-only
//     log) — that version could overcount forever, since an approved/denied
//     request never left that log — per the SDD ledger's Task 5 -> Task 7
//     carry-forward ("Home pendingRequestCount still reads stale effects log
//     instead of state.requests — Task 7 wiring must switch it").
//
// Wired into screens/GuardianShell.tsx (Task 7) via `onSelectChild`/
// `onApprovals`.

import type { ReactElement } from 'react'
import { balances } from '../domain/ledger'
import { addDays, dayKey, dueDays } from '../domain/period'
import { currencyOrThrow } from '../domain/money'
import type { Account, Entry } from '../domain/types'
import type { AllowanceConfig } from '../domain/allowance'
import type { InterestConfig } from '../domain/interest'
import type { AppState, ChildProfile, StoredRequest } from '../state/types'
import { Button, Card, EmptyState, Pill, Screen } from '../components/ui'
import { Money } from '../components/Money'
import { RelayStatusPill } from '../components/RelayStatusPill'
import { lastExchangeRate } from './feed'
import { useApp } from '../store/store'

// ============================================================================
// approxTotal
// ============================================================================

export interface ApproxTotal {
  currency: string
  totalMinor: number
  /** True when at least one account balance needed converting into
   *  `currency` — the card shows a "≈" prefix whenever this is true. A
   *  single-currency child (the common case) never sets this. */
  approx: boolean
}

/** `entries` supplies the last-used rate for any account currency that
 *  differs from `homeCurrency` — the SAME entries the caller already has
 *  for this child (there is no separate rates store; "last-used rates" IS
 *  the exchange entry history — see feed.ts's `lastExchangeRate`). A
 *  currency with no prior exchange to convert it by is left OUT of the
 *  total rather than guessed at (silently wrong is worse than silently
 *  incomplete for money) — such a total is still `approx: true`, since it
 *  is visibly missing something, not exact. */
export function approxTotal(
  accountBalances: { currency: string; balanceMinor: number }[],
  homeCurrency: string,
  entries: Entry[],
): ApproxTotal {
  const homeDecimals = currencyOrThrow(homeCurrency).decimals
  let totalMinor = 0
  let approx = false

  for (const { currency, balanceMinor } of accountBalances) {
    if (balanceMinor === 0) continue
    if (currency === homeCurrency) {
      totalMinor += balanceMinor
      continue
    }
    approx = true
    const rate = lastExchangeRate(entries, currency, homeCurrency)
    if (rate === null) continue // no known rate yet — excluded, never guessed
    const fromMajor = balanceMinor / 10 ** currencyOrThrow(currency).decimals
    totalMinor += Math.round(fromMajor * rate * 10 ** homeDecimals)
  }

  return { currency: homeCurrency, totalMinor, approx }
}

/** Sums a child's account balances per currency (several accounts can share
 *  one currency, e.g. two GBP pots) — the shape `approxTotal` above wants. */
function balancesByCurrency(accounts: Account[], entryBalances: Map<string, number>): { currency: string; balanceMinor: number }[] {
  const byCurrency = new Map<string, number>()
  for (const account of accounts) {
    const bal = entryBalances.get(account.id) ?? 0
    byCurrency.set(account.currency, (byCurrency.get(account.currency) ?? 0) + bal)
  }
  return [...byCurrency.entries()].map(([currency, balanceMinor]) => ({ currency, balanceMinor }))
}

/** The child's own "home" currency for their card total — no family-wide
 *  currency setting exists in AppState (that's a settings concept Task 6
 *  doesn't add either), so this picks the currency of the child's first
 *  active account, which is the account a guardian almost always sets up
 *  first and the one this app's UK-house-style defaults (domain/money.ts)
 *  point towards anyway. 'GBP' if the child has no accounts at all yet. */
function homeCurrencyFor(accounts: Account[]): string {
  return accounts.find((a) => !a.archived)?.currency ?? 'GBP'
}

// ============================================================================
// nextDates
// ============================================================================

export interface NextDates {
  allowance: string | null
  interest: string | null
}

// Covers the longest possible gap between due days (a 31-day month) plus
// margin — a weekly or monthly cadence run forward this far from the scan's
// own starting point always lands on at least one due day.
const LOOKAHEAD_DAYS = 40

/** Lexical comparison is correct here — both are 'YYYY-MM-DD' day keys, the
 *  same trick domain/period.ts's own callers rely on. */
function laterDay(a: string, b: string): string {
  return a > b ? a : b
}

// Exported (not just used internally by `nextDates` below) so Plan 4's
// ChildHome.tsx interest panel can reuse the SAME "next due day, forward
// from today, clamped to a future startDay" logic rather than re-deriving
// it — see that screen's own countdown/projection helpers.
export function nextDueDay(cfg: { cadence: 'weekly' | 'monthly'; day: number; tz: string; startDay: string }, nowSec: number): string | null {
  const today = dayKey(nowSec, cfg.tz)
  // fromExclusive: today, UNLESS the config's own `startDay` is still ahead
  // of today — a due day can never fall before the schedule was configured
  // to start (domain/allowance.ts's `allowanceDue`/domain/interest.ts's
  // `interestDue` scan from `cfg.startDay` for exactly this reason). Without
  // this clamp, a wire-supplied config with a future `startDay` would still
  // let `dueDays`' pure calendar match (today, horizon] land on a cadence
  // day BEFORE that start, since `dueDays` itself has no `startDay` concept
  // of its own — it only ever sees whatever `fromExclusive` this caller
  // hands it.
  const fromExclusive = laterDay(today, addDays(cfg.startDay, -1))
  const horizon = addDays(fromExclusive, LOOKAHEAD_DAYS)
  // A cadence due exactly TODAY is either already paid by the scheduler or
  // awaiting an approvals-gate claim, not "upcoming"; this card is about
  // what's still ahead — `fromExclusive` above already excludes today
  // itself whenever `today >= startDay`.
  const days = dueDays({ cadence: cfg.cadence, day: cfg.day, fromExclusive, toInclusive: horizon })
  return days[0] ?? null
}

/** The next allowance/interest due day for one child, independently —
 *  either can be `null` (no config, or that config paused). */
export function nextDates(
  allowanceCfg: AllowanceConfig | undefined,
  interestCfg: InterestConfig | undefined,
  nowSec: number,
): NextDates {
  return {
    allowance: allowanceCfg !== undefined && !allowanceCfg.paused ? nextDueDay(allowanceCfg, nowSec) : null,
    interest: interestCfg !== undefined && !interestCfg.paused ? nextDueDay(interestCfg, nowSec) : null,
  }
}

// ============================================================================
// pendingRequestCount
// ============================================================================

/** Counts `childPubkey`'s still-'pending' requests in `AppState.requests`.
 *  `pair.claim` never reaches this registry at all (store.tsx's guardian-
 *  engine `onEffect` wiring excludes it before ever calling `upsertRequest`
 *  — that op is answered live by an open PairDevice ceremony, never from
 *  this badge), so no op filter is needed here. */
export function pendingRequestCount(requests: StoredRequest[], childPubkey: string): number {
  return requests.filter((r) => r.status === 'pending' && r.request.child === childPubkey).length
}

// ============================================================================
// familyChildren
// ============================================================================

/** The children Home (and every other family list) shows — every child that
 *  has not been archived (v0.3's "Remove child" — never a deletion, see
 *  state/state.ts#archiveChild's own doc comment). A revoked-but-not-yet-
 *  archived child is deliberately still listed here: revoking a device and
 *  removing a child are two separate, deliberate actions. Pure. */
export function familyChildren(children: ChildProfile[]): ChildProfile[] {
  return children.filter((c) => c.archived === undefined)
}

// ============================================================================
// Screen
// ============================================================================

function ChildCard({
  child,
  app,
  entryBalances,
  onSelect,
}: {
  child: ChildProfile
  app: AppState
  entryBalances: Map<string, number>
  onSelect: () => void
}): ReactElement {
  const accounts = app.docs.accounts.accounts.filter((a) => a.child === child.pubkey && !a.archived)
  const childEntries = app.entries.filter((e) => e.child === child.pubkey)
  const homeCurrency = homeCurrencyFor(accounts)
  const total = approxTotal(balancesByCurrency(accounts, entryBalances), homeCurrency, childEntries)

  const allowanceCfg = app.docs.allowance.configs.find((c) => c.child === child.pubkey)
  const interestCfg = app.docs.interest.configs.find((c) => c.child === child.pubkey)
  const nowSec = Math.floor(Date.now() / 1000)
  const dates = nextDates(allowanceCfg, interestCfg, nowSec)
  const pending = pendingRequestCount(app.requests, child.pubkey)

  return (
    <Card
      className="child-card"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="child-card-top">
        <span className="child-card-name">{child.name}</span>
        {pending > 0 && <Pill tone="amber">{pending} request{pending === 1 ? '' : 's'}</Pill>}
      </div>
      <div className="child-card-total">
        {total.approx && <span className="child-card-approx">≈</span>}
        <Money currency={total.currency} minor={total.totalMinor} size="lg" />
      </div>
      {(dates.allowance !== null || dates.interest !== null) && (
        <div className="child-card-dates">
          {dates.allowance !== null && <span>Pocket money {shortDate(dates.allowance)}</span>}
          {dates.interest !== null && <span>Interest {shortDate(dates.interest)}</span>}
        </div>
      )}
    </Card>
  )
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM-DD' -> '21 Aug' — a child card is tight on space, so this skips
 *  the year (a due date is always within the next ~40 days, per
 *  `LOOKAHEAD_DAYS`, so the year is never ambiguous in practice). */
function shortDate(day: string): string {
  const [, m, d] = day.split('-')
  return `${Number(d)} ${SHORT_MONTHS[Number(m) - 1]}`
}

/** The topbar's own action slot: the family-wide "Approvals" entry point
 *  (badged with the total still-pending count across every child) alongside
 *  the relay status pill (Task 7's "relay status pill (outbox pending count
 *  from outboxEvents)") — Home is the guardian's landing screen, the one
 *  place this indicator is guaranteed to be seen every session. */
function HomeActions({
  pendingTotal,
  onApprovals,
  onAddChild,
}: {
  pendingTotal: number
  onApprovals: () => void
  /** "Add a child" — the only way to reach the add-child
   *  ceremony once at least one child already exists; App.tsx's own
   *  `children.length === 0` gate only ever shows it before that. Also the
   *  correct way to set up a replacement for a device the guardian removed
   *  (never "Pair a device" in that child's own Settings — see
   *  ChildSettings.tsx/ChildDetail.tsx's own copy on why that would reuse a
   *  revoked index). */
  onAddChild: () => void
}): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Button variant="quiet" onClick={onAddChild}>
        Add a child
      </Button>
      <Button variant="quiet" onClick={onApprovals}>
        Approvals{pendingTotal > 0 && <Pill tone="amber">{pendingTotal}</Pill>}
      </Button>
      <RelayStatusPill />
    </div>
  )
}

export function Home({
  onSelectChild,
  onApprovals,
  onAddChild,
}: {
  onSelectChild: (childPubkey: string) => void
  onApprovals: () => void
  /** See `HomeActions`'s own doc comment on this prop. */
  onAddChild: () => void
}): ReactElement {
  const { state } = useApp()
  const { app } = state
  const pendingTotal = app.requests.filter((r) => r.status === 'pending').length
  const action = <HomeActions pendingTotal={pendingTotal} onApprovals={onApprovals} onAddChild={onAddChild} />
  const listedChildren = familyChildren(app.children)

  if (listedChildren.length === 0) {
    return (
      <Screen title="Kinterest" action={action}>
        <EmptyState title="No children yet">Add your first child to get started.</EmptyState>
      </Screen>
    )
  }

  const entryBalances = balances(app.entries)

  return (
    <Screen title="Kinterest" action={action}>
      {listedChildren.map((child) => (
        <ChildCard
          key={child.pubkey}
          child={child}
          app={app}
          entryBalances={entryBalances}
          onSelect={() => onSelectChild(child.pubkey)}
        />
      ))}
    </Screen>
  )
}
