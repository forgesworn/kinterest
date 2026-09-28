// The five money-moving bottom sheets: Add money / Take money / Transfer /
// Exchange / Settle up. See internal plan 2026-08-11-parent-mode,
// Task 4 — "exchange records BOTH sides with last-used-rate suggestion from
// prior exchange entries, pure helper suggestRate tested".
//
// `submitEntry` below is the load-bearing wiring fix carried from the SDD
// ledger (.superpowers/sdd/2026-08-11-parent-mode/progress.md, Task 2's
// entry): "addEntryAndSend is NOT yet dispatch-wired — wire it through an
// updater (entry added via addEntry inside the updater; sends after
// dispatch), following the pattern store.tsx/multi.ts established in Task
// 2's fix." store.tsx's OWN `addEntryAndSend` takes a snapshot `app` and
// returns a whole precomputed next `app` — exactly the stale-snapshot shape
// its own module header warns a live screen must never dispatch back
// (`dispatch({ type: 'updateApp', update: () => result.app })`), because
// anything else touching the store between this async call starting and
// finishing (the guardian engine delivering an entry from ANOTHER child,
// the 15-minute scheduler tick) would be silently clobbered the moment this
// call's `result.app` — computed from whatever `app` looked like when the
// call STARTED — overwrites it. `submitEntry` instead dispatches a pure,
// synchronous `addEntry` updater first (composes against the reducer's own
// current state, per storeReducer's doc comment), and only sends the entry
// over the wire — a side effect that doesn't need to read state back —
// afterwards. This is this app's first LIVE caller of the entry-creating
// path; store.tsx's `addEntryAndSend` itself stays as written (and unit
// tested in store.test.ts) for a genuinely single-writer caller, but is not
// what QuickActions/ChildDetail call.

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { Dispatch } from 'react'
import { addEntry } from '../state/state'
import { newId } from '../domain/id'
import { creditEntry, debitEntry, exchangeEntry, transferEntry } from '../domain/ledger'
import { adjustmentEntry, auditResult } from '../domain/audit'
import { currencyOrThrow } from '../domain/money'
import type { Account, Entry } from '../domain/types'
import type { ChildProfile } from '../state/types'
import type { RelayLike } from '../wire/relayClient'
import { sendEntry } from '../sync/publish'
import type { StoreAction } from '../store/store'
import { Banner, Button, Sheet } from '../components/ui'
import { MoneyInput, parseAmount } from '../components/MoneyInput'
import { lastExchangeRate } from './feed'

export type QuickActionKind = 'add' | 'take' | 'transfer' | 'exchange' | 'settle'

const SHEET_TITLES: Record<QuickActionKind, string> = {
  add: 'Add money',
  take: 'Take money',
  transfer: 'Transfer',
  exchange: 'Exchange',
  settle: 'Settle up',
}

// ============================================================================
// suggestRate
// ============================================================================

/** Suggests a rate for a NEW exchange between `fromCurrency` and
 *  `toCurrency`, from this child's own prior exchanges — a thin, tested
 *  wrapper over feed.ts's `lastExchangeRate` (see that module's header:
 *  shared with Home.tsx's `approxTotal` so both screens infer a rate the
 *  same way, rather than risking two independent scans ever disagreeing).
 *  `null` when there's nothing to suggest from yet — the Exchange sheet
 *  leaves the "they get" field for the guardian to fill in by hand rather
 *  than guessing. */
export function suggestRate(entries: Entry[], fromCurrency: string, toCurrency: string): number | null {
  return lastExchangeRate(entries, fromCurrency, toCurrency)
}

// ============================================================================
// submitEntry — see module header
// ============================================================================

interface SubmitOpts {
  dispatch: Dispatch<StoreAction>
  guardianSk: Uint8Array
  relay: RelayLike
}

async function submitEntry(entry: Entry, nowSec: number, opts: SubmitOpts): Promise<void> {
  opts.dispatch({ type: 'updateApp', update: (app) => addEntry(app, entry) })
  await sendEntry(entry, {
    selfSk: opts.guardianSk,
    peerPk: entry.child,
    relay: opts.relay,
    storage: window.localStorage,
    nowSec,
  }).catch(() => {})
  // A failed send leaves the entry durably queued in the outbox (see
  // sync/publish.ts) — it is NOT lost, just not yet delivered. Nothing
  // further to do here: the guardian engine's own outbox-flush-on-every-
  // batch (sync/multi.ts) retries it as soon as the relay is reachable
  // again, with no user-visible retry action needed from this sheet.
}

// ============================================================================
// Small presentation helpers
// ============================================================================

/** Pre-fills a MoneyInput's raw text from a known minor amount (Settle up's
 *  "what it should be" starting point = the account's current balance).
 *  Fiat: fixed-decimal major units. BTC: the sats integer directly (see
 *  MoneyInput's own header on why BTC never has a decimal point). Floors at
 *  0 — a negative balance has no sane positive "amount" to pre-fill. */
function initialRaw(currency: string, minor: number): string {
  const spec = currencyOrThrow(currency)
  const floored = Math.max(minor, 0)
  return spec.code === 'BTC' ? String(floored) : (floored / 10 ** spec.decimals).toFixed(spec.decimals)
}

/** The Exchange sheet's "they get" suggestion, recomputed from the "you
 *  give" field's current text + `suggestRate` — presentation-only
 *  arithmetic (the tested logic is `suggestRate` itself), so this stays
 *  local and unexported. Empty string (not a fallback guess) when either
 *  the "you give" amount doesn't parse yet or there's no prior rate to go
 *  on. */
function suggestedToRaw(fromRaw: string, fromCurrency: string, toCurrency: string, entries: Entry[]): string {
  const fromMinor = parseAmount(fromRaw, fromCurrency)
  if (fromMinor === null) return ''
  const rate = suggestRate(entries, fromCurrency, toCurrency)
  if (rate === null) return ''
  const fromMajor = fromMinor / 10 ** currencyOrThrow(fromCurrency).decimals
  const toMajor = Math.max(0, fromMajor * rate)
  const toSpec = currencyOrThrow(toCurrency)
  return toSpec.code === 'BTC' ? String(Math.round(toMajor * 10 ** toSpec.decimals)) : toMajor.toFixed(toSpec.decimals)
}

function accountLabel(a: Account): string {
  return `${a.name} · ${a.currency}`
}

/** Recomputes a valid counterpart account id after the "from" side changes
 *  to `nextFromId` — shared by Transfer (same-currency counterpart) and
 *  Exchange (different-currency counterpart), which differ only in
 *  `compatible`. Keeps `currentToId` when it's still compatible with the
 *  NEW from-account; otherwise picks the first compatible account, or ''
 *  when none exists. Exported (and pure) so this reselection logic has a
 *  tested home rather than living only inside two near-identical event
 *  handlers — see TransferSheet/ExchangeSheet's `handleFromChange`. */
export function pickCounterpartId(
  accounts: Account[],
  nextFromId: string,
  currentToId: string,
  compatible: (candidate: Account, from: Account) => boolean,
): string {
  const nextFrom = accounts.find((a) => a.id === nextFromId)
  if (nextFrom === undefined) return ''
  const stillValid = accounts.some((a) => a.id === currentToId && a.id !== nextFromId && compatible(a, nextFrom))
  if (stillValid) return currentToId
  return accounts.find((a) => a.id !== nextFromId && compatible(a, nextFrom))?.id ?? ''
}

/** The "from" account a Transfer/Exchange sheet should default to —
 *  whichever of `accounts` (in list order) already has AT LEAST ONE
 *  compatible counterpart, rather than always `accounts[0]` regardless.
 *  Falls back to `accounts[0]` itself only when NO account in the whole
 *  list has a partner at all (there is nothing better to default to then —
 *  the sheet shows its "add a second account" banner instead of a picker in
 *  that case). `accounts[0]` alone could be, say, the
 *  only EUR account among otherwise-GBP accounts, dead-ending the sheet on
 *  first open even though a valid transfer exists between two OTHER
 *  accounts. `accounts` is assumed non-empty — every caller already guards
 *  that (QuickActions' own `accounts.length === 0` banner runs first). */
export function firstAccountWithPartner(accounts: Account[], compatible: (candidate: Account, from: Account) => boolean): string {
  const withPartner = accounts.find((from) => accounts.some((a) => a.id !== from.id && compatible(a, from)))
  return (withPartner ?? accounts[0]!).id
}

// ============================================================================
// Component
// ============================================================================

export interface QuickActionsProps {
  kind: QuickActionKind
  child: ChildProfile
  /** This child's own, already non-archived-filtered accounts — see
   *  ChildDetail.tsx, the only caller. */
  accounts: Account[]
  /** This child's own entries — supplies `suggestRate`'s history. */
  entries: Entry[]
  /** accountId -> current balance minor, already folded from `entries`. */
  balances: Map<string, number>
  guardianSk: Uint8Array
  relay: RelayLike
  dispatch: Dispatch<StoreAction>
  onClose: () => void
}

export function QuickActions({ kind, child, accounts, entries, balances, guardianSk, relay, dispatch, onClose }: QuickActionsProps): ReactElement {
  const opts: SubmitOpts = { dispatch, guardianSk, relay }

  async function submit(entry: Entry, nowSec: number): Promise<void> {
    await submitEntry(entry, nowSec, opts)
    onClose()
  }

  // One `nowSec` per tap of a sheet's action button (Global Constraints: no
  // `Date.now()` in pure logic, obtained once per action) — every Sheet
  // below calls this exactly once inside its own submit handler and threads
  // the SAME value into `buildMeta` (the entry's id/createdAt) and `submit`
  // (the wire send's timestamp), rather than each of those independently
  // reading the clock a moment apart.
  function meta(note: string, nowSec: number) {
    return { id: newId(Math.floor(nowSec * 1000)), child: child.pubkey, createdAt: nowSec, author: 'guardian' as const, note: note.trim() === '' ? undefined : note.trim() }
  }

  if (accounts.length === 0) {
    return (
      <Sheet title={SHEET_TITLES[kind]} onClose={onClose}>
        <Banner tone="info">{child.name} has no accounts yet — add one in settings first.</Banner>
        <Button variant="quiet" block onClick={onClose}>Close</Button>
      </Sheet>
    )
  }

  if (kind === 'add' || kind === 'take') {
    return <AddOrTakeSheet kind={kind} accounts={accounts} onSubmit={submit} buildMeta={meta} onClose={onClose} />
  }
  if (kind === 'transfer') {
    return <TransferSheet accounts={accounts} onSubmit={submit} buildMeta={meta} onClose={onClose} />
  }
  if (kind === 'exchange') {
    return <ExchangeSheet accounts={accounts} entries={entries} onSubmit={submit} buildMeta={meta} onClose={onClose} />
  }
  return <SettleUpSheet accounts={accounts} balances={balances} onSubmit={submit} buildMeta={meta} onClose={onClose} />
}

type BuildMeta = (note: string, nowSec: number) => { id: string; child: string; createdAt: number; author: 'guardian'; note?: string }
type Submit = (entry: Entry, nowSec: number) => Promise<void>

function nowSecOnce(): number {
  return Math.floor(Date.now() / 1000)
}

function AddOrTakeSheet({
  kind,
  accounts,
  onSubmit,
  buildMeta,
  onClose,
}: {
  kind: 'add' | 'take'
  accounts: Account[]
  onSubmit: Submit
  buildMeta: BuildMeta
  onClose: () => void
}): ReactElement {
  const [accountId, setAccountId] = useState(accounts[0]!.id)
  const [raw, setRaw] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]!
  const minor = parseAmount(raw, account.currency)

  // Clears the typed amount on any account switch — a same-decimals
  // currency swap (e.g. GBP -> EUR) would otherwise leave numerically-valid
  // text in place, silently resubmitting the same digits under the NEW
  // account's currency without the guardian ever re-confirming them.
  function handleAccountChange(id: string): void {
    setAccountId(id)
    setRaw('')
  }

  async function handleSubmit(): Promise<void> {
    if (minor === null) return
    setBusy(true)
    try {
      const nowSec = nowSecOnce()
      const m = buildMeta(note, nowSec)
      const entry = kind === 'add' ? creditEntry(m, account, minor) : debitEntry(m, account, minor, 'spend')
      await onSubmit(entry, nowSec)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={SHEET_TITLES[kind]} onClose={onClose}>
      {accounts.length > 1 && (
        <select className="text-input" value={accountId} onChange={(e) => handleAccountChange(e.target.value)} aria-label="Account">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{accountLabel(a)}</option>
          ))}
        </select>
      )}
      <MoneyInput currency={account.currency} rawValue={raw} onRawChange={setRaw} label="Amount" autoFocus />
      <input className="text-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" />
      <Button variant="primary" block onClick={() => void handleSubmit()} disabled={busy || minor === null}>
        {kind === 'add' ? 'Add money' : 'Take money'}
      </Button>
    </Sheet>
  )
}

function TransferSheet({
  accounts,
  onSubmit,
  buildMeta,
  onClose,
}: {
  accounts: Account[]
  onSubmit: Submit
  buildMeta: BuildMeta
  onClose: () => void
}): ReactElement {
  // Same-currency compatibility, shared by the default-from pick below and
  // every re-derivation of `toOptions`/`pickCounterpartId` — kept as one
  // closure so the three can never quietly disagree on what "compatible"
  // means here.
  const compatible = (a: Account, from: Account): boolean => a.currency === from.currency
  // True once ANY two accounts in the whole list could transfer between
  // each other — the sheet has genuinely nothing to offer only when this is
  // false (a lone odd-currency-out account must not dead-end the whole
  // sheet just because it happens to be `accounts[0]` or gets selected).
  const anyPartnerExists = accounts.some((from) => accounts.some((a) => a.id !== from.id && compatible(a, from)))

  const [fromId, setFromId] = useState(() => firstAccountWithPartner(accounts, compatible))
  const fromAccount = accounts.find((a) => a.id === fromId) ?? accounts[0]!
  const toOptions = accounts.filter((a) => a.id !== fromId && compatible(a, fromAccount))
  const [toId, setToId] = useState(toOptions[0]?.id ?? '')
  const toAccount = accounts.find((a) => a.id === toId) ?? null
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)

  // Clears the typed amount whenever the from-account changes: it may not
  // stay valid at all (a different `toId` can follow it, see
  // `pickCounterpartId`), and even when a same-decimals currency stays
  // "numerically valid" (e.g. GBP -> EUR), the digits were typed against
  // the OLD currency and must not silently resubmit under the new one.
  function handleFromChange(id: string): void {
    setFromId(id)
    setToId(pickCounterpartId(accounts, id, toId, compatible))
    setRaw('')
  }

  const minor = toAccount === null ? null : parseAmount(raw, fromAccount.currency)

  async function handleSubmit(): Promise<void> {
    if (toAccount === null || minor === null) return
    setBusy(true)
    try {
      const nowSec = nowSecOnce()
      await onSubmit(transferEntry(buildMeta('', nowSec), fromAccount, toAccount, minor), nowSec)
    } finally {
      setBusy(false)
    }
  }

  // Only the genuinely-hopeless case (no pair anywhere in the list) replaces
  // the whole sheet — a second failure mode was this SAME banner showing
  // (with no way back) the moment the guardian picked a from-account that
  // itself had no partner, even though other accounts did. That case is now
  // handled inline below, with the from-picker still on screen.
  if (!anyPartnerExists) {
    return (
      <Sheet title="Transfer" onClose={onClose}>
        <Banner tone="info">Add a second account in the same currency to transfer between them.</Banner>
        <Button variant="quiet" block onClick={onClose}>Close</Button>
      </Sheet>
    )
  }

  return (
    <Sheet title="Transfer" onClose={onClose}>
      <select className="text-input" value={fromId} onChange={(e) => handleFromChange(e.target.value)} aria-label="From account">
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{accountLabel(a)}</option>
        ))}
      </select>
      {toOptions.length === 0 ? (
        <Banner tone="info">
          {fromAccount.name} has no other {fromAccount.currency} account to transfer to — pick a different "from" account above,
          or add one in settings.
        </Banner>
      ) : (
        <>
          {/* No raw-clearing needed on a "to" change here: `toOptions` is
              filtered to `fromAccount.currency` above, so switching among
              them can never change the currency `raw` is being parsed
              against. */}
          <select className="text-input" value={toId} onChange={(e) => setToId(e.target.value)} aria-label="To account">
            {toOptions.map((a) => (
              <option key={a.id} value={a.id}>{accountLabel(a)}</option>
            ))}
          </select>
          <MoneyInput currency={fromAccount.currency} rawValue={raw} onRawChange={setRaw} label="Amount" autoFocus />
        </>
      )}
      <Button variant="primary" block onClick={() => void handleSubmit()} disabled={busy || toAccount === null || minor === null}>
        Transfer
      </Button>
    </Sheet>
  )
}

function ExchangeSheet({
  accounts,
  entries,
  onSubmit,
  buildMeta,
  onClose,
}: {
  accounts: Account[]
  entries: Entry[]
  onSubmit: Submit
  buildMeta: BuildMeta
  onClose: () => void
}): ReactElement {
  const [fromId, setFromId] = useState(accounts[0]!.id)
  const fromAccount = accounts.find((a) => a.id === fromId) ?? accounts[0]!
  const toOptions = accounts.filter((a) => a.id !== fromId && a.currency !== fromAccount.currency)
  const [toId, setToId] = useState(toOptions[0]?.id ?? '')
  const toAccount = accounts.find((a) => a.id === toId) ?? null
  const [fromRaw, setFromRaw] = useState('')
  const [toRaw, setToRaw] = useState('')
  const [toTouched, setToTouched] = useState(false)
  const [busy, setBusy] = useState(false)

  // Clears BOTH amount fields whenever the from-account changes: the
  // to-account may silently change with it (`pickCounterpartId`), and even
  // when it doesn't, both the typed "they give" figure and any suggested/
  // typed "they get" figure were computed against the OLD from-currency —
  // stale either way, not just numerically-coincidentally wrong.
  function handleFromChange(id: string): void {
    setFromId(id)
    setToId(pickCounterpartId(accounts, id, toId, (a, from) => a.currency !== from.currency))
    setFromRaw('')
    setToRaw('')
    setToTouched(false)
  }

  // Clears the "they get" amount on a to-account change too: `toOptions`
  // only guarantees each option differs in currency from `fromAccount`, NOT
  // from each other, so a switch between two to-options can itself change
  // the currency `toRaw` is being parsed against.
  function handleToChange(id: string): void {
    setToId(id)
    setToRaw('')
    setToTouched(false)
  }

  function handleFromRawChange(value: string): void {
    setFromRaw(value)
    if (!toTouched && toAccount !== null) setToRaw(suggestedToRaw(value, fromAccount.currency, toAccount.currency, entries))
  }

  function handleToRawChange(value: string): void {
    setToTouched(true)
    setToRaw(value)
  }

  const fromMinor = parseAmount(fromRaw, fromAccount.currency)
  const toMinor = toAccount === null ? null : parseAmount(toRaw, toAccount.currency)

  async function handleSubmit(): Promise<void> {
    if (toAccount === null || fromMinor === null || toMinor === null) return
    setBusy(true)
    try {
      const nowSec = nowSecOnce()
      await onSubmit(exchangeEntry(buildMeta('', nowSec), fromAccount, fromMinor, toAccount, toMinor), nowSec)
    } finally {
      setBusy(false)
    }
  }

  if (toOptions.length === 0) {
    return (
      <Sheet title="Exchange" onClose={onClose}>
        <Banner tone="info">{fromAccount.name} has no other-currency account to exchange with yet.</Banner>
        <Button variant="quiet" block onClick={onClose}>Close</Button>
      </Sheet>
    )
  }

  return (
    <Sheet title="Exchange" onClose={onClose}>
      <select className="text-input" value={fromId} onChange={(e) => handleFromChange(e.target.value)} aria-label="From account">
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{accountLabel(a)}</option>
        ))}
      </select>
      <MoneyInput currency={fromAccount.currency} rawValue={fromRaw} onRawChange={handleFromRawChange} label="They give" autoFocus />
      <select className="text-input" value={toId} onChange={(e) => handleToChange(e.target.value)} aria-label="To account">
        {toOptions.map((a) => (
          <option key={a.id} value={a.id}>{accountLabel(a)}</option>
        ))}
      </select>
      {toAccount !== null && <MoneyInput currency={toAccount.currency} rawValue={toRaw} onRawChange={handleToRawChange} label="They get" />}
      <Button variant="primary" block onClick={() => void handleSubmit()} disabled={busy || fromMinor === null || toMinor === null}>
        Exchange
      </Button>
    </Sheet>
  )
}

function SettleUpSheet({
  accounts,
  balances,
  onSubmit,
  buildMeta,
  onClose,
}: {
  accounts: Account[]
  balances: Map<string, number>
  onSubmit: Submit
  buildMeta: BuildMeta
  onClose: () => void
}): ReactElement {
  const [accountId, setAccountId] = useState(accounts[0]!.id)
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]!
  const currentMinor = balances.get(account.id) ?? 0
  const [raw, setRaw] = useState(() => initialRaw(account.currency, currentMinor))
  const [busy, setBusy] = useState(false)
  const [nothingToSettle, setNothingToSettle] = useState(false)

  function handleAccountChange(id: string): void {
    setAccountId(id)
    const next = accounts.find((a) => a.id === id)!
    setRaw(initialRaw(next.currency, balances.get(next.id) ?? 0))
    setNothingToSettle(false)
  }

  // A stale "nothing to settle" banner must not survive the guardian typing
  // a DIFFERENT amount — it only means anything for the exact figure last
  // submitted.
  function handleRawChange(value: string): void {
    setRaw(value)
    setNothingToSettle(false)
  }

  // { allowZero: true }: Settle up is the one flow that asks for the
  // ACTUAL counted amount, not a positive movement — a pot spent all the
  // way down must still be settle-able to £0. Every other
  // MoneyInput/parseAmount call in this app keeps the strict default.
  const minor = parseAmount(raw, account.currency, { allowZero: true })

  async function handleSubmit(): Promise<void> {
    if (minor === null) return
    setBusy(true)
    try {
      const nowSec = nowSecOnce()
      const audit = auditResult({ id: newId(Math.floor(nowSec * 1000)), at: nowSec, author: 'guardian' }, account, minor, currentMinor)
      const entry = adjustmentEntry(audit, account, buildMeta('', nowSec))
      if (entry === null) {
        setNothingToSettle(true)
        return
      }
      await onSubmit(entry, nowSec)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title="Settle up" onClose={onClose}>
      {accounts.length > 1 && (
        <select className="text-input" value={accountId} onChange={(e) => handleAccountChange(e.target.value)} aria-label="Account">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{accountLabel(a)}</option>
          ))}
        </select>
      )}
      <MoneyInput currency={account.currency} rawValue={raw} onRawChange={handleRawChange} label="Actual amount" autoFocus allowZero />
      {nothingToSettle && <Banner tone="info">That's already what the ledger shows — nothing to settle.</Banner>}
      <Button variant="primary" block onClick={() => void handleSubmit()} disabled={busy || minor === null}>
        Settle up
      </Button>
    </Sheet>
  )
}
