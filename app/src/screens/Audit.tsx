// The child's audit ceremony: pick a physical pot, count its coins/notes,
// compare the count against what the ledger says that pot should hold, and
// send the result to the guardian. See
// internal plan 2026-08-11-child-mode, Task 5, and ./coinCount.ts
// for every pure decision behind this screen (this file is the render + the
// one live wire action, same "dispatch first, send after" shape
// Chores.tsx/Ask.tsx already established for a child-authored wire event).
//
// v1 DECISION (documented per the plan's own instruction — read this before
// changing anything below): the audit ceremony's only wire effect is
// SENDING the finished AuditResult (a CHILD_SIG event, via
// sync/publish.ts#sendAudit) — it never creates or sends a correcting
// ledger entry itself, whether the count matches or not. A mismatch's
// `deltaMinor` is carried on the AuditResult for the guardian to see; making
// the actual adjustment is deliberately left to the GUARDIAN
// (screens/QuickActions.tsx's own "Settle up" sheet, which already builds
// the very same `adjustmentEntry` off an `auditResult` — just guardian-typed
// rather than fed by this ceremony) rather than auto-applied here, however
// small the delta. This keeps a child device from EVER being the one that
// unilaterally mutates the ledger by more than the transaction types it
// already owns (asks, chore-gated claims) — see the plan's Task 5 entry and
// its self-review note for the full reasoning this was carried from.
//
// A "found it"/"send anyway" mismatch both take the SAME wire action (there
// is only one AuditResult to send — see above) and share the SAME closing
// headline ("Sent to your parent." — honest, since the guardian has no
// audit viewer yet to promise anything more specific); they differ only in
// the sub-copy underneath it, since "found it" means the child themselves
// worked out what the difference was (so the closing screen tells them to
// mention it), while "send anyway" means they couldn't (so the closing
// screen simply confirms there's nothing more for them to do) — both leave
// the guardian with the exact same record either way.
//
// Three steps, a plain local toggle exactly like Chores.tsx/App.tsx's own
// route state (no external step-machine module — unlike ChildOnboarding's
// async, multi-effect flow, every step here is synchronous local UI state
// until the one final send):
//   'pick'   — choose which physical pot to count (skipped stays visible even
//              with only one pot — consistent, no special-cased single-item
//              flow).
//   'count'  — the denomination steppers + running total.
//   'result' — match: a celebration + a single "All done" send. mismatch: the
//              detective list (this pot's entries since its last audit, in
//              child language) + the two closing choices described above.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { auditResult, type AuditResult } from '../domain/audit'
import { balances } from '../domain/ledger'
import type { Account } from '../domain/types'
import { Banner, Button, Card, EmptyState, ListRow, Screen, Stepper } from '../components/ui'
import { Money } from '../components/Money'
import { useApp } from '../store/store'
import { recordAudit } from '../state/state'
import { sendAudit } from '../sync/publish'
import { newId } from '../domain/id'
import { childOwnAccounts, childOwnEntries } from './ChildHome'
import { buildChildFeed } from './childFeed'
import {
  auditOutcome,
  coinCountTotal,
  denominationRows,
  emptyCoinCounts,
  entriesSinceLastAudit,
  setCoinCount,
  type AuditOutcome,
  type CoinCounts,
} from './coinCount'

function nowSecOnce(): number {
  return Math.floor(Date.now() / 1000)
}

type Step = 'pick' | 'count' | 'result'

// The closing copy's own resolution tag. `null` while nothing has been sent
// yet, driving the "sending…"/"sent" sub-states below without a second
// boolean to keep in sync with it. 'matched' is the match path's own single
// send action (there is no detective choice on that path — see this
// module's header); 'found'/'sent-anyway' are the mismatch path's two
// closing choices.
type Resolution = 'matched' | 'found' | 'sent-anyway' | null

export function Audit({ onBack }: { onBack: () => void }): ReactElement {
  const { state, dispatch, relay, childSk } = useApp()
  const { app } = state
  const selfPk = app.self.pubkey

  const [step, setStep] = useState<Step>('pick')
  const [accountId, setAccountId] = useState<string | null>(null)
  const [counts, setCounts] = useState<CoinCounts>({})
  const [result, setResult] = useState<{ countedMinor: number; expectedMinor: number; outcome: AuditOutcome } | null>(null)
  const [resolution, setResolution] = useState<Resolution>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  if (selfPk === null) {
    return (
      <Screen title="Audit" onBack={onBack}>
        <EmptyState title="Almost there">Ask whoever set this up to finish pairing this device.</EmptyState>
      </Screen>
    )
  }

  const physicalAccounts = childOwnAccounts(app).filter((a) => a.custody === 'physical')

  function chooseAccount(account: Account): void {
    setAccountId(account.id)
    setCounts(emptyCoinCounts(account.currency))
    setResult(null)
    setResolution(null)
    setDone(false)
    setStep('count')
  }

  const account = accountId !== null ? (physicalAccounts.find((a) => a.id === accountId) ?? null) : null

  function handleCompare(): void {
    if (account === null) return
    const entryBalances = balances(childOwnEntries(app))
    const expectedMinor = entryBalances.get(account.id) ?? 0
    const countedMinor = coinCountTotal(counts)
    setResult({ countedMinor, expectedMinor, outcome: auditOutcome(countedMinor, expectedMinor) })
    setStep('result')
  }

  async function handleSend(resolutionChoice: Exclude<Resolution, null>): Promise<void> {
    if (account === null || result === null || childSk === null || app.guardianPubkey === null) return
    setBusy(true)
    try {
      const nowSec = nowSecOnce()
      const audit: AuditResult = auditResult(
        { id: newId(Math.floor(nowSec * 1000)), at: nowSec, author: 'child' },
        account,
        result.countedMinor,
        result.expectedMinor,
      )
      dispatch({ type: 'updateApp', update: (a) => recordAudit(a, audit) })
      await sendAudit(audit, { selfSk: childSk, peerPk: app.guardianPubkey, relay, storage: window.localStorage, nowSec }).catch(() => {})
      // A failed send leaves it durably queued in the outbox (sync/publish.ts)
      // — not lost. The local record has already been made either way, same
      // "still applied locally — optimistic" shape as every other submit
      // action in this app.
      setResolution(resolutionChoice)
      setDone(true)
    } finally {
      setBusy(false)
    }
  }

  // ==========================================================================
  // 'pick'
  // ==========================================================================

  if (step === 'pick') {
    if (physicalAccounts.length === 0) {
      return (
        <Screen title="Count your jar" onBack={onBack}>
          <EmptyState title="No jars to count yet">Ask whoever set this up to add a pot you keep as real coins and notes.</EmptyState>
        </Screen>
      )
    }
    return (
      <Screen title="Count your jar" onBack={onBack}>
        <Card>
          <p className="card-title">Which pot?</p>
          {physicalAccounts.map((a) => (
            <ListRow key={a.id} title={a.name} onClick={() => chooseAccount(a)} />
          ))}
        </Card>
      </Screen>
    )
  }

  // account is non-null for every step from here on in the ordinary flow
  // (set by chooseAccount alongside `step`) — this only triggers if the
  // chosen account vanished from under the ceremony (archived/removed by a
  // CONFIG landing mid-count). A plain recovery screen rather than calling
  // `setStep` during render (an anti-pattern React explicitly warns
  // against outside a very narrow "derived state" escape hatch this isn't).
  if (account === null) {
    return (
      <Screen title="Count your jar" onBack={() => setStep('pick')}>
        <EmptyState title="That pot isn't available anymore">Pick another one to count.</EmptyState>
      </Screen>
    )
  }

  // ==========================================================================
  // 'count'
  // ==========================================================================

  if (step === 'count') {
    const rows = denominationRows(account.currency)
    const total = coinCountTotal(counts)

    if (rows.length === 0) {
      return (
        <Screen title={account.name} onBack={() => setStep('pick')}>
          <EmptyState title="Can't count this one as coins">
            {account.currency} doesn't have coins or notes set up to count — ask whoever set this up for help.
          </EmptyState>
        </Screen>
      )
    }

    return (
      <Screen title={account.name} onBack={() => setStep('pick')}>
        <Card className="audit-total">
          <p className="card-sub">Your count so far</p>
          <Money currency={account.currency} minor={total} size="lg" />
        </Card>
        <Card>
          {rows.map((d) => (
            <ListRow
              key={d.minor}
              title={d.label}
              trailing={
                <Stepper
                  value={counts[d.minor] ?? 0}
                  max={999}
                  onChange={(next) => setCounts((c) => setCoinCount(c, d.minor, next))}
                  label={`${d.label} count`}
                />
              }
            />
          ))}
        </Card>
        <Button variant="primary" block onClick={handleCompare}>
          Compare with your jar
        </Button>
      </Screen>
    )
  }

  // ==========================================================================
  // 'result'
  // ==========================================================================

  // Same defensive shape as the `account === null` guard above — `result`
  // is always set immediately before `step` moves to 'result'
  // (`handleCompare`), so this is unreachable in the ordinary flow.
  if (result === null) {
    return (
      <Screen title={account.name} onBack={() => setStep('count')}>
        <EmptyState title="Let's compare again">Something went missing — count once more.</EmptyState>
      </Screen>
    )
  }

  // Sent — either match or mismatch, either resolution. One shared closing
  // screen; only the headline copy differs. The mismatch path's headline is
  // the SAME "Sent to your parent." for both resolutions — deliberately
  // honest rather than the earlier "your parent will help sort it out",
  // which promised a guardian-side audit viewer that doesn't exist yet.
  if (done) {
    const headline = result.outcome === 'match' ? 'Your count matches your jar!' : 'Sent to your parent.'
    const sub =
      result.outcome === 'match'
        ? 'Nothing to fix — well counted.'
        : resolution === 'found'
          ? "Let your parent know what you found, so they can add it."
          : "You don't need to do anything else."
    return (
      <Screen title={account.name} onBack={onBack}>
        <EmptyState title={headline}>{sub}</EmptyState>
        <Button variant="primary" block onClick={onBack}>
          Back to your jar
        </Button>
      </Screen>
    )
  }

  if (result.outcome === 'match') {
    return (
      <Screen title={account.name} onBack={() => setStep('count')}>
        <Banner tone="good">Snap! Your count matches your jar.</Banner>
        <Card className="audit-total">
          <p className="card-sub">You counted</p>
          <Money currency={account.currency} minor={result.countedMinor} size="lg" />
        </Card>
        <Button variant="primary" block onClick={() => void handleSend('matched')} disabled={busy}>
          {busy ? 'Sending…' : 'All done!'}
        </Button>
      </Screen>
    )
  }

  // mismatch — the detective screen.
  const feedGroups = buildChildFeed(
    entriesSinceLastAudit(childOwnEntries(app), app.audits, account.id),
    childOwnAccounts(app),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    nowSecOnce(),
  )

  return (
    <Screen title={account.name} onBack={() => setStep('count')}>
      <Banner tone="bad">Your count doesn't quite match your jar yet.</Banner>
      <Card>
        <p className="card-sub">You counted</p>
        <Money currency={account.currency} minor={result.countedMinor} size="md" />
      </Card>
      <Card>
        <p className="card-sub">Your jar says</p>
        <Money currency={account.currency} minor={result.expectedMinor} size="md" />
      </Card>

      <p className="card-title">Here's what's happened to this pot</p>
      {feedGroups.length === 0 ? (
        <EmptyState title="Nothing recorded yet">There's no history for this pot to check against.</EmptyState>
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

      <Button variant="primary" block onClick={() => void handleSend('found')} disabled={busy}>
        {busy ? 'Sending…' : "I found it — I'll tell them"}
      </Button>
      <Button variant="quiet" block onClick={() => void handleSend('sent-anyway')} disabled={busy}>
        {busy ? 'Sending…' : 'Not sure — send it anyway'}
      </Button>
    </Screen>
  )
}
