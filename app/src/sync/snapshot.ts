// sync/snapshot.ts — what a SNAPSHOT sent to one child device may carry.
//
// A snapshot is the guardian's "here is where you should be" message: the
// pairing offer embeds one, and a heartbeat that shows a child behind is
// answered with one. It used to carry the WHOLE family — every sibling's
// ledger, chores, pocket-money and interest settings — to whichever child
// asked (audit P6). The resync path had already been scoped per child
// (`resync.ts#resyncPage`); this is the same rule for the snapshot path.
//
// Scoped to ONE child, a snapshot carries:
//   - that child's own profile (never a sibling's name or key);
//   - that child's own ledger entries;
//   - the four config docs, each narrowed to the rows that name that child —
//     its accounts, its allowance and interest configs, its chores — and the
//     accounts doc's `revoked` map narrowed to that child's own key (the one
//     row it needs: it is how a removed device learns it was removed).
//
// The docs keep their `issuedAt`. That is what lets a narrowed doc stand in
// for the family-wide one on the child: `applyConfigDoc`'s LWW compares
// `issuedAt` only, and a child only ever reads its own rows. A child already
// holding the family-wide doc at the same `issuedAt` keeps it (a no-op, the
// safe direction); one behind takes the narrowed doc and so loses any sibling
// rows it held.
//
// Live CONFIG fan-out still sends the family-wide doc to every child — each
// is one signed event, and narrowing it would mean a per-child doc on the
// wire. That is outside this module.

import type { AppState, ConfigDocs, StoredRequest } from '../state/types'
import { buildGrantPayload, MAX_SNAPSHOT_GRANTS, type GrantPayload, type SnapshotState } from '../wire/payloads'

/** The four config docs narrowed to the rows naming `childPk`. Pure. */
export function scopeDocs(docs: ConfigDocs, childPk: string): ConfigDocs {
  const revokedAt = docs.accounts.revoked?.[childPk]
  return {
    accounts: {
      v: docs.accounts.v,
      issuedAt: docs.accounts.issuedAt,
      accounts: docs.accounts.accounts.filter((a) => a.child === childPk),
      ...(revokedAt !== undefined ? { revoked: { [childPk]: revokedAt } } : {}),
    },
    allowance: { ...docs.allowance, configs: docs.allowance.configs.filter((c) => c.child === childPk) },
    interest: { ...docs.interest, configs: docs.interest.configs.filter((c) => c.child === childPk) },
    chores: { ...docs.chores, chores: docs.chores.chores.filter((c) => c.child === childPk) },
  }
}

/**
 * The snapshot state for ONE child device (audit P6). Pure.
 *
 * `childPk` is the pubkey of the child the snapshot is ADDRESSED to — the
 * authenticated peer on a heartbeat, the roster entry being paired on an
 * offer. Nothing in the result belongs to any other child.
 */
export function scopeSnapshotState(app: AppState, childPk: string): SnapshotState {
  return {
    children: app.children.filter((c) => c.pubkey === childPk),
    entries: app.entries.filter((e) => e.child === childPk),
    docs: scopeDocs(app.docs, childPk),
  }
}

/**
 * The GRANT the guardian sent for one decided ask, rebuilt from its own
 * record of the decision. Pure; `null` for an ask still pending.
 *
 * The guardian keeps no copy of the GRANT events it sent (its resync corpus
 * holds only what it RECEIVED), so the record is the source. The params
 * mirror `store.tsx#buildGrantDecision` exactly: an allowed spend carries the
 * amount actually granted; an allowance claim, whatever the decision,
 * carries its `periodKey` (the child matches claims by it); anything else
 * carries none. `ts` is when the decision was taken.
 */
export function grantFor(record: StoredRequest): GrantPayload | null {
  if (record.status === 'pending') return null
  const { request } = record
  const decision = record.status === 'approved' ? 'allow' : record.status === 'denied' ? 'deny' : 'dismissed'
  let params: Record<string, unknown> = {}
  if (request.op === 'allowance.claim') {
    params = { periodKey: request.params.periodKey }
  } else if (request.op === 'spend.request' && decision === 'allow') {
    params = { amountMinor: record.grantedAmountMinor ?? request.params.amountMinor }
  }
  return buildGrantPayload({ reqId: request.reqId, nonce: request.nonce, decision, ts: record.decidedAt ?? record.createdAt, params })
}

/**
 * The GRANTs a snapshot for `childPk` carries: that child's decided asks,
 * newest decision first, at most `MAX_SNAPSHOT_GRANTS`. Pure.
 *
 * Scoped by the AUTHENTICATED author the guardian recorded (`authorPk`,
 * which `upsertRequest` binds to `request.child`), so one child is never
 * handed a sibling's decisions.
 */
export function grantsFor(app: AppState, childPk: string): GrantPayload[] {
  return app.requests
    .filter((r) => r.authorPk === childPk && r.request.child === childPk && r.status !== 'pending')
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .slice(0, MAX_SNAPSHOT_GRANTS)
    .map(grantFor)
    .filter((g): g is GrantPayload => g !== null)
}
