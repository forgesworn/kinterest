// A small, always-visible indicator of how many gift-wrapped events are
// still sitting in the durable outbox (wire/outbox.ts) waiting to reach a
// relay — Plan 3 Task 7's "relay status pill (outbox pending count from
// outboxEvents)". See internal plan 2026-08-11-parent-mode.
//
// Deliberately reads `localStorage` directly on a short interval rather
// than threading a count through AppState: the outbox is written to
// independently of any store dispatch (a background send succeeding or
// failing over on the guardian engine/scheduler's own retry doesn't itself
// trigger a store re-render — see store.tsx's own `duePayoutsRef`/
// ChildSettings.tsx's `pendingConfigSendsRef` for the same "sends are a
// side effect outside the reducer" shape), so polling is the simplest way
// to keep this current. ChildSettings.tsx's own `RelayCard` reads the same
// source once per render as plain text; this component instead keeps
// itself fresh on an interval so it stays current even while mounted on a
// screen that has no other reason to re-render.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { outboxEvents } from '../wire/outbox'
import { Pill } from './ui'

const POLL_MS = 3000

function pendingCount(): number {
  return outboxEvents(window.localStorage).length
}

export function RelayStatusPill(): ReactElement {
  const [pending, setPending] = useState(pendingCount)

  useEffect(() => {
    const id = window.setInterval(() => setPending(pendingCount()), POLL_MS)
    return () => window.clearInterval(id)
  }, [])

  if (pending === 0) return <Pill tone="good">Synced</Pill>
  return <Pill tone="amber">{pending} sending…</Pill>
}
