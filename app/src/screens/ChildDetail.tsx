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
import { applyConfigDoc, archiveChild } from '../state/state'
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
  onPairDevice,
}: {
  childPubkey: string
  onBack: () => void
  onSettings: () => void
  /** "Pair their phone" — the same PairDevice ceremony ChildSettings.tsx's
   *  own "Pair a device" opens, reachable from here too (v0.3) so a
   *  freshly-added, not-yet-paired child doesn't need a detour through
   *  Settings first. */
  onPairDevice: () => void
}): ReactElement {
  const { state, dispatch, relay, guardianSk } = useApp()
  const { app } = state
  const [sheet, setSheet] = useState<QuickActionKind | null>(null)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const [archiving, setArchiving] = useState(false)
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

  // Captured the same way as `pendingRevokeRef` above: set inside the
  // dispatched updater (so `revokeDoc` — when there IS one — is stamped
  // against the reducer's real `docHighWater`, not a stale render-time
  // snapshot), drained by the effect below once the commit has landed.
  // `revokeDoc` is `null` whenever the child had no paired device to revoke
  // — see `removeChild`.
  const pendingArchiveRef = useRef<{ revokeDoc: ConfigDocs['accounts'] | null } | null>(null)

  // "Remove child" (v0.3): archives the child (state/state.ts#archiveChild)
  // — never a deletion, see that function's own doc comment. If a device
  // has ever paired (`pairedAt !== undefined`) and isn't already revoked,
  // that device is ALSO revoked here, via the exact same `stampConfigDoc`/
  // `applyConfigDoc` path `removeDevice` above uses — archiving must not
  // leave a still-live device quietly talking to a child that has
  // disappeared from every list. A child with no device (or one already
  // revoked) is archived with no wire send at all.
  function removeChild(): void {
    if (guardianSk === null || archiving) return
    setConfirmingArchive(false)
    setArchiving(true)
    const nowSec = Math.floor(Date.now() / 1000)
    dispatch({
      type: 'updateApp',
      update: (a) => {
        const target = a.children.find((c) => c.pubkey === childPubkey)
        const alreadyRevoked = a.docs.accounts.revoked?.[childPubkey] !== undefined
        let next = a
        let revokeDoc: ConfigDocs['accounts'] | null = null
        if (target !== undefined && target.pairedAt !== undefined && !alreadyRevoked) {
          revokeDoc = stampConfigDoc(
            next,
            'accounts',
            { accounts: next.docs.accounts.accounts, revoked: { ...(next.docs.accounts.revoked ?? {}), [childPubkey]: nowSec } },
            nowSec,
          )
          next = applyConfigDoc(next, 'accounts', revokeDoc)
        }
        next = archiveChild(next, childPubkey, nowSec)
        pendingArchiveRef.current = { revokeDoc }
        return next
      },
    })
  }

  // Drains `removeChild`'s pending result after commit — sends the revoke
  // doc over the FULL roster exactly like `removeDevice`'s own effect
  // (same reasoning: the device just revoked must receive it too) when one
  // was stamped, then returns to Home either way (an archived child is off
  // Home's own list from this same commit onward, so there is nothing left
  // here worth staying on).
  useEffect(() => {
    const pending = pendingArchiveRef.current
    if (pending === null || guardianSk === null) return
    pendingArchiveRef.current = null
    const { revokeDoc } = pending
    if (revokeDoc === null) {
      onBack()
      return
    }
    const sk = guardianSk
    const roster = stateRef.current.app.children
    const nowSec = Math.floor(Date.now() / 1000)
    void (async () => {
      for (const c of roster) {
        await sendConfig('accounts', revokeDoc, { selfSk: sk, peerPk: c.pubkey, relay, storage: window.localStorage, nowSec }).catch(() => {})
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
  const revokedDeviceAt = app.docs.accounts.revoked?.[childPubkey]
  const hasPairedDevice = child.pairedAt !== undefined

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

      {/* Device actions. `hasPairedDevice` (v0.3) is the one thing
          `revoked?.[childPubkey] === undefined` alone never told this
          screen: without it, "Remove this device" used to show for a child
          that had never paired anything at all — a revoke with nothing
          real to revoke. */}
      {revokedDeviceAt === undefined && hasPairedDevice && (
        <Card>
          <Button variant="quiet" block disabled={guardianSk === null || removing} onClick={() => setConfirmingRemoval(true)}>
            {removing ? 'Removing…' : 'Remove this device'}
          </Button>
        </Card>
      )}
      {revokedDeviceAt === undefined && !hasPairedDevice && (
        <Card>
          <Button variant="primary" block onClick={onPairDevice}>
            Pair their phone
          </Button>
        </Card>
      )}
      {revokedDeviceAt !== undefined && (
        <Card>
          {/* "Pair a device" in Settings can't actually
              re-pair this child — it would reuse the same (now revoked)
              derivation index. A genuine replacement device needs a fresh
              "Add a child" on the family home screen instead. */}
          <p className="muted">This device has been removed. Use "Add a child" on the family home screen to set them up on a new one.</p>
        </Card>
      )}

      {/* "Remove child" (v0.3): always offered for an active child, whether
          or not a device was ever paired or has since been revoked — this
          is the one action that was previously missing entirely. */}
      <Card>
        <Button variant="danger" block disabled={guardianSk === null || archiving} onClick={() => setConfirmingArchive(true)}>
          {archiving ? 'Removing…' : 'Remove child'}
        </Button>
      </Card>

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

      {confirmingArchive && (
        <Sheet title="Remove child" onClose={() => setConfirmingArchive(false)}>
          <p>
            {child.name} will disappear from Home and the rest of your family list. Their money history stays exactly as
            it is — it always has to add up.
            {revokedDeviceAt === undefined && hasPairedDevice ? ' Their device will be removed too.' : ''}
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <Button variant="danger" block onClick={removeChild}>
              Remove {child.name}
            </Button>
            <Button variant="quiet" block onClick={() => setConfirmingArchive(false)}>
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
