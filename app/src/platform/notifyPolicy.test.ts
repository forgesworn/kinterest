// platform/notifyPolicy.ts — the one extra thing store.tsx's onEffect glue
// needs beyond notificationFor itself: the firing rule (spec §3.1 — "the
// store fires a notification only when document.visibilityState ===
// 'hidden'"). Tested here exactly like notifications.test.ts, with plain
// fixtures and no DOM at all — visibilityState is a plain argument, never
// read from `document`.

import { describe, expect, it } from 'vitest'
import { notificationToFire } from './notifyPolicy'
import type { NotificationContext, NotifiableEvent } from './notifications'

function ctx(role: 'guardian' | 'child', overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    role,
    childNameFor: () => 'Alex',
    formatMoney: (amountMinor, currency) => `${currency} ${(amountMinor / 100).toFixed(2)}`,
    currencyForAccount: () => null,
    ...overrides,
  }
}

const tickEvent: NotifiableEvent = {
  type: 'tick',
  authorPk: 'pk1',
  tick: { id: 't1', chore: 'ch1', day: '2026-09-02', at: 100 },
}

describe('notificationToFire', () => {
  it('returns the same content notificationFor would when the document is hidden', () => {
    expect(notificationToFire(tickEvent, ctx('guardian'), 'hidden')).toEqual({
      title: 'Alex ticked off a job',
      body: 'Tap to see.',
      tag: 'tick:t1',
    })
  })

  it('is null when the document is visible, even though notificationFor has copy for it', () => {
    expect(notificationToFire(tickEvent, ctx('guardian'), 'visible')).toBeNull()
  })

  it('is null when visibilityState is undefined (no document at all)', () => {
    expect(notificationToFire(tickEvent, ctx('guardian'), undefined)).toBeNull()
  })

  it('is still null when hidden if notificationFor itself has no copy for this role', () => {
    // A 'tick' effect is guardian-only — a child ctx owns no copy for it.
    expect(notificationToFire(tickEvent, ctx('child'), 'hidden')).toBeNull()
  })

  it('is null for an effect notificationFor never has copy for (ack), regardless of visibility', () => {
    const ack: NotifiableEvent = { type: 'ack', entryId: 'e1', authorPk: 'pk1' }
    expect(notificationToFire(ack, ctx('guardian'), 'hidden')).toBeNull()
  })

  // Fix round 1 — IMPORTANT 1: a resync reply re-emits every ingested effect
  // through the SAME onEffect path a live delivery takes (store.tsx's
  // handleResilienceEffect#reemit), so state/acks fold in correctly — but a
  // replay of an old spend.request/grant/entry must never re-notify, or
  // catching up after being offline fires a burst of stale notifications for
  // things already answered. `{ notify: false }` short-circuits before even
  // the visibility check.
  it('is null when opts.notify is false, even hidden and otherwise notifiable — replayed effects never fire', () => {
    expect(notificationToFire(tickEvent, ctx('guardian'), 'hidden', { notify: false })).toBeNull()
  })

  it('opts.notify defaulting to true (omitted) behaves exactly as before', () => {
    expect(notificationToFire(tickEvent, ctx('guardian'), 'hidden', {})).toEqual({
      title: 'Alex ticked off a job',
      body: 'Tap to see.',
      tag: 'tick:t1',
    })
  })
})
