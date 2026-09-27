// One `it` per row of v0.2 spec §3.1's table (in table order), plus the
// extra null/fallback/name-free cases the phase brief calls out.

import { describe, expect, it } from 'vitest'
import { notificationFor, type NotificationContext, type NotifiableEvent } from './notifications'
import type { Entry } from '../domain/types'
import type { AuditResult } from '../domain/audit'
import type { ChoreTick } from '../domain/chores'

const NAMES: Record<string, string> = { pk1: 'Alex' }
const ACCOUNT_CURRENCIES: Record<string, string> = { acc1: 'GBP' }

function ctx(role: 'guardian' | 'child', overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    role,
    childNameFor: (pubkey) => NAMES[pubkey] ?? null,
    formatMoney: (amountMinor, currency) => `${currency} ${(amountMinor / 100).toFixed(2)}`,
    currencyForAccount: (accountId) => ACCOUNT_CURRENCIES[accountId] ?? null,
    ...overrides,
  }
}

const guardian = ctx('guardian')
const child = ctx('child')

describe('notificationFor — §3.1 table', () => {
  it('guardian / request spend.request', () => {
    const e: NotifiableEvent = {
      type: 'request',
      authorPk: 'pk1',
      payload: {
        v: 1,
        op: 'spend.request',
        reqId: 'r1',
        nonce: 'n1',
        child: 'c1',
        ts: 100,
        params: { amountMinor: 500, currency: 'GBP', account: 'acc1' },
      },
    }
    expect(notificationFor(e, guardian)).toEqual({
      title: 'New ask from Alex',
      body: 'GBP 5.00 — tap to decide',
      tag: 'ask:r1',
    })
  })

  it('guardian / request allowance.claim', () => {
    const e: NotifiableEvent = {
      type: 'request',
      authorPk: 'pk1',
      payload: {
        v: 1,
        op: 'allowance.claim',
        reqId: 'r2',
        nonce: 'n2',
        child: 'c1',
        ts: 100,
        params: { periodKey: '2026-09' },
      },
    }
    expect(notificationFor(e, guardian)).toEqual({
      title: 'Pocket money claim from Alex',
      body: 'Tap to review',
      tag: 'ask:r2',
    })
  })

  it('guardian / pairAnswered', () => {
    const e: NotifiableEvent = { type: 'pairAnswered', childName: 'Sam' }
    expect(notificationFor(e, guardian)).toEqual({
      title: "Sam's device is paired",
      body: 'You can set up their pocket money now.',
      tag: 'pair',
    })
  })

  it('guardian / audit, deltaMinor !== 0', () => {
    const audit: AuditResult = {
      id: 'a1',
      account: 'acc1',
      child: 'pk1',
      countedMinor: 450,
      expectedMinor: 500,
      deltaMinor: -50,
      at: 100,
      author: 'child',
    }
    const e: NotifiableEvent = { type: 'audit', audit, authorPk: 'pk1' }
    expect(notificationFor(e, guardian)).toEqual({
      title: "Alex's coin count doesn't match",
      body: 'Counted GBP 4.50, the ledger says GBP 5.00.',
      tag: 'audit:a1',
    })
  })

  it('guardian / audit, deltaMinor === 0 -> null', () => {
    const audit: AuditResult = {
      id: 'a2',
      account: 'acc1',
      child: 'pk1',
      countedMinor: 500,
      expectedMinor: 500,
      deltaMinor: 0,
      at: 100,
      author: 'child',
    }
    const e: NotifiableEvent = { type: 'audit', audit, authorPk: 'pk1' }
    expect(notificationFor(e, guardian)).toBeNull()
  })

  it('guardian / audit resolves the EUR account currency via currencyForAccount (fix round 1)', () => {
    const eurCtx = ctx('guardian', { currencyForAccount: () => 'EUR' })
    const audit: AuditResult = {
      id: 'a3',
      account: 'eur-acc',
      child: 'pk1',
      countedMinor: 450,
      expectedMinor: 500,
      deltaMinor: -50,
      at: 100,
      author: 'child',
    }
    const e: NotifiableEvent = { type: 'audit', audit, authorPk: 'pk1' }
    expect(notificationFor(e, eurCtx)).toEqual({
      title: "Alex's coin count doesn't match",
      body: 'Counted EUR 4.50, the ledger says EUR 5.00.',
      tag: 'audit:a3',
    })
  })

  it('guardian / audit falls back to GBP when currencyForAccount cannot resolve the account (fix round 1)', () => {
    const unknownAccountCtx = ctx('guardian', { currencyForAccount: () => null })
    const audit: AuditResult = {
      id: 'a4',
      account: 'deleted-acc',
      child: 'pk1',
      countedMinor: 450,
      expectedMinor: 500,
      deltaMinor: -50,
      at: 100,
      author: 'child',
    }
    const e: NotifiableEvent = { type: 'audit', audit, authorPk: 'pk1' }
    expect(notificationFor(e, unknownAccountCtx)).toEqual({
      title: "Alex's coin count doesn't match",
      body: 'Counted GBP 4.50, the ledger says GBP 5.00.',
      tag: 'audit:a4',
    })
  })

  it('guardian / tick', () => {
    const tick: ChoreTick = { id: 't1', chore: 'chore1', day: '2026-09-01', at: 100 }
    const e: NotifiableEvent = { type: 'tick', tick, authorPk: 'pk1' }
    expect(notificationFor(e, guardian)).toEqual({
      title: 'Alex ticked off a job',
      body: 'Tap to see.',
      tag: 'tick:t1',
    })
  })

  it('child / grant allow, full amount', () => {
    const e: NotifiableEvent = {
      type: 'grant',
      payload: {
        v: 1,
        reqId: 'r3',
        nonce: 'n3',
        decision: 'allow',
        ts: 100,
        params: { amountMinor: 500, asked: 500 },
      },
    }
    expect(notificationFor(e, child)).toEqual({
      title: 'Your ask was approved',
      body: 'Tap to see.',
      tag: 'grant:r3',
    })
  })

  it('child / grant allow, params.amountMinor < asked', () => {
    const e: NotifiableEvent = {
      type: 'grant',
      payload: {
        v: 1,
        reqId: 'r3',
        nonce: 'n3',
        decision: 'allow',
        ts: 100,
        params: { amountMinor: 300, asked: 500 },
      },
    }
    expect(notificationFor(e, child)).toEqual({
      title: 'Approved — a bit less than you asked for',
      body: "That's OK! Tap to see.",
      tag: 'grant:r3',
    })
  })

  it('child / grant deny', () => {
    const e: NotifiableEvent = {
      type: 'grant',
      payload: { v: 1, reqId: 'r3', nonce: 'n3', decision: 'deny', ts: 100, params: {} },
    }
    expect(notificationFor(e, child)).toEqual({
      title: 'Not this time',
      body: 'Tap to see what your parent said.',
      tag: 'grant:r3',
    })
  })

  it('child / grant dismissed', () => {
    const e: NotifiableEvent = {
      type: 'grant',
      payload: { v: 1, reqId: 'r3', nonce: 'n3', decision: 'dismissed', ts: 100, params: {} },
    }
    expect(notificationFor(e, child)).toEqual({
      title: 'Not now',
      body: 'Your parent will come back to this.',
      tag: 'grant:r3',
    })
  })

  it('child / entry, category allowance', () => {
    const entry: Entry = {
      v: 1,
      id: 'e1',
      child: 'c1',
      kind: 'credit',
      createdAt: 100,
      author: 'guardian',
      legs: [{ account: 'acc1', currency: 'GBP', amountMinor: 500 }],
      category: 'allowance',
    }
    const e: NotifiableEvent = { type: 'entry', entry, authorPk: 'pk1' }
    expect(notificationFor(e, child)).toEqual({
      title: 'Pocket money landed',
      body: 'GBP 5.00 is in your jar.',
      tag: 'entry:e1',
    })
  })

  it('child / entry, category interest', () => {
    const entry: Entry = {
      v: 1,
      id: 'e2',
      child: 'c1',
      kind: 'interest',
      createdAt: 100,
      author: 'guardian',
      legs: [{ account: 'acc1', currency: 'GBP', amountMinor: 120 }],
      category: 'interest',
    }
    const e: NotifiableEvent = { type: 'entry', entry, authorPk: 'pk1' }
    expect(notificationFor(e, child)).toEqual({
      title: 'Interest landed',
      body: 'GBP 1.20 is in your jar.',
      tag: 'entry:e2',
    })
  })

  it('child / config, docKind chores', () => {
    const e: NotifiableEvent = { type: 'config', docKind: 'chores' }
    expect(notificationFor(e, child)).toEqual({
      title: 'New job on your list',
      body: 'Tap to see.',
      tag: 'chores',
    })
  })

  it('either / anything else -> null (e.g. config docKind accounts, either role)', () => {
    const e: NotifiableEvent = { type: 'config', docKind: 'accounts' }
    expect(notificationFor(e, child)).toBeNull()
    expect(notificationFor(e, guardian)).toBeNull()
  })
})

describe('notificationFor — extra null/fallback cases', () => {
  it('null for an ack effect', () => {
    const e: NotifiableEvent = { type: 'ack', entryId: 'e1', authorPk: 'pk1' }
    expect(notificationFor(e, guardian)).toBeNull()
    expect(notificationFor(e, child)).toBeNull()
  })

  it('null for a revoked effect', () => {
    const e: NotifiableEvent = { type: 'revoked', at: 100 }
    expect(notificationFor(e, guardian)).toBeNull()
    expect(notificationFor(e, child)).toBeNull()
  })

  it('null for a notify effect', () => {
    const e: NotifiableEvent = { type: 'notify', text: 'checkpoint' }
    expect(notificationFor(e, guardian)).toBeNull()
    expect(notificationFor(e, child)).toBeNull()
  })

  it('every guardian-owned row is null for role child (fix round 1)', () => {
    const audit: AuditResult = {
      id: 'a1',
      account: 'acc1',
      child: 'pk1',
      countedMinor: 450,
      expectedMinor: 500,
      deltaMinor: -50,
      at: 100,
      author: 'child',
    }
    const tick: ChoreTick = { id: 't1', chore: 'chore1', day: '2026-09-01', at: 100 }
    const guardianRows: NotifiableEvent[] = [
      {
        type: 'request',
        authorPk: 'pk1',
        payload: {
          v: 1,
          op: 'spend.request',
          reqId: 'r1',
          nonce: 'n1',
          child: 'c1',
          ts: 100,
          params: { amountMinor: 500, currency: 'GBP', account: 'acc1' },
        },
      },
      {
        type: 'request',
        authorPk: 'pk1',
        payload: {
          v: 1,
          op: 'allowance.claim',
          reqId: 'r2',
          nonce: 'n2',
          child: 'c1',
          ts: 100,
          params: { periodKey: '2026-09' },
        },
      },
      { type: 'pairAnswered', childName: 'Sam' },
      { type: 'audit', audit, authorPk: 'pk1' },
      { type: 'tick', tick, authorPk: 'pk1' },
    ]
    for (const row of guardianRows) {
      expect(notificationFor(row, child)).toBeNull()
    }
  })

  it('null when the role does not own the event (a grant effect with role: guardian)', () => {
    const e: NotifiableEvent = {
      type: 'grant',
      payload: { v: 1, reqId: 'r3', nonce: 'n3', decision: 'allow', ts: 100, params: { amountMinor: 500 } },
    }
    expect(notificationFor(e, guardian)).toBeNull()
  })

  it("falls back to 'your child' when childNameFor returns null", () => {
    const unknown = ctx('guardian', { childNameFor: () => null })
    const e: NotifiableEvent = {
      type: 'request',
      authorPk: 'unknown-pk',
      payload: {
        v: 1,
        op: 'spend.request',
        reqId: 'r9',
        nonce: 'n9',
        child: 'c1',
        ts: 100,
        params: { amountMinor: 500, currency: 'GBP', account: 'acc1' },
      },
    }
    expect(notificationFor(e, unknown)).toEqual({
      title: 'New ask from your child',
      body: 'GBP 5.00 — tap to decide',
      tag: 'ask:r9',
    })
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a string', 'not-a-number'],
    ['undefined', undefined],
  ])('is null for spend.request with a non-finite/malformed amountMinor (%s) — fix round 1', (_label, badAmount) => {
    const e: NotifiableEvent = {
      type: 'request',
      authorPk: 'pk1',
      payload: {
        v: 1,
        op: 'spend.request',
        reqId: 'r5',
        nonce: 'n5',
        child: 'c1',
        ts: 100,
        params: { amountMinor: badAmount as unknown as number, currency: 'GBP', account: 'acc1' },
      },
    }
    expect(notificationFor(e, guardian)).toBeNull()
  })

  it('never mentions the product\'s old name in any output', () => {
    const audit: AuditResult = {
      id: 'a1',
      account: 'acc1',
      child: 'pk1',
      countedMinor: 450,
      expectedMinor: 500,
      deltaMinor: -50,
      at: 100,
      author: 'child',
    }
    const entry: Entry = {
      v: 1,
      id: 'e1',
      child: 'c1',
      kind: 'credit',
      createdAt: 100,
      author: 'guardian',
      legs: [{ account: 'acc1', currency: 'GBP', amountMinor: 500 }],
      category: 'allowance',
    }
    const tick: ChoreTick = { id: 't1', chore: 'chore1', day: '2026-09-01', at: 100 }
    const events: NotifiableEvent[] = [
      {
        type: 'request',
        authorPk: 'pk1',
        payload: {
          v: 1,
          op: 'spend.request',
          reqId: 'r1',
          nonce: 'n1',
          child: 'c1',
          ts: 100,
          params: { amountMinor: 500, currency: 'GBP', account: 'acc1' },
        },
      },
      {
        type: 'request',
        authorPk: 'pk1',
        payload: {
          v: 1,
          op: 'allowance.claim',
          reqId: 'r2',
          nonce: 'n2',
          child: 'c1',
          ts: 100,
          params: { periodKey: '2026-09' },
        },
      },
      { type: 'pairAnswered', childName: 'Sam' },
      { type: 'audit', audit, authorPk: 'pk1' },
      { type: 'tick', tick, authorPk: 'pk1' },
      {
        type: 'grant',
        payload: { v: 1, reqId: 'r3', nonce: 'n3', decision: 'allow', ts: 100, params: { amountMinor: 500, asked: 500 } },
      },
      {
        type: 'grant',
        payload: { v: 1, reqId: 'r3', nonce: 'n3', decision: 'allow', ts: 100, params: { amountMinor: 300, asked: 500 } },
      },
      { type: 'grant', payload: { v: 1, reqId: 'r3', nonce: 'n3', decision: 'deny', ts: 100, params: {} } },
      { type: 'grant', payload: { v: 1, reqId: 'r3', nonce: 'n3', decision: 'dismissed', ts: 100, params: {} } },
      { type: 'entry', entry, authorPk: 'pk1' },
      { type: 'config', docKind: 'chores' },
    ]
    const allOutputs = [
      ...events.map((e) => notificationFor(e, guardian)),
      ...events.map((e) => notificationFor(e, child)),
    ]
    expect(JSON.stringify(allOutputs).toLowerCase()).not.toContain('kinterest')
  })
})
