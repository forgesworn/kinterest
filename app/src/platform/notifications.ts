// platform/notifications.ts — pure copy helper for the local/foreground
// notifications D3 introduces (v0.2 spec §3.1). Deliberately knows nothing
// about `document`, `Notification`, or the shell bridge (shell.ts#notify is
// the impure edge that actually fires one) — this module only ever answers
// "what would this notification say, if anything", so it can be unit
// tested with plain fixtures and no DOM.
//
// The table in spec §3.1 IS the specification: one case per row, in table
// order, `null` for every row the app owns no copy for (a role the event
// isn't addressed to, a zero-delta audit, or any effect not in the table at
// all — `ack`/`notify`/`revoked` included, per the spec's "either -> anything
// else -> (null)" catch-all).

import type { Effect } from '../sync/ingress'

/** The pair-claim-answered case has no ingress `Effect` of its own — it is
 *  synthesised by the caller (Task E4, store-side) once `pairing.ts`
 *  resolves an offer, not routed through `sync/ingress.ts`. */
export type NotifiableEvent = Effect | { type: 'pairAnswered'; childName: string }

export interface NotificationContent {
  title: string
  body: string
  tag: string
}

export interface NotificationContext {
  role: 'guardian' | 'child'
  /** Resolves a child pubkey to a display name; null when unknown. */
  childNameFor: (pubkey: string) => string | null
  /** e.g. formatMoney(500, 'GBP') === '£5.00' — components/Money.tsx's formatter. */
  formatMoney: (amountMinor: number, currency: string) => string
  /** Resolves an account id (AuditResult#account carries only the id, never
   *  a currency of its own — domain/audit.ts) to that account's currency;
   *  null when the account is unknown (deleted/never synced). Fix round 1:
   *  the audit row previously hard-coded a GBP fallback unconditionally;
   *  the store's `notificationContextFor` now has the real answer
   *  (`app.docs.accounts.accounts`), so this module only falls back to
   *  `FALLBACK_CURRENCY` when even THAT lookup comes back empty. */
  currencyForAccount: (accountId: string) => string | null
}

function nameFor(ctx: NotificationContext, pubkey: string): string {
  return ctx.childNameFor(pubkey) ?? 'your child'
}

/** Last-resort currency when nothing better is available: an audit whose
 *  account `currencyForAccount` can't resolve, or a `spend.request` whose
 *  self-reported `params.currency` isn't even a string. Matches the same
 *  fallback screens/Home.tsx#lastCurrency already uses when a child has no
 *  accounts to read a currency off at all. Named generically (not
 *  audit-specific) because both call sites below use it. */
const FALLBACK_CURRENCY = 'GBP'

/** Pure and total. `null` = nothing worth interrupting the user for. */
export function notificationFor(e: NotifiableEvent, ctx: NotificationContext): NotificationContent | null {
  switch (e.type) {
    case 'request': {
      if (ctx.role !== 'guardian') return null
      const name = nameFor(ctx, e.authorPk)
      if (e.payload.op === 'spend.request') {
        const params = e.payload.params
        // Fix round 1: a malformed/non-finite amountMinor (NaN, Infinity, or
        // simply the wrong type — self-reported over the wire, and
        // wire/payloads.ts's own isSpendRequestParams checks only that
        // `amountMinor` is typeof 'number', never that it's finite) used to
        // silently fall back to 0 and show "£0.00 — tap to decide", which
        // looks like a real, decidable ask rather than the garbage it is.
        // Refusing to build any copy at all is the same "either -> anything
        // else -> (null)" discipline this module applies everywhere else.
        if (typeof params.amountMinor !== 'number' || !Number.isFinite(params.amountMinor)) return null
        const amountMinor = params.amountMinor
        const currency = typeof params.currency === 'string' ? params.currency : FALLBACK_CURRENCY
        return {
          title: `New ask from ${name}`,
          body: `${ctx.formatMoney(amountMinor, currency)} — tap to decide`,
          tag: `ask:${e.payload.reqId}`,
        }
      }
      if (e.payload.op === 'allowance.claim') {
        return {
          title: `Pocket money claim from ${name}`,
          body: 'Tap to review',
          tag: `ask:${e.payload.reqId}`,
        }
      }
      // pair.claim (or any future op) — no copy owned here.
      return null
    }

    case 'grant': {
      if (ctx.role !== 'child') return null
      const tag = `grant:${e.payload.reqId}`
      const { decision, params } = e.payload
      if (decision === 'allow') {
        const amountMinor = params.amountMinor
        const asked = params.asked
        const lessThanAsked =
          typeof amountMinor === 'number' && typeof asked === 'number' && amountMinor < asked
        return lessThanAsked
          ? { title: 'Approved — a bit less than you asked for', body: "That's OK! Tap to see.", tag }
          : { title: 'Your ask was approved', body: 'Tap to see.', tag }
      }
      if (decision === 'deny') {
        return { title: 'Not this time', body: 'Tap to see what your parent said.', tag }
      }
      // 'dismissed'
      return { title: 'Not now', body: 'Your parent will come back to this.', tag }
    }

    case 'audit': {
      if (ctx.role !== 'guardian') return null
      if (e.audit.deltaMinor === 0) return null
      const name = nameFor(ctx, e.audit.child)
      const currency = ctx.currencyForAccount(e.audit.account) ?? FALLBACK_CURRENCY
      const counted = ctx.formatMoney(e.audit.countedMinor, currency)
      const expected = ctx.formatMoney(e.audit.expectedMinor, currency)
      return {
        title: `${name}'s coin count doesn't match`,
        body: `Counted ${counted}, the ledger says ${expected}.`,
        tag: `audit:${e.audit.id}`,
      }
    }

    case 'tick': {
      if (ctx.role !== 'guardian') return null
      const name = nameFor(ctx, e.authorPk)
      return { title: `${name} ticked off a job`, body: 'Tap to see.', tag: `tick:${e.tick.id}` }
    }

    case 'entry': {
      if (ctx.role !== 'child') return null
      if (e.entry.category !== 'allowance' && e.entry.category !== 'interest') return null
      const leg = e.entry.legs.find((l) => l.amountMinor > 0) ?? e.entry.legs[0]
      if (!leg) return null
      const money = ctx.formatMoney(leg.amountMinor, leg.currency)
      const title = e.entry.category === 'allowance' ? 'Pocket money landed' : 'Interest landed'
      return { title, body: `${money} is in your jar.`, tag: `entry:${e.entry.id}` }
    }

    case 'config': {
      if (ctx.role !== 'child') return null
      if (e.docKind !== 'chores') return null
      return { title: 'New job on your list', body: 'Tap to see.', tag: 'chores' }
    }

    case 'pairAnswered': {
      if (ctx.role !== 'guardian') return null
      return {
        title: `${e.childName}'s device is paired`,
        body: 'You can set up their pocket money now.',
        tag: 'pair',
      }
    }

    // 'ack', 'notify', 'revoked' — and any future effect not in the table —
    // own no copy here: "either -> anything else -> (null)".
    default:
      return null
  }
}
