import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { emptyState } from '../state/state'
import type { AppState, ConfigDocs } from '../state/types'
import type { Account } from '../domain/types'
import type { InterestConfig } from '../domain/interest'
import type { AllowanceConfig } from '../domain/allowance'
import { unwrapFrom, wrapFor } from '../wire/giftwrap'
import { KIND_CONFIG } from '../wire/kinds'
import { buildConfigPayload, parseConfigPayload } from '../wire/payloads'
import type { RelayLike } from '../wire/relayClient'
import type { StorageLike } from '../wire/outbox'
import { handleWrap } from './ingress'
import { compareStatus, ingestResyncEvents, resyncPage, statusFor } from './resync'
import { sendConfig } from './publish'

const NOW = 1_800_000_000
const keys = () => {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}
const guardian = keys()
const alex = keys()
const sam = keys()

const acct = (id: string, child: string): Account => ({ id, child, name: id, currency: 'GBP', custody: 'ledger' })
const allowance = (child: string, account: string, amountMinor: number): AllowanceConfig => ({
  child, account, amountMinor, cadence: 'weekly', day: 5, tz: 'UTC', startDay: '2026-08-01',
})
const interest = (child: string, account: string): InterestConfig => ({
  child, account, rateBps: 100, cadence: 'weekly', day: 5, tz: 'UTC', startDay: '2026-08-01', matchBps: 5000,
})

const family: ConfigDocs = {
  accounts: { v: 1, issuedAt: NOW - 50, accounts: [acct('a-alex', alex.pk), acct('a-sam', sam.pk)], revoked: { [sam.pk]: NOW - 60 } },
  allowance: { v: 1, issuedAt: NOW - 50, configs: [allowance(alex.pk, 'a-alex', 500), allowance(sam.pk, 'a-sam', 900)] },
  interest: { v: 1, issuedAt: NOW - 50, configs: [interest(alex.pk, 'a-alex'), interest(sam.pk, 'a-sam')] },
  chores: { v: 1, issuedAt: NOW - 50, chores: [{ id: 'c-alex', child: alex.pk, name: 'Bed', cadence: 'daily' }, { id: 'c-sam', child: sam.pk, name: 'Dishes', cadence: 'daily' }] },
}

function memStorage(): StorageLike {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }
}

function capture(): RelayLike & { published: NostrEvent[] } {
  const published: NostrEvent[] = []
  return { published, publish: async (ev) => (published.push(ev), 'accepted'), subscribe: () => () => {} }
}

async function sendAll(to: string): Promise<NostrEvent[]> {
  const relay = capture()
  for (const kind of ['accounts', 'allowance', 'interest', 'chores'] as const) {
    await sendConfig(kind, family[kind], { selfSk: guardian.sk, peerPk: to, relay, storage: memStorage(), nowSec: NOW })
  }
  return relay.published
}

const childOf = (pk: string, index: number): AppState => ({
  ...emptyState(),
  role: 'child',
  guardianPubkey: guardian.pk,
  self: { pubkey: pk, childIndex: index },
})

describe('sendConfig: each child gets only its own rows', () => {
  it('carries the recipient s accounts, configs, chores and own revoked row, at the doc s issuedAt', async () => {
    const wraps = await sendAll(alex.pk)
    const docs = wraps.map((w) => parseConfigPayload(unwrapFrom({ wrap: w, recipientSk: alex.sk, expectedAuthorPk: guardian.pk })!.payload)!)
    const text = JSON.stringify(docs)
    expect(text).not.toContain(sam.pk)
    expect(text).not.toContain('a-sam')
    expect(text).not.toContain('Dishes')
    for (const d of docs) expect((d.doc as { issuedAt: number }).issuedAt).toBe(NOW - 50)
    expect(docs.map((d) => d.docKind)).toEqual(['accounts', 'allowance', 'interest', 'chores'])

    const samDocs = (await sendAll(sam.pk)).map((w) => parseConfigPayload(unwrapFrom({ wrap: w, recipientSk: sam.sk, expectedAuthorPk: guardian.pk })!.payload)!)
    expect(samDocs[0]!.doc).toEqual({ v: 1, issuedAt: NOW - 50, accounts: [acct('a-sam', sam.pk)], revoked: { [sam.pk]: NOW - 60 } })
  })

  it('a child applying its view holds all of its own rows, and its heartbeat agrees with the guardian', async () => {
    let child = childOf(alex.pk, 0)
    for (const w of await sendAll(alex.pk)) child = handleWrap(child, w, alex.sk, guardian.pk, NOW).state
    expect(child.docs.accounts.accounts).toEqual([acct('a-alex', alex.pk)])
    expect(child.docs.allowance.configs).toEqual([allowance(alex.pk, 'a-alex', 500)])
    expect(child.docs.interest.configs).toEqual([interest(alex.pk, 'a-alex')])
    expect(child.docs.chores.chores.map((c) => c.id)).toEqual(['c-alex'])

    const guardianApp: AppState = {
      ...emptyState(),
      role: 'guardian',
      guardianPubkey: guardian.pk,
      self: { pubkey: guardian.pk, childIndex: null },
      docs: family,
      docHighWater: { accounts: NOW - 50, allowance: NOW - 50, interest: NOW - 50, chores: NOW - 50 },
    }
    const verdict = compareStatus(statusFor(guardianApp, alex.pk, 't', NOW), statusFor(child, null, 't', NOW))
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('a child holding an older family-wide doc takes its narrowed view, and an older unfiltered doc is a no-op', async () => {
    const older = { ...family.allowance, issuedAt: NOW - 500 }
    let child: AppState = { ...childOf(alex.pk, 0), docs: { ...emptyState().docs, allowance: older }, docHighWater: { allowance: NOW - 500 } }
    for (const w of await sendAll(alex.pk)) child = handleWrap(child, w, alex.sk, guardian.pk, NOW).state
    expect(child.docs.allowance.configs).toEqual([allowance(alex.pk, 'a-alex', 500)])

    // An unfiltered doc from before the upgrade (still queued somewhere) arrives late: LWW drops it.
    const stale = { ...family.allowance, issuedAt: NOW - 400 }
    const direct = wrapFor({ innerKind: KIND_CONFIG, payload: buildConfigPayload('allowance', stale), authorSk: guardian.sk, recipientPk: alex.pk, nowSec: NOW })
    const after = handleWrap(child, direct, alex.sk, guardian.pk, NOW).state
    expect(after.docs.allowance).toBe(child.docs.allowance)

    // A newer unfiltered doc (an older guardian build) still applies and still works for the child.
    const newer = { ...family.allowance, issuedAt: NOW - 10 }
    const wrap = wrapFor({ innerKind: KIND_CONFIG, payload: buildConfigPayload('allowance', newer), authorSk: guardian.sk, recipientPk: alex.pk, nowSec: NOW })
    const took = handleWrap(child, wrap, alex.sk, guardian.pk, NOW).state
    expect(took.docs.allowance.configs.find((c) => c.child === alex.pk)?.amountMinor).toBe(500)
  })
})

describe('a recovering guardian rebuilds the family docs from each child s view', () => {
  it('merges views that share one issuedAt instead of keeping only the first', async () => {
    let alexApp = childOf(alex.pk, 0)
    for (const w of await sendAll(alex.pk)) alexApp = handleWrap(alexApp, w, alex.sk, guardian.pk, NOW).state
    let samApp = childOf(sam.pk, 1)
    for (const w of await sendAll(sam.pk)) samApp = handleWrap(samApp, w, sam.sk, guardian.pk, NOW).state

    let recovered: AppState = {
      ...emptyState(),
      role: 'guardian',
      guardianPubkey: guardian.pk,
      self: { pubkey: guardian.pk, childIndex: null },
    }
    recovered = ingestResyncEvents(recovered, resyncPage(alexApp, null, 0, null).events, { peerPk: alex.pk, nowSec: NOW }).state
    recovered = ingestResyncEvents(recovered, resyncPage(samApp, null, 0, null).events, { peerPk: sam.pk, nowSec: NOW }).state

    expect(recovered.docs.accounts.accounts.map((a) => a.id).sort()).toEqual(['a-alex', 'a-sam'])
    expect(recovered.docs.accounts.revoked).toEqual({ [sam.pk]: NOW - 60 })
    expect(recovered.docs.allowance.configs.map((c) => c.amountMinor).sort()).toEqual([500, 900])
    expect(recovered.docs.interest.configs).toHaveLength(2)
    expect(recovered.docs.chores.chores.map((c) => c.id).sort()).toEqual(['c-alex', 'c-sam'])
    expect(recovered.docHighWater.accounts).toBe(NOW - 50)

    // Neither child is ever served another s view back.
    expect(resyncPage(recovered, null, 0, alex.pk).events.filter((e) => e.kind === KIND_CONFIG)).toEqual([])
  })
})
