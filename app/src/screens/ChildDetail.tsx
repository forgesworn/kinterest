// One child's accounts, unified feed, and quick-action entry points. See
// internal plan 2026-08-11-parent-mode, Task 4.
//
// Deliberately thin: every piece of actual logic here is a call into an
// already-tested pure module (domain/ledger.ts's `balances`, feed.ts's
// `buildFeed`) — this screen is the render + a little bit of `useState` for
// which QuickActions sheet (if any) is currently open. See feed.ts and
// QuickActions.tsx for where the real work lives.
//
// Wired into screens/GuardianShell.tsx (Task 7) via `onBack`/`onSettings`.

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { balances } from '../domain/ledger'
import { formatMinor } from '../domain/money'
import { Banner, Button, Card, EmptyState, ListRow, Screen, Sheet } from '../components/ui'
import { Money } from '../components/Money'
import { applyConfigDoc } from '../state/state'
import { sendConfig } from '../sync/publish'
import type { ConfigDocs } from '../state/types'
import { stampConfigDoc, useApp } from '../store/store'
import { auditOutcome, childActivityRows, type ActivityRow } from './childActivity'
import { buildFeed, formatDayLabel } from './feed'
import { QuickActions, type QuickActionKind } from './QuickActions'

const QUICK_ACTION_LABELS: { kind: QuickActionKind; label: string }[] = [
  { kind: 'add', label: 'Add' },
  { kind: 'take', label: 'Take' },
  { kind: 'transfer', label: 'Transfer' },
  { kind: 'exchange', label: 'Exchange' },
  { kind: 'settle', label: 'Settle up' },
]

// Spec §4.1's audit-outcome copy. `deltaMinor === 0` -> "Matched"; a surplus
// and a shortfall both quote the ABSOLUTE difference, so the sign lives in
// the words rather than in a minus the parent has to interpret.
function auditSub(row: Extract<ActivityRow, { kind: 'audit' }>): string {
  const outcome = auditOutcome(row.deltaMinor)
  if (outcome === 'matched') return 'Matched'
  const money = formatMinor(row.currency, Math.abs(row.deltaMinor))
  return outcome === 'over' ? `${money} more than the ledger` : `${money} short`
}

/** Jobs ticked and coin counts, newest first — the guardian's view of what
 *  the child's own device has been reporting (v0.2 spec §4.1). */
function ChildActivity({ rows }: { rows: ActivityRow[] }): ReactElement {
  return (
    <div className="feed-group">
      <h2 className="feed-day">Jobs and coin counts</h2>
      {rows.length === 0 ? (
        // Spec §4.1's "Nothing yet — jobs and coin counts will show up here."
        // split across the kit's EmptyState title/body, exactly as the money
        // feed's own empty state below is.
        <EmptyState title="Nothing yet">Jobs and coin counts will show up here.</EmptyState>
      ) : (
        <Card>
          {rows.map((row) =>
            row.kind === 'tick' ? (
              <ListRow
                key={row.id}
                leading={
                  <span className="feed-icon" aria-hidden="true">
                    ✓
                  </span>
                }
                title={row.choreName}
                sub={`Ticked for ${formatDayLabel(row.day)}`}
              />
            ) : (
              <ListRow
                key={row.id}
                leading={
                  <span className="feed-icon" aria-hidden="true">
                    ±
                  </span>
                }
                title={`Counted ${row.accountName}`}
                sub={auditSub(row)}
                trailing={<Money currency={row.currency} minor={row.countedMinor} size="sm" />}
              />
            ),
          )}
        </Card>
      )}
    </div>
  )
}

export function ChildDetail({
  childPubkey,
  onBack,
  onSettings,
}: {
  childPubkey: string
  onBack: () => void
  onSettings: () => void
}): ReactElement {
  const { state, dispatch, relay, guardianSk } = useApp()
  const { app } = state
  const [sheet, setSheet] = useState<QuickActionKind | null>(null)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const [removing, setRemoving] = useState(false)
  // The stamped accounts doc, captured OUT of the dispatched updater so the
  // wire send happens after commit rather than inside a reducer — the same
  // pattern (and the same reasoning) as ChildSettings.tsx's
  // `pendingConfigSendsRef`. Stamping has to happen inside the updater so
  // `issuedAt` is derived from the docHighWater the reducer actually holds;
  // see store.tsx#stampConfigDoc's own CAUTION.
  const pendingRevokeRef = useRef<ConfigDocs['accounts'] | null>(null)
  // The roster is read through a ref inside the async send loop rather than
  // off the render-time `app`: the sends outlive this render, and what must
  // be reached is the family as it stands when they actually run.
  const stateRef = useRef(state)
  stateRef.current = state

  // Removing a device is a REVOCATION recorded on the accounts doc, never a
  // deletion (v0.2 spec §4.5): the child stays in `app.children`, its ledger
  // stays the family's, and the `revoked` entry stays in the doc forever —
  // that entry IS the record of the revocation. Everything else follows from
  // it: store.tsx derives the guardian's peer set from `activeChildren`, so
  // the removed device's wraps stop passing sync/multi.ts's membership check,
  // and the device itself, on receiving this doc, wipes its own key.
  function removeDevice(): void {
    if (guardianSk === null || removing) return
    setConfirmingRemoval(false)
    setRemoving(true)
    const nowSec = Math.floor(Date.now() / 1000)
    dispatch({
      type: 'updateApp',
      update: (a) => {
        const doc = stampConfigDoc(
          a,
          'accounts',
          { accounts: a.docs.accounts.accounts, revoked: { ...(a.docs.accounts.revoked ?? {}), [childPubkey]: nowSec } },
          nowSec,
        )
        pendingRevokeRef.current = doc
        return applyConfigDoc(a, 'accounts', doc)
      },
    })
  }

  // Drains the stamped doc onto the wire after commit. Sent over the FULL
  // roster, not `configRecipients` — deliberately, and it is the one config
  // send that is: the device being revoked is precisely the one that has to
  // receive this doc, and this is the last thing the guardian will ever send
  // it. Every LATER doc goes to active children only.
  //
  // Depends on `state.app`, so it re-runs on the very commit that
  // `removeDevice`'s dispatch produces, and no-ops on every other render
  // (the ref is null). `onBack()` is called LAST and nothing is set after
  // it: it unmounts this screen, and a `setRemoving` afterwards would be a
  // state update on an unmounted component.
  useEffect(() => {
    const doc = pendingRevokeRef.current
    if (doc === null || guardianSk === null) return
    pendingRevokeRef.current = null
    const sk = guardianSk
    const roster = stateRef.current.app.children
    const nowSec = Math.floor(Date.now() / 1000)
    void (async () => {
      for (const c of roster) {
        // Sequential, not Promise.all-ed — every send shares one outbox; see
        // store.tsx#publishConfigDoc's own send loop.
        await sendConfig('accounts', doc, { selfSk: sk, peerPk: c.pubkey, relay, storage: window.localStorage, nowSec }).catch(() => {})
      }
      onBack()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.app, guardianSk, relay])

  const child = app.children.find((c) => c.pubkey === childPubkey) ?? null
  if (child === null) {
    return (
      <Screen title="Child" onBack={onBack}>
        <Banner tone="bad">That child could not be found.</Banner>
      </Screen>
    )
  }

  const accounts = app.docs.accounts.accounts.filter((a) => a.child === childPubkey && !a.archived)
  const childEntries = app.entries.filter((e) => e.child === childPubkey)
  const entryBalances = balances(childEntries)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const nowSec = Math.floor(Date.now() / 1000)
  const feedGroups = buildFeed(childEntries, accounts, app.acks, tz, nowSec)

  return (
    <Screen title={child.name} onBack={onBack} action={<Button variant="quiet" onClick={onSettings}>Settings</Button>}>
      <Card>
        {accounts.length === 0 ? (
          <EmptyState title="No accounts yet">Add one from settings to start tracking money.</EmptyState>
        ) : (
          accounts.map((a) => (
            <ListRow
              key={a.id}
              title={a.name}
              sub={a.custody}
              trailing={<Money currency={a.currency} minor={entryBalances.get(a.id) ?? 0} />}
            />
          ))
        )}
      </Card>

      <div className="quick-actions-row">
        {QUICK_ACTION_LABELS.map(({ kind, label }) => (
          <Button key={kind} variant="quiet" onClick={() => setSheet(kind)}>
            {label}
          </Button>
        ))}
      </div>

      {feedGroups.length === 0 ? (
        <EmptyState title="No activity yet">Money moved for {child.name} will show up here.</EmptyState>
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
                  sub={
                    <>
                      <span className="feed-ack" aria-hidden="true">{row.acked ? '✓' : '○'}</span> {row.sub}
                    </>
                  }
                  trailing={<Money currency={row.currency} minor={row.amountMinor} size="sm" />}
                />
              ))}
            </Card>
          </div>
        ))
      )}

      <ChildActivity rows={childActivityRows(app, childPubkey)} />

      {app.docs.accounts.revoked?.[childPubkey] === undefined ? (
        <Card>
          <Button variant="quiet" block disabled={guardianSk === null || removing} onClick={() => setConfirmingRemoval(true)}>
            {removing ? 'Removing…' : 'Remove this device'}
          </Button>
        </Card>
      ) : (
        <Card>
          {/* U5 (UI audit): "Pair a device" in Settings can't actually
              re-pair this child — it would reuse the same (now revoked)
              derivation index. A genuine replacement device needs a fresh
              "Add a child" on the family home screen instead. */}
          <p className="muted">This device has been removed. Use "Add a child" on the family home screen to set them up on a new one.</p>
        </Card>
      )}

      {confirmingRemoval && (
        <Sheet title="Remove this device" onClose={() => setConfirmingRemoval(false)}>
          <p>
            {child.name}'s device will stop syncing and will be signed out. Their history stays here. You can set them up
            again with a new pairing.
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <Button variant="danger" block onClick={removeDevice}>
              Remove
            </Button>
            <Button variant="quiet" block onClick={() => setConfirmingRemoval(false)}>
              Cancel
            </Button>
          </div>
        </Sheet>
      )}

      {sheet !== null && guardianSk !== null && (
        <QuickActions
          kind={sheet}
          child={child}
          accounts={accounts}
          entries={childEntries}
          balances={entryBalances}
          guardianSk={guardianSk}
          relay={relay}
          dispatch={dispatch}
          onClose={() => setSheet(null)}
        />
      )}
    </Screen>
  )
}
