// One child's settings: accounts, pocket money (allowance), interest,
// chores, "Show recovery words", relays + outbox, and the "Pair a device"
// entry point. See internal plan 2026-08-11-parent-mode, Task 6.
//
// Deliberately thin over settingsForms.ts: every section below is a small
// `useState`-only form component that calls one of that module's pure
// builders on submit and, only on a non-null result, hands the resulting
// FULL doc list to `saveDoc` — this screen owns no validation logic of its
// own, matching QuickActions.tsx/Approvals.tsx's own split (React glue vs.
// pure, separately-tested builders).
//
// Wired into screens/GuardianShell.tsx (Task 7) via `onBack`/`onPairDevice`.

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Banner, Button, Card, EmptyState, ListRow, Pill, Screen } from '../components/ui'
import { Money } from '../components/Money'
import { MoneyInput } from '../components/MoneyInput'
import { useApp, stampConfigDoc, writeVaultPublished } from '../store/store'
import { applyConfigDoc, configRecipients } from '../state/state'
import type { AppState, ConfigDocs } from '../state/types'
import type { ConfigDocKind } from '../wire/payloads'
import { sendConfig } from '../sync/publish'
import { outboxEvents } from '../wire/outbox'
import { newId } from '../domain/id'
import { CURRENCIES, currencyOrThrow } from '../domain/money'
import { dayKey } from '../domain/period'
import { balances } from '../domain/ledger'
import { project } from '../domain/interest'
import type { InterestConfig } from '../domain/interest'
import type { AllowanceConfig } from '../domain/allowance'
import type { Account, Entry } from '../domain/types'
import type { Chore } from '../domain/chores'
import { loadFamilyMnemonic } from '../identity/vault'
import { rootCardModel } from './familyRoot'
import { vaultPayloadFor, vaultRosterOf, vaultRosterSignature } from '../identity/signetVault'
import { guardianFromMnemonic } from '../identity/derive'
import { sendVault } from '../sync/publish'
import type { SignetRoot } from '../identity/signetConnect'
import {
  addAccount,
  custodyCurrencyError,
  addChore,
  buildAllowanceConfig,
  buildInterestConfig,
  parsePercentToBps,
  renameAccount,
  renameChore,
  setAccountArchived,
  setAccountAuditCadence,
  setChoreArchived,
  setChoreCadence,
  upsertByChild,
  type AuditCadence,
} from './settingsForms'

// ============================================================================
// Config publishing — see store.tsx's `stampConfigDoc` doc comment for the
// full reasoning; summary here. Two things must both be true for a LIVE
// screen (never true for a genuinely single-writer caller like
// store.test.ts's own direct calls): (1) the local mutation is dispatched
// as a pure `updateApp` updater, never a precomputed whole-state snapshot
// (`storeReducer`'s own doc comment — the carried instruction this task
// closes, per the SDD ledger: "wire it via an updateApp updater like Task 5
// did for grants"); (2) less obviously, `stampConfigDoc`'s own
// monotonic-`issuedAt` computation must ALSO run fresh INSIDE that same
// dispatched updater, not once before dispatch against a captured `app`
// snapshot. Found by review: stamping once outside the updater meant two
// saves to the SAME doc kind landing in the same render frame (a fast
// double-tap on Save, before React re-renders to disable the button) would
// each read the SAME stale `app.docHighWater[docKind]` and stamp the SAME
// `issuedAt` — the second dispatch's `applyConfigDoc` would then see
// `doc.issuedAt <= highWater` (already bumped by the first) and silently
// DROP it, losing the second edit both locally and over the wire. Stamping
// fresh inside each dispatched updater instead is safe because
// `useReducer` processes dispatched actions strictly in order: by the time
// a LATER action's updater runs, `docHighWater` already reflects any
// earlier-dispatched save to the same doc kind.
//
// The stamped doc is still needed AFTER commit, for the (side-effecting,
// order-sensitive) wire sends — captured via `pendingConfigSendsRef`
// (`ChildSettings`'s own field, see its render body below) into a
// PLAIN, IDEMPOTENT assignment keyed by `docKind` (overwrite-safe under
// React 18 StrictMode's dev-only double-invocation of updaters, exactly
// like store.tsx's own `duePayoutsRef` — see that module's comment on why a
// real network call must never live inside the updater itself), then
// drained by a `useEffect` that runs once the commit reflecting this
// update has actually landed.
//
// What in-updater stamping does NOT do: `docBody` — the actual list
// (`{ accounts: next }`, `{ configs: next }`, etc.) each section's own
// `onSave` hands to `saveDoc` — is still built from a RENDER-TIME snapshot
// (`allAccounts`/`app.docs.*` closed over by that section's `mutate`/
// `handleAdd`/`handleSave`), not re-derived fresh inside the dispatched
// updater the way `issuedAt` is. Stamping `issuedAt` fresh inside the
// updater closes the ONE hazard `stampConfigDoc`'s own doc comment
// describes (two saves silently colliding on the same `issuedAt` and one
// getting LWW-dropped) — it says nothing about the doc BODY itself being
// stale. That's fine here only because of a separate guard, `busyDoc`: every
// section's Save/Add/Rename/Archive button is disabled while `busyDoc`
// equals its own `docKind` (see `saveDoc`/the section props below), so a
// second edit to the SAME doc kind can't even be started — let alone build
// a second, independently-snapshotted `docBody` — until the first one's
// commit-and-send has fully landed and cleared `busyDoc` back to `null`.
// ============================================================================

// ============================================================================
// Small shared presentation helpers
// ============================================================================

/** Pre-fills a MoneyInput's raw text from a known minor amount — the same
 *  fixed-decimal-major-units convention QuickActions.tsx's own (unexported)
 *  `initialRaw` uses, kept as its own small copy here rather than exported
 *  from that screen (which owns no shared-module concerns of its own). */
function moneyMajorText(currency: string, minor: number): string {
  const spec = currencyOrThrow(currency)
  return spec.code === 'BTC' ? String(minor) : (minor / 10 ** spec.decimals).toFixed(spec.decimals)
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** Weekly: a named-weekday select (ISO weekday 1..7). Monthly: a bounded
 *  number input (1..31) — domain/period.ts#dueDays clamps a day past a
 *  short month's own length itself, so a literal "31" is always a valid
 *  thing to choose here even though not every month has one. `idPrefix`
 *  keeps the element ids unique when both the allowance and interest
 *  sections render one of these on screen at once. */
function DayPicker({
  idPrefix,
  cadence,
  day,
  onChange,
  disabled,
}: {
  idPrefix: string
  cadence: 'weekly' | 'monthly'
  day: number
  onChange: (day: number) => void
  disabled: boolean
}): ReactElement {
  const id = `${idPrefix}-day`
  if (cadence === 'weekly') {
    return (
      <>
        <label className="field-label" htmlFor={id}>Day</label>
        <select id={id} className="text-input" value={day} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled}>
          {WEEKDAYS.map((label, i) => (
            <option key={label} value={i + 1}>{label}</option>
          ))}
        </select>
      </>
    )
  }
  return (
    <>
      <label className="field-label" htmlFor={id}>Day of month</label>
      <input
        id={id}
        className="text-input"
        type="number"
        inputMode="numeric"
        min={1}
        max={31}
        value={day}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
      />
    </>
  )
}

// ============================================================================
// Accounts
// ============================================================================

function AccountRow({
  account,
  disabled,
  onRename,
  onArchive,
  onAuditCadence,
}: {
  account: Account
  disabled: boolean
  onRename: (name: string) => void
  onArchive: (archived: boolean) => void
  onAuditCadence: (cadence: AuditCadence | undefined) => void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(account.name)
  const archived = account.archived === true

  return (
    <Card>
      {editing ? (
        <>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Account name" autoFocus />
          <div className="settings-row-actions">
            <Button
              variant="primary"
              onClick={() => {
                onRename(name)
                setEditing(false)
              }}
              disabled={disabled || name.trim() === ''}
            >
              Save
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setName(account.name)
                setEditing(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="settings-item-top">
            <span className="row-title">{account.name}</span>
            {archived && <Pill tone="neutral">Archived</Pill>}
          </div>
          <p className="card-sub">{account.currency} · {account.custody}</p>
          <div className="settings-row-actions">
            <Button variant="quiet" onClick={() => setEditing(true)} disabled={disabled}>Rename</Button>
            <Button variant={archived ? 'primary' : 'danger'} onClick={() => onArchive(!archived)} disabled={disabled}>
              {archived ? 'Unarchive' : 'Archive'}
            </Button>
          </div>
        </>
      )}
      <label className="field-label" htmlFor={`audit-${account.id}`}>Audit reminder</label>
      <select
        id={`audit-${account.id}`}
        className="text-input"
        value={account.auditCadence ?? ''}
        onChange={(e) => onAuditCadence(e.target.value === '' ? undefined : (e.target.value as AuditCadence))}
        disabled={disabled}
      >
        <option value="">None</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
    </Card>
  )
}

/** `allAccounts` is the FULL family accounts list (state.docs.accounts.accounts,
 *  every child's, not just this one) — the accounts doc is full-state
 *  replaceable (settingsForms.ts's own header), so every mutation here must
 *  be built against the whole list and published back whole, or every OTHER
 *  child's accounts would silently vanish from the saved doc. Only the
 *  on-screen LIST is filtered down to `childPubkey`. */
function AccountsSection({
  childPubkey,
  allAccounts,
  revoked,
  submitting,
  keyReady,
  onSave,
}: {
  childPubkey: string
  allAccounts: Account[]
  /** The accounts doc's own `revoked` map, as it stands right now
   *  (`app.docs.accounts.revoked`) — carried through on EVERY save this
   *  section makes (U1, UI audit): the doc is full-state replaceable
   *  (`ConfigDocs['accounts']`'s own doc comment), and this section built
   *  its save body as `{ accounts }` alone, so any rename/add/archive here
   *  silently dropped every earlier device revocation the next time it
   *  replicated. Belt and braces alongside the store-side merge (this
   *  screen has no way to know whether that merge has landed yet). */
  revoked: Record<string, number> | undefined
  submitting: boolean
  /** False while the guardian's own signing key is still loading from the
   *  vault (store.tsx's own async `vaultLoad` effect) — see this module's
   *  header on `saveDoc`'s own null-guard: without ALSO disabling the
   *  buttons that call it, a tap during that (usually brief, but real)
   *  window would silently no-op with no feedback at all, the exact defect
   *  Approvals.tsx's own `disabled={guardianSk === null || ...}` was
   *  written to avoid (see that screen's own comment on the same rule). */
  keyReady: boolean
  onSave: (docBody: { accounts: Account[]; revoked: Record<string, number> | undefined }) => void
}): ReactElement {
  const childAccounts = allAccounts.filter((a) => a.child === childPubkey)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [custody, setCustody] = useState<Account['custody']>('ledger')
  const [error, setError] = useState<string | null>(null)
  const disabled = submitting || !keyReady

  function mutate(fn: (list: Account[]) => Account[] | null): void {
    const next = fn(allAccounts)
    if (next !== null) onSave({ accounts: next, revoked })
  }

  // Live, not just on submit — custody and currency are frozen at creation
  // (see the note under the pickers), so telling the parent BEFORE they tap
  // Add is the only kindness available here (v0.2 spec §4.4).
  const custodyError = custodyCurrencyError(custody, currency)

  function handleAdd(): void {
    const nowSec = Math.floor(Date.now() / 1000)
    const next = addAccount(allAccounts, { id: newId(Math.floor(nowSec * 1000)), child: childPubkey, name, currency, custody })
    if (next === null) {
      setError(custodyError ?? 'Enter a name for the account.')
      return
    }
    setError(null)
    setName('')
    onSave({ accounts: next, revoked })
  }

  return (
    <>
      {childAccounts.length === 0 ? (
        <Card>
          <EmptyState title="No accounts yet">Add one below to start tracking money.</EmptyState>
        </Card>
      ) : (
        childAccounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            disabled={disabled}
            onRename={(n) => mutate((list) => renameAccount(list, account.id, n))}
            onArchive={(archived) => mutate((list) => setAccountArchived(list, account.id, archived))}
            onAuditCadence={(cadence) => mutate((list) => setAccountAuditCadence(list, account.id, cadence))}
          />
        ))
      )}
      <Card>
        <label className="field-label" htmlFor="new-account-name">Add an account</label>
        <input id="new-account-name" className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Account name" />
        <label className="field-label" htmlFor="new-account-currency">Currency</label>
        <select id="new-account-currency" className="text-input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {Object.keys(CURRENCIES).map((code) => (
            <option key={code} value={code}>{code}</option>
          ))}
        </select>
        <label className="field-label" htmlFor="new-account-custody">Custody</label>
        <select id="new-account-custody" className="text-input" value={custody} onChange={(e) => setCustody(e.target.value as Account['custody'])}>
          <option value="ledger">Ledger only</option>
          <option value="physical">Physical cash</option>
          <option value="external">External account</option>
        </select>
        <p className="muted">Currency and custody can't be changed after the account is created.</p>
        {custodyError !== null && <Banner tone="bad">{custodyError}</Banner>}
        {error !== null && error !== custodyError && <Banner tone="bad">{error}</Banner>}
        <Button variant="primary" block onClick={handleAdd} disabled={disabled || name.trim() === '' || custodyError !== null}>
          Add account
        </Button>
      </Card>
    </>
  )
}

// ============================================================================
// Allowance (pocket money)
// ============================================================================

function AllowanceSection({
  childPubkey,
  accounts,
  cfg,
  app,
  submitting,
  keyReady,
  onSave,
}: {
  childPubkey: string
  accounts: Account[]
  cfg: AllowanceConfig | undefined
  app: AppState
  submitting: boolean
  /** See `AccountsSection`'s own doc comment on this prop. */
  keyReady: boolean
  onSave: (docBody: { configs: AllowanceConfig[] }) => void
}): ReactElement {
  const disabled = submitting || !keyReady
  const activeAccounts = accounts.filter((a) => a.archived !== true)
  const [accountId, setAccountId] = useState(cfg?.account ?? activeAccounts[0]?.id ?? '')
  // Falls back to the first active account whenever `accountId` doesn't (or
  // no longer) match one — not just when it's the initial '' (U2, UI audit).
  // `accountId` is seeded once at mount; for a child with no accounts yet
  // it starts as '' and NEVER gets a chance to update on its own once the
  // guardian adds their first account further up this same screen (this
  // section stays mounted throughout), so a bare `.find(...)` alone would
  // keep resolving to `undefined` and silently disable the section forever.
  const account = activeAccounts.find((a) => a.id === accountId) ?? activeAccounts[0]
  const [amountRaw, setAmountRaw] = useState(() =>
    cfg !== undefined && account !== undefined ? moneyMajorText(account.currency, cfg.amountMinor) : '',
  )
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>(cfg?.cadence ?? 'weekly')
  const [day, setDay] = useState(cfg?.day ?? 6)
  const [paused, setPaused] = useState(cfg?.paused ?? false)
  const [choresGate, setChoresGate] = useState(cfg?.choresGate ?? false)
  const [auditGate, setAuditGate] = useState(cfg?.auditGate ?? false)
  const [error, setError] = useState<string | null>(null)

  if (activeAccounts.length === 0) {
    return (
      <Card>
        <EmptyState title="No accounts yet">Add an account above before setting up pocket money.</EmptyState>
      </Card>
    )
  }

  function handleCadenceChange(next: 'weekly' | 'monthly'): void {
    setCadence(next)
    setDay(next === 'weekly' ? 6 : 1) // a sane starting point; validDay clamps whatever is actually saved
  }

  // Clears the typed amount on an account switch — the same defensive rule
  // QuickActions.tsx's own AddOrTakeSheet applies (see its
  // `handleAccountChange`, fixed as a Critical finding in Task 4's own
  // review round): two fiat accounts commonly share the SAME decimal count,
  // so numerically-valid text left behind from the OLD account would
  // otherwise silently resubmit under the NEW one without the guardian ever
  // re-confirming the figure.
  function handleAccountChange(id: string): void {
    setAccountId(id)
    setAmountRaw('')
  }

  function handleSave(): void {
    if (account === undefined) return
    const nowSec = Math.floor(Date.now() / 1000)
    // tz/startDay: auto-detected/fixed ONCE at creation (Task 6's brief) —
    // an existing config's own values are kept untouched on every later
    // edit, never re-derived, since both anchor the schedule
    // (domain/allowance.ts's allowanceDue/legitimatePeriodKeys scan forward
    // from startDay; changing it would silently reopen or close
    // already-paid periods).
    const tz = cfg?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const startDay = cfg?.startDay ?? dayKey(nowSec, tz)
    const next = buildAllowanceConfig({
      child: childPubkey,
      account: account.id,
      currency: account.currency,
      amountRaw,
      cadence,
      day,
      tz,
      startDay,
      paused,
      choresGate,
      auditGate,
    })
    if (next === null) {
      setError("Check the amount and day — they don't look right yet.")
      return
    }
    setError(null)
    onSave({ configs: upsertByChild(app.docs.allowance.configs, next) })
  }

  return (
    <Card>
      {activeAccounts.length > 1 && (
        <>
          <label className="field-label" htmlFor="allowance-account">Pays into</label>
          <select id="allowance-account" className="text-input" value={accountId} onChange={(e) => handleAccountChange(e.target.value)}>
            {activeAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </>
      )}
      {account !== undefined && <MoneyInput currency={account.currency} rawValue={amountRaw} onRawChange={setAmountRaw} label="Amount" />}
      <label className="field-label" htmlFor="allowance-cadence">Cadence</label>
      <select
        id="allowance-cadence"
        className="text-input"
        value={cadence}
        onChange={(e) => handleCadenceChange(e.target.value as 'weekly' | 'monthly')}
      >
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      <DayPicker idPrefix="allowance" cadence={cadence} day={day} onChange={setDay} disabled={disabled} />
      <label className="checkbox-row">
        <input type="checkbox" checked={choresGate} onChange={(e) => setChoresGate(e.target.checked)} />
        Hold until chores are done
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={auditGate} onChange={(e) => setAuditGate(e.target.checked)} />
        Hold until audited
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
        Paused
      </label>
      {error !== null && <Banner tone="bad">{error}</Banner>}
      <Button variant="primary" block onClick={handleSave} disabled={disabled}>
        {submitting ? 'Saving…' : cfg === undefined ? 'Set up pocket money' : 'Save'}
      </Button>
    </Card>
  )
}

// ============================================================================
// Interest
// ============================================================================

const PROJECTION_PERIODS = 6

function InterestSection({
  childPubkey,
  accounts,
  entries,
  cfg,
  app,
  submitting,
  keyReady,
  onSave,
}: {
  childPubkey: string
  accounts: Account[]
  entries: Entry[]
  cfg: InterestConfig | undefined
  app: AppState
  submitting: boolean
  /** See `AccountsSection`'s own doc comment on this prop. */
  keyReady: boolean
  onSave: (docBody: { configs: InterestConfig[] }) => void
}): ReactElement {
  const disabled = submitting || !keyReady
  const activeAccounts = accounts.filter((a) => a.archived !== true)
  const [accountId, setAccountId] = useState(cfg?.account ?? activeAccounts[0]?.id ?? '')
  // See AllowanceSection's own doc comment on this same fallback (U2, UI audit).
  const account = activeAccounts.find((a) => a.id === accountId) ?? activeAccounts[0]
  const [rateRaw, setRateRaw] = useState(() => (cfg !== undefined ? (cfg.rateBps / 100).toString() : ''))
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>(cfg?.cadence ?? 'monthly')
  const [day, setDay] = useState(cfg?.day ?? 1)
  const [matchRaw, setMatchRaw] = useState(() => (cfg?.matchBps !== undefined ? (cfg.matchBps / 100).toString() : ''))
  const [matchCapRaw, setMatchCapRaw] = useState(() =>
    cfg?.matchCapMinor !== undefined && account !== undefined ? moneyMajorText(account.currency, cfg.matchCapMinor) : '',
  )
  const [paused, setPaused] = useState(cfg?.paused ?? false)
  const [error, setError] = useState<string | null>(null)

  if (activeAccounts.length === 0) {
    return (
      <Card>
        <EmptyState title="No accounts yet">Add an account above before setting up interest.</EmptyState>
      </Card>
    )
  }

  function handleCadenceChange(next: 'weekly' | 'monthly'): void {
    setCadence(next)
    setDay(next === 'weekly' ? 6 : 1)
  }

  // Clears the match-cap amount on an account switch only — `rateRaw`/
  // `matchRaw` are percentages, currency-independent, so unlike
  // AllowanceSection's single amount field they carry no stale-currency
  // hazard (see that section's own `handleAccountChange` for the rule this
  // mirrors).
  function handleAccountChange(id: string): void {
    setAccountId(id)
    setMatchCapRaw('')
  }

  function handleSave(): void {
    if (account === undefined) return
    const nowSec = Math.floor(Date.now() / 1000)
    const tz = cfg?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const startDay = cfg?.startDay ?? dayKey(nowSec, tz)
    const next = buildInterestConfig({
      child: childPubkey,
      account: account.id,
      currency: account.currency,
      rateRaw,
      cadence,
      day,
      tz,
      startDay,
      matchRaw,
      matchCapRaw,
      paused,
    })
    if (next === null) {
      setError("Check the rate, match and day — they don't look right yet.")
      return
    }
    setError(null)
    onSave({ configs: upsertByChild(app.docs.interest.configs, next) })
  }

  // Projection preview (Task 6: "projection preview using project"): the
  // NEXT PROJECTION_PERIODS periods' balances at the rate currently typed
  // (not necessarily saved yet), assuming no further deposits — purely
  // illustrative, using domain/interest.ts's own already-tested `project`.
  // `parsePercentToBps` now caps at 1000% (MAX_BPS), but this render-time
  // computation must not trust that alone: `project`/`interestMinor` can
  // still overflow on a large enough `currentBalanceMinor` (folded straight
  // from `entries`, which — like `rateRaw` before the cap existed — this
  // component does not otherwise validate), and this runs on EVERY
  // keystroke. Found by review: an unguarded call here threw an uncaught
  // RangeError straight out of a render with no error boundary anywhere to
  // catch it, unmounting the whole app. Never letting this computation
  // reach the render as a throw is the point — `preview: null` degrades to
  // "no preview shown", exactly like the "nothing to project yet" case
  // below already renders.
  const parsedRateBps = parsePercentToBps(rateRaw)
  const currentBalanceMinor = account !== undefined ? balances(entries).get(account.id) ?? 0 : 0
  let preview: number[] | null = null
  if (account !== undefined && parsedRateBps !== null && parsedRateBps > 0) {
    try {
      preview = project(currentBalanceMinor, parsedRateBps, PROJECTION_PERIODS)
    } catch {
      preview = null
    }
  }

  return (
    <Card>
      {activeAccounts.length > 1 && (
        <>
          <label className="field-label" htmlFor="interest-account">Pays into</label>
          <select id="interest-account" className="text-input" value={accountId} onChange={(e) => handleAccountChange(e.target.value)}>
            {activeAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </>
      )}
      <label className="field-label" htmlFor="interest-rate">Interest rate (%)</label>
      <input id="interest-rate" className="text-input" inputMode="decimal" value={rateRaw} onChange={(e) => setRateRaw(e.target.value)} placeholder="3.5" />
      <label className="field-label" htmlFor="interest-cadence">Cadence</label>
      <select
        id="interest-cadence"
        className="text-input"
        value={cadence}
        onChange={(e) => handleCadenceChange(e.target.value as 'weekly' | 'monthly')}
      >
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      <DayPicker idPrefix="interest" cadence={cadence} day={day} onChange={setDay} disabled={disabled} />
      <label className="field-label" htmlFor="interest-match">Guardian match (%, optional)</label>
      <input id="interest-match" className="text-input" inputMode="decimal" value={matchRaw} onChange={(e) => setMatchRaw(e.target.value)} placeholder="None" />
      {account !== undefined && (
        <MoneyInput currency={account.currency} rawValue={matchCapRaw} onRawChange={setMatchCapRaw} label="Match cap (optional)" />
      )}
      <label className="checkbox-row">
        <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
        Paused
      </label>
      {preview !== null && account !== undefined && (
        <div className="projection-list">
          <p className="field-label">Next {PROJECTION_PERIODS} periods, no further deposits</p>
          {preview.map((minor, i) => (
            <div className="projection-row" key={i}>
              <span>{i + 1}</span>
              <Money currency={account.currency} minor={minor} size="sm" />
            </div>
          ))}
        </div>
      )}
      {error !== null && <Banner tone="bad">{error}</Banner>}
      <Button variant="primary" block onClick={handleSave} disabled={disabled}>
        {submitting ? 'Saving…' : cfg === undefined ? 'Set up interest' : 'Save'}
      </Button>
    </Card>
  )
}

// ============================================================================
// Chores
// ============================================================================

function ChoreRow({
  chore,
  disabled,
  onRename,
  onCadence,
  onArchive,
}: {
  chore: Chore
  disabled: boolean
  onRename: (name: string) => void
  onCadence: (cadence: Chore['cadence']) => void
  onArchive: (archived: boolean) => void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(chore.name)
  const archived = chore.archived === true

  return (
    <Card>
      {editing ? (
        <>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Chore name" autoFocus />
          <div className="settings-row-actions">
            <Button
              variant="primary"
              onClick={() => {
                onRename(name)
                setEditing(false)
              }}
              disabled={disabled || name.trim() === ''}
            >
              Save
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setName(chore.name)
                setEditing(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="settings-item-top">
            <span className="row-title">{chore.name}</span>
            {archived && <Pill tone="neutral">Archived</Pill>}
          </div>
          <div className="settings-row-actions">
            <Button variant="quiet" onClick={() => setEditing(true)} disabled={disabled}>Rename</Button>
            <Button variant={archived ? 'primary' : 'danger'} onClick={() => onArchive(!archived)} disabled={disabled}>
              {archived ? 'Unarchive' : 'Archive'}
            </Button>
          </div>
        </>
      )}
      <label className="field-label" htmlFor={`chore-cadence-${chore.id}`}>Cadence</label>
      <select
        id={`chore-cadence-${chore.id}`}
        className="text-input"
        value={chore.cadence}
        onChange={(e) => onCadence(e.target.value as Chore['cadence'])}
        disabled={disabled}
      >
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
      </select>
    </Card>
  )
}

/** `allChores` is the FULL family chores list — same "full-state
 *  replaceable doc" reasoning as `AccountsSection`'s `allAccounts`. */
function ChoresSection({
  childPubkey,
  allChores,
  submitting,
  keyReady,
  onSave,
}: {
  childPubkey: string
  allChores: Chore[]
  submitting: boolean
  /** See `AccountsSection`'s own doc comment on this prop. */
  keyReady: boolean
  onSave: (docBody: { chores: Chore[] }) => void
}): ReactElement {
  const disabled = submitting || !keyReady
  const childChores = allChores.filter((c) => c.child === childPubkey)
  const [name, setName] = useState('')
  const [cadence, setCadence] = useState<Chore['cadence']>('daily')

  function mutate(fn: (list: Chore[]) => Chore[] | null): void {
    const next = fn(allChores)
    if (next !== null) onSave({ chores: next })
  }

  function handleAdd(): void {
    const nowSec = Math.floor(Date.now() / 1000)
    const next = addChore(allChores, { id: newId(Math.floor(nowSec * 1000)), child: childPubkey, name, cadence })
    if (next === null) return
    setName('')
    onSave({ chores: next })
  }

  return (
    <>
      {childChores.length === 0 ? (
        <Card>
          <EmptyState title="No chores yet" />
        </Card>
      ) : (
        childChores.map((chore) => (
          <ChoreRow
            key={chore.id}
            chore={chore}
            disabled={disabled}
            onRename={(n) => mutate((list) => renameChore(list, chore.id, n))}
            onCadence={(c) => mutate((list) => setChoreCadence(list, chore.id, c))}
            onArchive={(archived) => mutate((list) => setChoreArchived(list, chore.id, archived))}
          />
        ))
      )}
      <Card>
        <label className="field-label" htmlFor="new-chore-name">Add a chore</label>
        <input id="new-chore-name" className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Chore name" />
        <select className="text-input" value={cadence} onChange={(e) => setCadence(e.target.value as Chore['cadence'])} aria-label="Chore cadence">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <Button variant="primary" block onClick={handleAdd} disabled={disabled || name.trim() === ''}>
          Add chore
        </Button>
      </Card>
    </>
  )
}

// ============================================================================
// Recovery words — "behind an explicit confirm (vault load, deliberate
// reveal only)". Two taps: "Show recovery words" -> an explicit "Yes, show
// them" confirm -> the vault is loaded and the words rendered. The mnemonic
// lives only in this component's own `useState` for as long as it's shown
// (never AppState, never persisted — see Global Constraints) and is dropped
// the moment "Hide" is tapped or this screen unmounts.
// ============================================================================

function RecoveryWordsCard(): ReactElement {
  const [step, setStep] = useState<'hidden' | 'confirm' | 'revealed'>('hidden')
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reveal(): Promise<void> {
    const m = await loadFamilyMnemonic()
    if (m === null) {
      setError("Couldn't find your recovery words on this device.")
      setStep('hidden')
      return
    }
    setError(null)
    setMnemonic(m)
    setStep('revealed')
  }

  if (step === 'revealed' && mnemonic !== null) {
    const words = mnemonic.split(' ')
    return (
      <Card>
        <Banner tone="info">Keep these private — anyone with these words can recover your whole family's account.</Banner>
        <ol className="mnemonic-grid">
          {words.map((word, i) => (
            <li key={i}>
              <span className="mnemonic-index">{i + 1}</span>
              <span className="mnemonic-word">{word}</span>
            </li>
          ))}
        </ol>
        <Button
          variant="quiet"
          block
          onClick={() => {
            setMnemonic(null)
            setStep('hidden')
          }}
        >
          Hide
        </Button>
      </Card>
    )
  }

  if (step === 'confirm') {
    return (
      <Card>
        <Banner tone="info">
          These 12 words can restore your whole family. Only show them somewhere private.
        </Banner>
        <div className="settings-row-actions">
          <Button variant="primary" onClick={() => void reveal()}>Yes, show them</Button>
          <Button variant="quiet" onClick={() => setStep('hidden')}>Cancel</Button>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      {error !== null && <Banner tone="bad">{error}</Banner>}
      <Button variant="quiet" block onClick={() => setStep('confirm')}>
        Show recovery words
      </Button>
    </Card>
  )
}

// ============================================================================
// Family root — the My Signet identity this family is rooted in (v0.2 spec
// §1.8). Every string comes from `familyRoot.ts#rootCardModel`, which is pure
// and separately tested; what lives here is the four actions and the two
// confirms, because those are the ones that touch a picker, a relay and the
// vault.
// ============================================================================

/** British long form — "2 September 2026". */
function formatBackupDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

function FamilyRootCard(): ReactElement {
  const { state, dispatch, relay, guardianSk } = useApp()
  const app = state.app
  const model = rootCardModel(app.root, formatBackupDate)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  function setRoot(root: SignetRoot | { kind: 'phrase' }): void {
    dispatch({ type: 'updateApp', update: (a) => ({ ...a, root }) })
  }

  /** Steps 4-7 of spec §1.8, against the EXISTING guardian key — the family
   *  is already set up here, so nothing is generated and nothing is revealed. */
  async function connect(): Promise<void> {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const mnemonic = await loadFamilyMnemonic()
      if (mnemonic === null) {
        setError("Couldn't find your recovery words on this device.")
        return
      }
      const { pk } = guardianFromMnemonic(mnemonic)
      const { connectSignetRoot } = await import('../identity/signetConnect')
      const connected = await connectSignetRoot({ guardianPk: pk, relayUrls: app.relays })
      if (connected === null) {
        setError('We could not confirm that sign-in — please try again.')
        return
      }
      if (!connected.full) {
        setRoot(connected.root)
        setNote('Backup to My Signet needs a connected My Signet — reconnect from Settings.')
        return
      }
      const nowSec = Math.floor(Date.now() / 1000)
      const sent = await backUp(connected.root, mnemonic, nowSec)
      setRoot(sent ? { ...connected.root, backedUpAt: nowSec } : connected.root)
      if (!sent) setNote('Your backup is queued and will finish when you are back online.')
    } finally {
      setBusy(false)
    }
  }

  /** Takes the whole ROOT, not just its pubkey: a vault must carry the root's
   *  own kind-21236 attestation, or a recovering guardian cannot tell it from
   *  a stranger's (item C1). */
  async function backUp(root: SignetRoot, mnemonic: string, nowSec: number): Promise<boolean> {
    if (guardianSk === null) return false
    try {
      const { sent } = await sendVault(
        vaultPayloadFor(vaultRosterOf(app), mnemonic, guardianFromMnemonic(mnemonic).pk, root.authEvent, nowSec),
        { selfSk: guardianSk, peerPk: root.pubkey, relay, storage: window.localStorage, nowSec },
      )
      // The store's automatic re-seal reads this, so a manual backup counts.
      if (sent) writeVaultPublished(vaultRosterSignature(vaultRosterOf(app)))
      return sent
    } catch {
      return false
    }
  }

  async function backUpNow(): Promise<void> {
    const root = app.root
    if (root === null || root.kind !== 'signet') return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const mnemonic = await loadFamilyMnemonic()
      if (mnemonic === null) {
        setError("Couldn't find your recovery words on this device.")
        return
      }
      const nowSec = Math.floor(Date.now() / 1000)
      const sent = await backUp(root, mnemonic, nowSec)
      if (sent) setRoot({ ...root, backedUpAt: nowSec })
      else setNote('Your backup is queued and will finish when you are back online.')
    } finally {
      setBusy(false)
    }
  }

  /** The mnemonic is NEVER deleted here — disconnecting drops the root
   *  record, not the family's only way back. */
  async function disconnect(): Promise<void> {
    setBusy(true)
    setConfirmingDisconnect(false)
    try {
      setRoot({ kind: 'phrase' })
      const { signetLogout } = await import('../identity/signetLogin')
      await signetLogout()
    } finally {
      setBusy(false)
    }
  }

  if (confirmingDisconnect) {
    return (
      <Card>
        <Banner tone="info">
          Your family stays exactly as it is. You will need your recovery words to move to a new phone.
        </Banner>
        <div className="settings-row-actions">
          <Button variant="primary" onClick={() => void disconnect()} disabled={busy}>
            Disconnect My Signet
          </Button>
          <Button variant="quiet" onClick={() => setConfirmingDisconnect(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <p className="card-sub">{model.subtitle}</p>
      {model.backupLine !== null && <ListRow title={model.backupLine} />}
      {error !== null && <Banner tone="bad">{error}</Banner>}
      {note !== null && <Banner tone="info">{note}</Banner>}
      {model.showConnectButton && (
        <>
          <Button variant="primary" block onClick={() => void connect()} disabled={busy}>
            Connect My Signet
          </Button>
          <p className="card-sub">Add a family root so a new phone can bring everything back.</p>
        </>
      )}
      {model.showBackupButton && (
        <>
          <Button variant="primary" block onClick={() => void backUpNow()} disabled={busy || guardianSk === null}>
            {model.backupButtonLabel}
          </Button>
          <p className="card-sub">
            Your recovery words get sealed to your My Signet account, so a new phone can bring the family back.
          </p>
        </>
      )}
      {model.showDisconnectButton && (
        <Button variant="quiet" block onClick={() => setConfirmingDisconnect(true)} disabled={busy}>
          Disconnect My Signet
        </Button>
      )}
    </Card>
  )
}

// ============================================================================
// Relays — "read-only display + outbox pending count"
// ============================================================================

function RelayCard({ relays }: { relays: string[] }): ReactElement {
  // Read-only, direct — this list only needs to be roughly current when the
  // guardian opens settings, and `outboxEvents` is a cheap synchronous
  // localStorage read (wire/outbox.ts), the same source Task 7's relay
  // status pill will eventually read.
  const pending = outboxEvents(window.localStorage).length
  return (
    <Card>
      {relays.length === 0 ? (
        <EmptyState title="No relays configured" />
      ) : (
        relays.map((url) => <ListRow key={url} title={url} />)
      )}
      <p className="card-sub">{pending} message{pending === 1 ? '' : 's'} waiting to send</p>
    </Card>
  )
}

// ============================================================================
// Screen
// ============================================================================

export function ChildSettings({
  childPubkey,
  onBack,
  onPairDevice,
}: {
  childPubkey: string
  onBack: () => void
  onPairDevice: () => void
}): ReactElement {
  const { state, dispatch, relay, guardianSk } = useApp()
  const { app } = state
  const [busyDoc, setBusyDoc] = useState<ConfigDocKind | null>(null)
  // False for the (usually brief, but real) window before store.tsx's own
  // vault-load effect resolves `guardianSk` — every section below disables
  // its Save/Add/Rename/Archive buttons on this too, not just `submitting`,
  // so a tap during that window gives visible feedback (button stays
  // disabled) rather than silently no-op'ing on `saveDoc`'s own
  // `guardianSk === null` guard below. Found in review: ChildDetail.tsx
  // instead waits to MOUNT QuickActions at all until `guardianSk !== null`,
  // but this screen's accounts/chores lists are worth showing immediately —
  // Approvals.tsx's per-button `disabled={guardianSk === null || ...}` is
  // the closer precedent here.
  const keyReady = guardianSk !== null

  // Populated synchronously by `saveDoc`'s dispatched `update` closure below
  // whenever a save actually stamps+applies a doc, drained by the effect
  // right after it — see this module's "Config publishing" header for why
  // stamping must happen INSIDE the updater, and store.tsx's own
  // `duePayoutsRef` for the identical pattern this mirrors. Keyed by
  // `docKind` (plain assignment, not an array push) so it stays correct
  // even under React 18 StrictMode's dev-only double-invocation of
  // updaters: calling the updater twice for the same dispatched action just
  // assigns the same doc twice, not two queued sends.
  const pendingConfigSendsRef = useRef<Partial<Record<ConfigDocKind, ConfigDocs[ConfigDocKind]>>>({})

  const child = app.children.find((c) => c.pubkey === childPubkey) ?? null

  function saveDoc<K extends ConfigDocKind>(docKind: K, docBody: Omit<ConfigDocs[K], 'v' | 'issuedAt'>): void {
    if (guardianSk === null) return
    setBusyDoc(docKind)
    const nowSec = Math.floor(Date.now() / 1000)
    dispatch({
      type: 'updateApp',
      update: (a) => {
        const doc = stampConfigDoc(a, docKind, docBody, nowSec)
        pendingConfigSendsRef.current[docKind] = doc
        return applyConfigDoc(a, docKind, doc)
      },
    })
  }

  // Drains whatever `saveDoc`'s updater (above) most recently stamped —
  // runs after EVERY commit (any `state.app` change, not only config-save
  // ones), no-ops immediately unless something is actually pending. This is
  // what actually SENDS the stamped doc(s) over the wire — kept out of the
  // updater itself for the same StrictMode-purity reason store.tsx's own
  // scheduler drain effect documents.
  useEffect(() => {
    const pending = pendingConfigSendsRef.current
    const kinds = (Object.keys(pending) as ConfigDocKind[]).filter((k) => pending[k] !== undefined)
    if (kinds.length === 0 || guardianSk === null) return
    pendingConfigSendsRef.current = {}
    const sk = guardianSk
    const nowSec = Math.floor(Date.now() / 1000)
    void (async () => {
      for (const docKind of kinds) {
        const doc = pending[docKind]!
        // Sequential, not Promise.all-ed — same outbox re-entrancy
        // reasoning as store.tsx#publishConfigDoc's own send loop (see that
        // function's header): every child's send shares the SAME outbox.
        // ACTIVE children only (`configRecipients`): a revoked device must
        // stop receiving family policy, not just stop being listened to.
        for (const peerPk of configRecipients(app)) {
          await sendConfig(docKind, doc, {
            selfSk: sk,
            peerPk,
            relay,
            storage: window.localStorage,
            nowSec,
          }).catch(() => {})
          // A failed send leaves the CONFIG durably queued in the outbox
          // (sync/publish.ts) — not lost. The local edit has already
          // committed either way, matching every other screen's "still
          // applied locally — optimistic" behaviour on a send failure.
        }
        setBusyDoc((current) => (current === docKind ? null : current))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.app, guardianSk, relay])

  if (child === null) {
    return (
      <Screen title="Settings" onBack={onBack}>
        <Banner tone="bad">That child could not be found.</Banner>
      </Screen>
    )
  }

  const childEntries = app.entries.filter((e) => e.child === childPubkey)
  const childAccounts = app.docs.accounts.accounts.filter((a) => a.child === childPubkey)
  const allowanceCfg = app.docs.allowance.configs.find((c) => c.child === childPubkey)
  const interestCfg = app.docs.interest.configs.find((c) => c.child === childPubkey)

  return (
    <Screen title={`${child.name}'s settings`} onBack={onBack}>
      <h2 className="settings-section-heading">Accounts</h2>
      <AccountsSection
        childPubkey={childPubkey}
        allAccounts={app.docs.accounts.accounts}
        revoked={app.docs.accounts.revoked}
        submitting={busyDoc === 'accounts'}
        keyReady={keyReady}
        onSave={(docBody) => saveDoc('accounts', docBody)}
      />

      <h2 className="settings-section-heading">Pocket money</h2>
      <AllowanceSection
        childPubkey={childPubkey}
        accounts={childAccounts}
        cfg={allowanceCfg}
        app={app}
        submitting={busyDoc === 'allowance'}
        keyReady={keyReady}
        onSave={(docBody) => saveDoc('allowance', docBody)}
      />

      <h2 className="settings-section-heading">Interest</h2>
      <InterestSection
        childPubkey={childPubkey}
        accounts={childAccounts}
        entries={childEntries}
        cfg={interestCfg}
        app={app}
        submitting={busyDoc === 'interest'}
        keyReady={keyReady}
        onSave={(docBody) => saveDoc('interest', docBody)}
      />

      <h2 className="settings-section-heading">Chores</h2>
      <ChoresSection
        childPubkey={childPubkey}
        allChores={app.docs.chores.chores}
        submitting={busyDoc === 'chores'}
        keyReady={keyReady}
        onSave={(docBody) => saveDoc('chores', docBody)}
      />

      <h2 className="settings-section-heading">Device</h2>
      {app.docs.accounts.revoked?.[childPubkey] === undefined ? (
        <Card>
          <Button variant="quiet" block onClick={onPairDevice}>
            Pair a device
          </Button>
        </Card>
      ) : (
        // U5 (UI audit): re-pairing here would reuse THIS child's own
        // derivation index, which is already in `docs.accounts.revoked` —
        // the new phone would inherit the same key and be dropped/self-wipe
        // on its very first sync. A genuine replacement device needs a NEW
        // index, via "Add a child" on the family home screen (the same
        // add-child flow onboarding uses — see GuardianShell.tsx's own
        // 'addChild' route).
        <Card>
          <p className="muted">
            This device has been removed and can't be paired again from here. Use "Add a child" on the family home screen
            to set {child.name} up on a new device.
          </p>
        </Card>
      )}

      <h2 className="settings-section-heading">Family root</h2>
      <FamilyRootCard />

      <h2 className="settings-section-heading">Recovery words</h2>
      <RecoveryWordsCard />

      <h2 className="settings-section-heading">Relays</h2>
      <RelayCard relays={app.relays} />
    </Screen>
  )
}
