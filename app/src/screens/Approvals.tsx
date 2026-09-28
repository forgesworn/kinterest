import { dataStorage } from '../platform/dataStorage'
// The guardian's requests queue — spend.request and allowance.claim asks
// from paired children, grouped by child. See
// internal plan 2026-08-11-parent-mode, Task 5, and the charter
// reference this UX is lifted from
// (apps/charter-app/src/screens/Approvals.tsx): Approve / Not now, a
// stepper to grant less than asked, and a small quiet "dismiss".
//
// As of v0.2 (spec §4.3) that dismiss is no longer a guardian-local status
// flip: it goes through the SAME `submitDecision` path as approve and deny,
// sending a GRANT with `decision: 'dismissed'`. It still moves no money and
// writes no ledger entry — but the child's device now learns the ask was
// seen and set aside ("Not now") instead of waiting forever and eventually
// being told, untruthfully, "No reply yet".
//
// `submitDecision` is this screen's version of QuickActions.tsx's
// `submitEntry`: it dispatches store.tsx#buildGrantDecision's pure
// `applyToApp` updater SYNCHRONOUSLY, then sends the wire messages
// afterwards using the values `buildGrantDecision` already computed — never
// `dispatch({ update: () => someAwaitedResult.app })`, which would reopen
// exactly the stale-snapshot hazard store.tsx's own module header warns
// about (a wrap or another decision landing while this decision's sends
// were in flight).

import { useState } from 'react'
import type { Dispatch, ReactElement } from 'react'
import type { RelayLike } from '../wire/relayClient'
import { sendEntry, sendGrant } from '../sync/publish'
import { claimPeriodGrantable, requestAlreadyDecided } from '../state/state'
import type { AppState, StoredRequest } from '../state/types'
import { buildGrantDecision, useApp, type GrantDecisionInput, type StoreAction } from '../store/store'
import { Banner, Button, Card, EmptyState, Screen, Stepper } from '../components/ui'
import { Money } from '../components/Money'
import { formatMinor } from '../domain/money'
import { claimPeriodComplete, clampGrant, isKnownCurrency, pendingByChild, truncateLink } from './approvals'

function nowSecOnce(): number {
  return Math.floor(Date.now() / 1000)
}

function timeAgo(createdAtSec: number, nowSec: number): string {
  const mins = Math.round((nowSec - createdAtSec) / 60)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.round(hrs / 24)
  return days === 1 ? 'Yesterday' : `${days} days ago`
}

// ============================================================================
// Wire submission — see this module's header.
// ============================================================================

interface SubmitOpts {
  dispatch: Dispatch<StoreAction>
  guardianSk: Uint8Array
  relay: RelayLike
}

async function submitDecision(app: AppState, input: GrantDecisionInput, nowSec: number, opts: SubmitOpts): Promise<void> {
  // Explicit pre-check, ahead of (and redundant with) buildGrantDecision's
  // own internal `requestAlreadyDecided` refusal: this is the WIRE-send
  // guard, not the local-state one. buildGrantDecision's `applyToApp`
  // closure already re-checks fresh at dispatch time, so the LOCAL ledger
  // can never end up with two entries for one reqId — but that closure
  // can't stop this function from having already called `sendEntry`/
  // `sendGrant` for a build computed moments earlier. Checking here first,
  // against the freshest `app` this call has, narrows (never fully closes
  // on its own — see `grantEntryId`'s doc comment for the layer that
  // actually closes it) the window where two near-simultaneous taps/
  // retries would each independently build and send a real entry.
  if (requestAlreadyDecided(app, input.request.reqId)) return

  const build = buildGrantDecision(app, input, nowSec)
  // null: nothing to do — an invalid/unanswerable request (bad op, missing
  // account/config, an illegitimate periodKey), or (belt-and-braces) a
  // reqId already decided. Either way, nothing should be sent.
  if (build === null) return
  opts.dispatch({ type: 'updateApp', update: build.applyToApp })
  // `build.entryOutcome?.entryApplied !== false` — NOT a bare `build.entry
  // !== undefined` — is the actual send guard. `entry`'s presence on `build`
  // only reflects the SNAPSHOT `buildGrantDecision` was called against;
  // `entryOutcome` (store.tsx's own doc comment on the field) reports what
  // `applyToApp` — just dispatched above, and which runs synchronously
  // (`storeReducer`'s own header) — actually decided at REAL dispatch time.
  // Found by review: a scheduler payment for the same allowance period
  // landing between this build's snapshot and this dispatch makes
  // `applyToApp` skip adding `entry` locally (its own fresh
  // `periodAlreadyPaid` re-check), but `entry` itself is still sitting right
  // here, fully built, under its own distinct `grant:`-prefixed id — sending
  // it anyway would have the child receive BOTH the `sched:` entry and this
  // `grant:` one, since the child's own dedupe is by id, not by period.
  // `entryOutcome` is `undefined` for `spend.request` builds (and for
  // allowance.claim's own already-paid-at-snapshot-time early return, which
  // never has an `entry` to begin with) — `!== false` treats that as "send",
  // matching `spend.request`'s existing guarantee that two builds for the
  // same reqId always carry the identical entry (safe to send regardless).
  if (build.entry !== undefined && build.entryOutcome?.entryApplied !== false) {
    await sendEntry(build.entry, {
      selfSk: opts.guardianSk,
      peerPk: build.entry.child,
      relay: opts.relay,
      storage: dataStorage(),
      nowSec,
    }).catch(() => {})
  }
  await sendGrant(build.grant, {
    selfSk: opts.guardianSk,
    peerPk: input.request.child,
    relay: opts.relay,
    storage: dataStorage(),
    nowSec,
  }).catch(() => {})
  // A failed send leaves the GRANT/entry durably queued in the outbox (see
  // sync/publish.ts) — not lost, just not yet delivered; the guardian
  // engine's own outbox-flush-on-every-batch (sync/multi.ts) retries it.
  // The LOCAL decision (the dispatch above) has already committed either
  // way — matching QuickActions.tsx's own "still applied locally —
  // optimistic" behaviour on a send failure.
}

// A pure step size for the money stepper: ~10 taps drains it from the full
// asked amount to 0, for either a 2-decimal fiat currency or BTC's 8-decimal
// sats — no currency-specific special-casing needed since it is derived
// from `askedMinor` itself rather than a fixed "one major unit" figure.
function stepFor(askedMinor: number): number {
  return Math.max(1, Math.round(askedMinor / 10))
}

// ============================================================================
// One request card
// ============================================================================

interface RequestCardProps {
  stored: StoredRequest
  app: AppState
  busy: 'approve' | 'deny' | 'dismiss' | null
  disabled: boolean
  onApprove: (amountMinor?: number) => void
  onDeny: () => void
  onDismiss: () => void
}

function RequestCard({ stored, app, busy, disabled, onApprove, onDeny, onDismiss }: RequestCardProps): ReactElement {
  const { request } = stored
  const isSpend = request.op === 'spend.request'
  const isBusy = busy !== null

  const spendParams = isSpend
    ? (request.params as { amountMinor: number; currency: string; account: string; note?: string; link?: string })
    : null
  const claimParams = !isSpend ? (request.params as { periodKey: string }) : null

  const account = spendParams
    ? app.docs.accounts.accounts.find((a) => a.id === spendParams.account && a.child === request.child && !a.archived)
    : undefined
  const cfg = !isSpend ? app.docs.allowance.configs.find((c) => c.child === request.child) : undefined
  const allowanceAccount = cfg !== undefined ? app.docs.accounts.accounts.find((a) => a.id === cfg.account && !a.archived) : undefined

  const askedMinor = spendParams?.amountMinor ?? 0
  // A spend.request's own `currency` is only wire-checked for
  // being a non-empty string (wire/payloads.ts), never that it names a real
  // currency OR that it matches the account it claims to debit from. Both
  // gaps need catching here, not just at render time — see `isKnownCurrency`'s
  // own doc comment (approvals.ts) on why an unrecognised code must never
  // reach `<Money>`/`formatMinor` at all, and this card's own history (a
  // modified client naming e.g. BTC against a GBP account previously showed
  // the ASKED currency but Approve would debit the ACCOUNT's).
  const currencyKnown = spendParams === null || isKnownCurrency(spendParams.currency)
  const currencyMismatch =
    spendParams !== null && account !== undefined && currencyKnown && spendParams.currency !== account.currency
  // A claimed periodKey outside cfg's own achievable set (domain/allowance.ts's
  // legitimatePeriodKeys, or a claim pending since before a re-anchor — see
  // state.ts#claimPeriodGrantable) can never be approved by buildGrantDecision — see
  // its own doc comment — so the UI must not offer an Approve button that
  // silently does nothing when tapped.
  const periodLegitimate =
    isSpend || cfg === undefined || claimParams === null ? true : claimPeriodGrantable(app, stored.request, cfg, nowSecOnce())
  const unanswerable = isSpend
    ? account === undefined || !currencyKnown || currencyMismatch
    : cfg === undefined || allowanceAccount === undefined || !periodLegitimate

  const periodDone = claimPeriodComplete(app, stored)

  const [granted, setGranted] = useState(() => Math.max(0, askedMinor))

  return (
    <Card style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label="Dismiss"
        title="Set this aside — they're told 'Not now', and no money moves"
        disabled={disabled || isBusy}
        onClick={onDismiss}
        className="dismiss-btn"
      >
        ✕
      </button>

      <h2 className="card-title">{isSpend ? 'Spend request' : 'Pocket money ready'}</h2>
      <p className="card-sub">{timeAgo(request.ts, nowSecOnce())}</p>

      {isSpend && spendParams && (
        <>
          <p>
            {/* The amount is always shown in the REQUEST's own
                currency (never silently substituted for the account's), but
                only when that currency is one this app actually recognises —
                otherwise `<Money>` would throw straight out of this render. */}
            {currencyKnown ? <Money currency={spendParams.currency} minor={askedMinor} /> : <span>Unknown currency</span>}
            {account ? ` from ${account.name}` : ''}
          </p>
          {spendParams.note && <p className="muted">“{spendParams.note}”</p>}
          {spendParams.link && (
            // PLAIN TEXT, never a clickable anchor — a child's pasted link is
            // a hostile-URL surface (see truncateLink's own doc comment in
            // approvals.ts). Truncated so an unusually long paste can't blow
            // out the card's layout.
            <p className="muted">{truncateLink(spendParams.link)}</p>
          )}
        </>
      )}
      {!isSpend && claimParams && (
        <p>
          {allowanceAccount !== undefined && cfg !== undefined && <Money currency={allowanceAccount.currency} minor={cfg.amountMinor} />}
          {' · '}
          {claimParams.periodKey}
        </p>
      )}

      {/* A gated claim reaches this inbox precisely because the scheduler
          would not pay it automatically, so "have the jobs been done?" is the
          question the parent is actually being asked. Hidden entirely when
          the answer cannot be resolved (v0.2 spec §4.2). */}
      {periodDone !== null && <p className="muted">{periodDone ? 'All jobs done for this period' : 'Some jobs still to do'}</p>}

      {unanswerable && (
        <Banner tone="bad">
          {isSpend
            ? account === undefined
              ? 'That account no longer exists'
              : !currencyKnown
                ? "This request's currency could not be recognised"
                : "This request's currency doesn't match the account — it can't be approved safely"
            : cfg === undefined || allowanceAccount === undefined
              ? 'No allowance is configured for this child'
              : "That period doesn't match this child's allowance schedule"}{' '}
          — this can only be dismissed or denied.
        </Banner>
      )}

      {isSpend && spendParams && !unanswerable && askedMinor > 0 && (
        <div style={{ marginTop: 12 }}>
          <Stepper
            value={granted}
            min={0}
            max={askedMinor}
            step={stepFor(askedMinor)}
            onChange={setGranted}
            format={(v) => formatMinor(spendParams.currency, v)}
            label="Amount to grant"
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <Button
          variant="primary"
          block
          disabled={disabled || isBusy || unanswerable}
          onClick={() => onApprove(isSpend ? granted : undefined)}
        >
          {busy === 'approve' ? 'Approving…' : isSpend && granted < askedMinor ? 'Approve less' : 'Approve'}
        </Button>
        <Button variant="quiet" block disabled={disabled || isBusy} onClick={onDeny}>
          {busy === 'deny' ? 'Saving…' : 'Not now'}
        </Button>
      </div>
    </Card>
  )
}

// ============================================================================
// Screen
// ============================================================================

export function Approvals({ onBack }: { onBack: () => void }): ReactElement {
  const { state, dispatch, relay, guardianSk } = useApp()
  const { app } = state
  const [busy, setBusy] = useState<{ reqId: string; action: 'approve' | 'deny' | 'dismiss' } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const groups = pendingByChild(app.requests)

  async function decide(stored: StoredRequest, decision: 'allow' | 'deny' | 'dismissed', amountMinor?: number): Promise<void> {
    if (busy !== null || guardianSk === null) return
    const reqId = stored.request.reqId
    setBusy({ reqId, action: decision === 'allow' ? 'approve' : decision === 'deny' ? 'deny' : 'dismiss' })
    setError(null)
    try {
      const askedMinor =
        stored.request.op === 'spend.request' ? (stored.request.params as { amountMinor: number }).amountMinor : undefined
      const clamped = decision === 'allow' && askedMinor !== undefined ? clampGrant(askedMinor, amountMinor ?? askedMinor) : amountMinor
      await submitDecision(app, { request: stored.request, decision, amountMinor: clamped }, nowSecOnce(), {
        dispatch,
        guardianSk,
        relay,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send your decision.")
    } finally {
      setBusy(null)
    }
  }

  if (groups.length === 0) {
    return (
      <Screen title="Approvals" onBack={onBack}>
        <EmptyState title="All caught up">No requests right now.</EmptyState>
      </Screen>
    )
  }

  return (
    <Screen title="Approvals" onBack={onBack}>
      {error && <Banner tone="bad">{error}</Banner>}
      {groups.map((group) => {
        const child = app.children.find((c) => c.pubkey === group.childPubkey)
        return (
          <section key={group.childPubkey} aria-label={`Requests from ${child?.name ?? 'this child'}`}>
            <h2 className="approvals-child-heading">{child?.name ?? 'Unknown child'}</h2>
            {group.requests.map((stored) => (
              <RequestCard
                key={stored.request.reqId}
                stored={stored}
                app={app}
                busy={busy?.reqId === stored.request.reqId ? busy.action : null}
                // `decide()` itself refuses a second decision while ANY
                // request is in flight (`if (busy !== null...) return`,
                // matching the charter reference's own global guard) — but
                // that guard is invisible unless every OTHER card's button
                // is also disabled while it applies. Without this, tapping
                // Approve on a different card mid-flight looked clickable
                // and simply did nothing, with no feedback at all (found by
                // independent review before this task's commit).
                disabled={guardianSk === null || (busy !== null && busy.reqId !== stored.request.reqId)}
                onApprove={(amountMinor) => void decide(stored, 'allow', amountMinor)}
                onDeny={() => void decide(stored, 'deny')}
                onDismiss={() => void decide(stored, 'dismissed')}
              />
            ))}
          </section>
        )
      })}
    </Screen>
  )
}
