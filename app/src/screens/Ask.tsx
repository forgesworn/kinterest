// The child's own "ask for money" screen: a form (pot, amount, what-for
// note, optional link) that sends a spend.request to the pinned guardian,
// plus the pending/answered list underneath — the SAME `state.requests`
// registry Task 1's GRANT ingress already keeps up to date, so a guardian's
// decision shows up here the moment it arrives, with no separate "grants"
// screen needed. See internal plan 2026-08-11-child-mode,
// Task 4, and ./ask.ts for every pure decision behind this screen (this file
// is the render + the one live wire action, "dispatch first, send after" —
// the same shape QuickActions.tsx's `submitEntry`/Approvals.tsx's
// `submitDecision` already established).

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Banner, Button, Card, EmptyState, ListRow, Pill, Screen } from '../components/ui'
import { Money } from '../components/Money'
import { MoneyInput, parseAmount } from '../components/MoneyInput'
import { useApp } from '../store/store'
import { upsertRequest } from '../state/state'
import type { StoredRequest } from '../state/types'
import { sendRequest } from '../sync/publish'
import { childOwnAccounts } from './ChildHome'
import { askChip, buildSpendRequest, childOwnRequests } from './ask'
import { isKnownCurrency } from './approvals'

function nowSecOnce(): number {
  return Math.floor(Date.now() / 1000)
}

// ============================================================================
// One row of the pending/answered list.
// ============================================================================

function AskRow({ stored, nowSec }: { stored: StoredRequest; nowSec: number }): ReactElement {
  const chip = askChip(stored, nowSec)
  const isSpend = stored.request.op === 'spend.request'
  const spendParams = isSpend ? (stored.request.params as { amountMinor: number; currency: string; note?: string }) : null

  const title = isSpend ? (spendParams?.note && spendParams.note.trim() !== '' ? spendParams.note : 'Money') : 'Pocket money'
  // Once approved, the amount shown is what was actually GRANTED (may be
  // less than asked — see ask.ts#askChip's own doc comment on
  // 'approved-less'); otherwise the amount originally asked for.
  const amountMinor =
    isSpend && spendParams
      ? stored.status === 'approved'
        ? (stored.grantedAmountMinor ?? spendParams.amountMinor)
        : spendParams.amountMinor
      : undefined

  // Belt and braces — this list is this child's own
  // requests, which THIS screen always sends with the account's own
  // currency, but a resynced/foreign request could in principle carry
  // anything (wire/payloads.ts only checks `isNonEmptyString`). Never let
  // an unrecognised code reach `<Money>` (currencyOrThrow) straight out of
  // a render — see Approvals.tsx's own RequestCard for the same fix on the
  // guardian side.
  const currencyKnown = spendParams === null || isKnownCurrency(spendParams.currency)

  return (
    <ListRow
      title={title}
      sub={<Pill tone={chip.tone}>{chip.label}</Pill>}
      trailing={
        isSpend && spendParams ? (
          currencyKnown ? (
            <Money currency={spendParams.currency} minor={amountMinor!} size="sm" />
          ) : (
            <span className="muted">Unknown currency</span>
          )
        ) : undefined
      }
    />
  )
}

// ============================================================================
// Screen
// ============================================================================

export function Ask({ onBack }: { onBack: () => void }): ReactElement {
  const { state, dispatch, relay, childSk } = useApp()
  const { app } = state
  const selfPk = app.self.pubkey

  const accounts = childOwnAccounts(app)
  const [accountId, setAccountId] = useState(() => accounts[0]?.id ?? '')
  const [raw, setRaw] = useState('')
  const [note, setNote] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null
  const minor = account !== null ? parseAmount(raw, account.currency) : null

  function handleAccountChange(id: string): void {
    setAccountId(id)
    setRaw('') // see QuickActions.tsx's own handleAccountChange — a same-decimals currency swap must not silently resubmit stale digits
  }

  async function handleSubmit(): Promise<void> {
    if (account === null || minor === null || selfPk === null || childSk === null || app.guardianPubkey === null) return
    setBusy(true)
    setError(null)
    try {
      const nowSec = nowSecOnce()
      const payload = buildSpendRequest({
        child: selfPk,
        accountId: account.id,
        amountMinor: minor,
        currency: account.currency,
        note,
        link,
        nowSec,
      })
      dispatch({ type: 'updateApp', update: (a) => upsertRequest(a, payload, selfPk, nowSec) })
      await sendRequest(payload, {
        selfSk: childSk,
        peerPk: app.guardianPubkey,
        relay,
        storage: window.localStorage,
        nowSec,
      }).catch(() => {})
      // A failed send leaves it durably queued in the outbox (sync/publish.ts)
      // — not lost. The LOCAL ask has already been recorded either way, same
      // "still applied locally — optimistic" shape as every other submit
      // action in this app.
      setRaw('')
      setNote('')
      setLink('')
    } finally {
      setBusy(false)
    }
  }

  if (selfPk === null) {
    return (
      <Screen title="Ask" onBack={onBack}>
        <EmptyState title="Almost there">Ask whoever set this up to finish pairing this device.</EmptyState>
      </Screen>
    )
  }

  if (accounts.length === 0) {
    return (
      <Screen title="Ask" onBack={onBack}>
        <EmptyState title="No pots yet">Ask whoever set this up to add your first pot before you can ask for money.</EmptyState>
      </Screen>
    )
  }

  const nowSec = nowSecOnce()
  const requests = [...childOwnRequests(app)].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <Screen title="Ask" onBack={onBack}>
      <Card>
        {accounts.length > 1 && (
          <select className="text-input" value={accountId} onChange={(e) => handleAccountChange(e.target.value)} aria-label="Pot">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <MoneyInput currency={account?.currency ?? 'GBP'} rawValue={raw} onRawChange={setRaw} label="How much?" autoFocus />
        <input
          className="text-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What's it for?"
          aria-label="What's it for"
        />
        <input
          className="text-input"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Link (optional)"
          aria-label="Link (optional)"
        />
        {error && <Banner tone="bad">{error}</Banner>}
        <Button variant="primary" block onClick={() => void handleSubmit()} disabled={busy || minor === null}>
          {busy ? 'Asking…' : 'Ask'}
        </Button>
      </Card>

      {requests.length === 0 ? (
        <EmptyState title="Nothing asked yet">When you ask for money, it'll show up here.</EmptyState>
      ) : (
        <Card>
          {requests.map((stored) => (
            <AskRow key={stored.request.reqId} stored={stored} nowSec={nowSec} />
          ))}
        </Card>
      )}
    </Screen>
  )
}
