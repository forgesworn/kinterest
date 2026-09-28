// sync/snapshot.ts — what a SNAPSHOT or CONFIG sent to one child device may
// carry.
//
// A snapshot is the guardian's "here is where you should be" message: the
// pairing offer embeds one, and a heartbeat that shows a child behind is
// answered with one. It used to carry the WHOLE family — every sibling's
// ledger, chores, pocket-money and interest settings — to whichever child
// asked. The resync path had already been scoped per child
// (`resync.ts#resyncPage`); this is the same rule for the snapshot path, and
// `scopeDoc` is the same rule for every live CONFIG (`publish.ts#sendConfig`
// narrows each doc to its recipient before sealing it).
//
// Scoped to ONE child, a snapshot carries:
//   - that child's own profile (never a sibling's name or key);
//   - that child's own ledger entries;
//   - the four config docs, each narrowed to the rows that name that child —
//     its accounts, its allowance and interest configs, its chores — and the
//     accounts doc's `revoked` map narrowed to that child's own key (the one
//     row it needs: it is how a removed device learns it was removed). The
//     only family-level fields a narrowed doc keeps are `v` and `issuedAt`.
//
// The docs keep their `issuedAt`. That is what lets a narrowed doc stand in
// for the family-wide one on the child: `applyConfigDoc`'s LWW compares
// `issuedAt` only, and a child only ever reads its own rows. A child already
// holding the family-wide doc at the same `issuedAt` keeps it (a no-op, the
// safe direction); one behind takes the narrowed doc and so loses any sibling
// rows it held. It is also what keeps the heartbeat converging: the child's
// `docHighWater` ends at the `issuedAt` of the view it was sent, which is the
// guardian's own high-water for that doc.

import type { AppState, ConfigDocs, StoredRequest } from '../state/types'
import { buildGrantPayload, MAX_SNAPSHOT_GRANTS, type GrantPayload, type SnapshotState } from '../wire/payloads'

/** One config doc narrowed to the rows naming `childPk`, keeping its `v` and
 *  `issuedAt`. Pure. Built field by field rather than spread, so a
 *  family-level field added to a doc later is never passed on by default. */
export function scopeDoc<K extends keyof ConfigDocs>(docKind: K, doc: ConfigDocs[K], childPk: string): ConfigDocs[K] {
  switch (docKind) {
    case 'accounts': {
      const d = doc as ConfigDocs['accounts']
      const revokedAt = d.revoked?.[childPk]
      const scoped: ConfigDocs['accounts'] = {
        v: d.v,
        issuedAt: d.issuedAt,
        accounts: d.accounts.filter((a) => a.child === childPk),
        ...(revokedAt !== undefined ? { revoked: { [childPk]: revokedAt } } : {}),
      }
      return scoped as ConfigDocs[K]
    }
    case 'allowance': {
      const d = doc as ConfigDocs['allowance']
      const scoped: ConfigDocs['allowance'] = { v: d.v, issuedAt: d.issuedAt, configs: d.configs.filter((c) => c.child === childPk) }
      return scoped as ConfigDocs[K]
    }
    case 'interest': {
      const d = doc as ConfigDocs['interest']
      const scoped: ConfigDocs['interest'] = { v: d.v, issuedAt: d.issuedAt, configs: d.configs.filter((c) => c.child === childPk) }
      return scoped as ConfigDocs[K]
    }
    default: {
      const d = doc as ConfigDocs['chores']
      const scoped: ConfigDocs['chores'] = { v: d.v, issuedAt: d.issuedAt, chores: d.chores.filter((c) => c.child === childPk) }
      return scoped as ConfigDocs[K]
    }
  }
}

/** The children a config doc's rows name (and, for the accounts doc, the
 *  keys in its `revoked` map). Pure. */
export function docChildren<K extends keyof ConfigDocs>(docKind: K, doc: ConfigDocs[K]): Set<string> {
  const out = new Set<string>()
  if (docKind === 'accounts') {
    const d = doc as ConfigDocs['accounts']
    for (const a of d.accounts) out.add(a.child)
    for (const pk of Object.keys(d.revoked ?? {})) out.add(pk)
  } else if (docKind === 'chores') {
    for (const c of (doc as ConfigDocs['chores']).chores) out.add(c.child)
  } else {
    for (const c of (doc as ConfigDocs['allowance'] | ConfigDocs['interest']).configs) out.add(c.child)
  }
  return out
}

/** The four config docs narrowed to the rows naming `childPk`. Pure. */
export function scopeDocs(docs: ConfigDocs, childPk: string): ConfigDocs {
  return {
    accounts: scopeDoc('accounts', docs.accounts, childPk),
    allowance: scopeDoc('allowance', docs.allowance, childPk),
    interest: scopeDoc('interest', docs.interest, childPk),
    chores: scopeDoc('chores', docs.chores, childPk),
  }
}

/**
 * The snapshot state for ONE child device. Pure.
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
