// sync/corpus.ts — bounding the lossless resync corpus (`AppState.innerEvents`).
//
// `state.ts#retainInnerEvents` keeps every ENTRY, CONFIG and GRANT and the
// newest CHILD_SIGs. CONFIG was the unbounded part that did not need to be
// (v0.2 spec §2.3, "Size note"): each config doc is full-state replaceable,
// so once a later doc of the same kind exists, an earlier one can never be
// applied again anywhere — `applyConfigDoc`'s LWW drops it on sight. Keeping
// it only costs storage, at a few KB a change.
//
// What must survive, for resync to stay lossless:
//   - the newest doc of each kind, which is the one a replay needs;
//   - every CONFIG this build cannot read. It may be a newer build's doc,
//     and the corpus exists to hand such events on intact (spec §2.3). It
//     is never pruned, and it never prunes anything else either: an older
//     device that cannot read it either still needs the doc it can read.
//
// Only a doc this build can parse, superseded by a LATER `issuedAt` of the
// same kind that this build can also parse, is dropped. Ties are kept. A doc
// dated beyond the receiver's clock-skew bound is kept but prunes nothing:
// every receiver defers it, so the older doc is the one they all apply.
//
// Replay order matters once older docs are gone: an old ENTRY may name an
// account that only the newest accounts doc now describes, and that doc may
// be much younger than the entry. `resync.ts#resyncPage` therefore serves
// CONFIG before everything else. Accounts and chores are archived, never
// removed from their doc, so the newest doc still describes every one.

import type { NostrEvent } from 'nostr-tools/pure'
import { KIND_CONFIG } from '../wire/kinds'
import { parseConfigPayload } from '../wire/payloads'
import { retainInnerEvents } from '../state/state'

/** The doc kind and `issuedAt` of a CONFIG this build can read, else null.
 *  Total. */
function configStamp(ev: NostrEvent): { docKind: string; issuedAt: number } | null {
  if (ev.kind !== KIND_CONFIG) return null
  try {
    const parsed = parseConfigPayload(JSON.parse(ev.content))
    if (parsed === null) return null
    return { docKind: parsed.docKind, issuedAt: (parsed.doc as { issuedAt: number }).issuedAt }
  } catch {
    return null
  }
}

/**
 * Drops CONFIG events superseded by a later `issuedAt` of the same doc kind
 * (see this module's header for what is kept, and why). A doc whose
 * `issuedAt` is beyond `maxIssuedAt` (unix SECONDS: the receiver's clock plus
 * its skew bound) never supersedes anything. Pure; the input object is
 * returned as-is when nothing is dropped.
 */
export function pruneSupersededConfigs(m: Record<string, NostrEvent>, maxIssuedAt = Infinity): Record<string, NostrEvent> {
  const newest = new Map<string, number>()
  const stamps = new Map<string, { docKind: string; issuedAt: number }>()
  for (const [key, ev] of Object.entries(m)) {
    const stamp = configStamp(ev)
    if (stamp === null) continue
    stamps.set(key, stamp)
    if (stamp.issuedAt > maxIssuedAt) continue
    if (stamp.issuedAt > (newest.get(stamp.docKind) ?? -1)) newest.set(stamp.docKind, stamp.issuedAt)
  }

  let dropped = false
  const kept: Record<string, NostrEvent> = {}
  for (const [key, ev] of Object.entries(m)) {
    const stamp = stamps.get(key)
    const newestKind = stamp === undefined ? undefined : newest.get(stamp.docKind)
    if (stamp !== undefined && newestKind !== undefined && stamp.issuedAt < newestKind) {
      dropped = true
      continue
    }
    kept[key] = ev
  }
  return dropped ? kept : m
}

/** The corpus bound every insert applies: the per-kind retention rules of
 *  `retainInnerEvents`, then CONFIG pruning (`maxIssuedAt` as for
 *  `pruneSupersededConfigs`). Pure. */
export function retainCorpus(m: Record<string, NostrEvent>, maxIssuedAt = Infinity): Record<string, NostrEvent> {
  return pruneSupersededConfigs(retainInnerEvents(m), maxIssuedAt)
}
