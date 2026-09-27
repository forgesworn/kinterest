import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { KIND_CONFIG, KIND_ENTRY } from '../wire/kinds'
import { buildConfigPayload, buildEntryPayload } from '../wire/payloads'
import { creditEntry } from '../domain/ledger'
import type { Account } from '../domain/types'
import { emptyState } from '../state/state'
import type { AppState } from '../state/types'
import { pruneSupersededConfigs, retainCorpus } from './corpus'
import { ingestResyncEvents, resyncPage } from './resync'

const guardianSk = generateSecretKey()
const guardianPk = getPublicKey(guardianSk)
const childPk = getPublicKey(generateSecretKey())

const sign = (kind: number, content: unknown, createdAt: number): NostrEvent =>
  finalizeEvent({ kind, created_at: createdAt, tags: [], content: JSON.stringify(content) }, guardianSk)

const account = (id: string): Account => ({ id, child: childPk, name: id, currency: 'GBP', custody: 'ledger' })
const accountsDoc = (issuedAt: number, ids: string[]) => sign(KIND_CONFIG, buildConfigPayload('accounts', { v: 1, issuedAt, accounts: ids.map(account) }), issuedAt)
const choresDoc = (issuedAt: number) => sign(KIND_CONFIG, buildConfigPayload('chores', { v: 1, issuedAt, chores: [] }), issuedAt)
const byId = (...evs: NostrEvent[]) => Object.fromEntries(evs.map((e) => [e.id, e]))

describe('pruneSupersededConfigs', () => {
  it('keeps only the newest doc of each kind', () => {
    const a1 = accountsDoc(10, ['a1'])
    const a2 = accountsDoc(20, ['a1', 'a2'])
    const c1 = choresDoc(5)
    expect(Object.keys(pruneSupersededConfigs(byId(a1, a2, c1))).sort()).toEqual([a2.id, c1.id].sort())
  })

  it('keeps a CONFIG this build cannot read, and never lets it prune another', () => {
    const unreadable = sign(KIND_CONFIG, { v: 2, docKind: 'accounts', doc: { issuedAt: 99 } }, 99)
    const a1 = accountsDoc(10, ['a1'])
    expect(Object.keys(pruneSupersededConfigs(byId(unreadable, a1))).sort()).toEqual([unreadable.id, a1.id].sort())
  })

  it('keeps ties, and returns the same object when nothing is dropped', () => {
    const x = accountsDoc(10, ['a1'])
    const y = accountsDoc(10, ['a2'])
    const m = byId(x, y)
    expect(pruneSupersededConfigs(m)).toBe(m)
  })

  it('never touches another kind', () => {
    const e = sign(KIND_ENTRY, buildEntryPayload(creditEntry({ id: 'e1', child: childPk, createdAt: 1, author: 'guardian' }, account('a1'), 100)), 1)
    const m = byId(e, accountsDoc(10, ['a1']))
    expect(retainCorpus(m)).toEqual(m)
  })
})

describe('resync stays lossless over a pruned corpus', () => {
  it('a fresh child folds every entry in one exchange, although the only accounts doc is younger than them', () => {
    const old = accountsDoc(10, ['a1'])
    const entries = [1, 2, 3].map((n) =>
      sign(KIND_ENTRY, buildEntryPayload(creditEntry({ id: `e${n}`, child: childPk, createdAt: 10 + n, author: 'guardian' }, account('a1'), 100 * n)), 10 + n),
    )
    const newest = accountsDoc(500, ['a1', 'a2'])
    const serving: AppState = { ...emptyState(), role: 'child', guardianPubkey: guardianPk, innerEvents: retainCorpus(byId(old, ...entries, newest)) }
    expect(Object.keys(serving.innerEvents)).not.toContain(old.id)

    const fresh: AppState = { ...emptyState(), role: 'guardian', guardianPubkey: guardianPk, self: { pubkey: guardianPk, childIndex: null } }
    const page = resyncPage(serving, null, 0)
    expect(page.events[0]!.id).toBe(newest.id)
    const result = ingestResyncEvents(fresh, page.events, { peerPk: childPk, nowSec: 1000 })
    expect(result.rejected).toEqual([])
    expect(result.state.entries.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3'])
    expect(result.state.docs.accounts.issuedAt).toBe(500)
  })
})
