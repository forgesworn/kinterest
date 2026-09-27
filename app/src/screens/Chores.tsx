// The child's chores screen: today's dailies + the weekly list and a
// "N of M days to pocket money" gate-progress readout. See
// internal plan 2026-08-11-child-mode, Task 4, and ./chores.ts
// for every pure decision behind this screen; this file is the render + the
// one live wire action layered on top (ticking), same "dispatch first, send
// after" shape QuickActions.tsx's `submitEntry` established. Auto-raising
// the gate's allowance.claim lives in store.tsx's child-side loop, so it
// fires whenever the device holds its key, not only while this screen is
// mounted (U9).
//
// Both dailies and weeklies render the same row/tick affordance — "ticked
// today, or not" — a deliberate simplification over the full "any day in
// the period" semantics `domain/chores.ts#periodComplete` actually uses for
// a WEEKLY chore's own gate check: showing "already done for the whole
// week" the moment ANY day is ticked would need this screen to know which
// period it's ticking towards even for a family with no allowance
// configured at all (chores can exist without a gate). "Ticked today" is
// simple, always available, and — because `choreTickId` is deterministic
// per (chore, day) — never disagrees with what the real gate decision
// (`choreGateReadyClaims`, which DOES use the full period window) actually
// sees.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { dayKey } from '../domain/period'
import { tickedDays } from '../domain/chores'
import type { Chore, ChoreTick } from '../domain/chores'
import { Banner, Button, Card, EmptyState, ListRow, Screen } from '../components/ui'
import { recordTick } from '../state/state'
import { sendTick } from '../sync/publish'
import { useApp } from '../store/store'
import { choreGateProgress, choreTickId, progressFillPercent } from './chores'

function nowSecOnce(): number {
  return Math.floor(Date.now() / 1000)
}

function ChoreRow({
  chore,
  done,
  busy,
  onTick,
}: {
  chore: Chore
  done: boolean
  busy: boolean
  onTick: () => void
}): ReactElement {
  return (
    <ListRow
      title={chore.name}
      trailing={
        <Button variant={done ? 'quiet' : 'primary'} disabled={done || busy} onClick={onTick}>
          {done ? 'Done' : busy ? '…' : 'Tick'}
        </Button>
      }
    />
  )
}

export function Chores({ onBack }: { onBack: () => void }): ReactElement {
  const { state, dispatch, relay, childSk } = useApp()
  const { app } = state
  const selfPk = app.self.pubkey
  const [busyChore, setBusyChore] = useState<string | null>(null)

  async function handleTick(chore: Chore, day: string): Promise<void> {
    if (childSk === null || app.guardianPubkey === null) return
    const id = choreTickId(chore.id, day)
    if (app.ticks.some((t) => t.id === id)) return // already ticked — idempotent no-op, no re-send
    setBusyChore(chore.id)
    try {
      const nowSec = nowSecOnce()
      const tick: ChoreTick = { id, chore: chore.id, day, at: nowSec }
      dispatch({ type: 'updateApp', update: (a) => recordTick(a, tick) })
      await sendTick(tick, { selfSk: childSk, peerPk: app.guardianPubkey, relay, storage: window.localStorage, nowSec }).catch(() => {})
    } finally {
      setBusyChore(null)
    }
  }

  if (selfPk === null) {
    return (
      <Screen title="Chores" onBack={onBack}>
        <EmptyState title="Almost there">Ask whoever set this up to finish pairing this device.</EmptyState>
      </Screen>
    )
  }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const nowSec = nowSecOnce()
  const todayKey = dayKey(nowSec, tz)

  const chores = app.docs.chores.chores.filter((c) => c.child === selfPk && !c.archived)
  const dailies = chores.filter((c) => c.cadence === 'daily')
  const weeklies = chores.filter((c) => c.cadence === 'weekly')

  const cfg = app.docs.allowance.configs.find((c) => c.child === selfPk)
  const progress = cfg !== undefined ? choreGateProgress(cfg, chores, app.ticks, todayKey, nowSec) : null

  if (chores.length === 0) {
    return (
      <Screen title="Chores" onBack={onBack}>
        <EmptyState title="No chores yet">Ask whoever set this up to add some.</EmptyState>
      </Screen>
    )
  }

  return (
    <Screen title="Chores" onBack={onBack}>
      {progress !== null && (
        <Card>
          <p className="card-title">
            {progress.kind === 'days'
              ? `${progress.doneDays} of ${progress.totalDays} days to pocket money`
              : `${progress.doneCount} of ${progress.totalCount} chores this week`}
          </p>
          <div
            className="gate-progress-bar"
            role="progressbar"
            aria-valuenow={progress.kind === 'days' ? progress.doneDays : progress.doneCount}
            aria-valuemin={0}
            aria-valuemax={progress.kind === 'days' ? progress.totalDays : progress.totalCount}
          >
            {/* progressFillPercent is the single source of truth for the fill
                width — it caps below 100% whenever `progress.complete` is
                false, so this bar can never visually read "done" ahead of
                the real gate decision (choreGateReadyClaims, via
                periodComplete) actually agreeing. */}
            <div className="gate-progress-fill" style={{ width: `${progressFillPercent(progress)}%` }} />
          </div>
        </Card>
      )}

      {app.guardianPubkey === null && <Banner tone="info">This device isn't fully set up yet — ticks will send once it is.</Banner>}

      {dailies.length > 0 && (
        <Card>
          <p className="card-title">Today</p>
          {dailies.map((c) => (
            <ChoreRow
              key={c.id}
              chore={c}
              done={tickedDays(c, app.ticks).has(todayKey)}
              busy={busyChore === c.id}
              onTick={() => void handleTick(c, todayKey)}
            />
          ))}
        </Card>
      )}

      {weeklies.length > 0 && (
        <Card>
          <p className="card-title">This week</p>
          {weeklies.map((c) => (
            <ChoreRow
              key={c.id}
              chore={c}
              done={tickedDays(c, app.ticks).has(todayKey)}
              busy={busyChore === c.id}
              onTick={() => void handleTick(c, todayKey)}
            />
          ))}
        </Card>
      )}
    </Screen>
  )
}
