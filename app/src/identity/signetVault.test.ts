// Vault SELECTION is pure and lives here, away from every relay and signer —
// so the rule that decides which backup a recovering guardian restores from
// is testable without importing `signet-login` (spec §1.6 step 4).

import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import vectorsRaw from '../wire/vectors/wire-v1.json'
import { makeFakeRelay } from '../wire/fakeRelay'
import { wrapFor } from '../wire/giftwrap'
import { KIND_VAULT } from '../wire/kinds'
import { buildVaultPayload } from '../wire/payloads'
import { rootChallenge } from './signetRoot'
import {
  collectVaultCandidates,
  pickFamilyVault,
  pickNewestVault,
  shouldPublishVault,
  vaultPayloadFor,
  vaultPublishDue,
  VAULT_REPUBLISH_AFTER_SECS,
} from './signetVault'

/** The family's My Signet identity — the one a recovery logs in as, and the
 *  one every genuine vault's attestation must be signed by (item C1). */
const rootSk = generateSecretKey()
const rootPk = getPublicKey(rootSk)
/** Somebody else's Signet identity, used to plant vaults. */
const attackerSk = generateSecretKey()

const SIGNET_AUTH_KIND = 21236

/** A kind-21236 attestation: `sk`'s Signet identity claiming `guardianPk`. */
function attest(sk: Uint8Array, guardianPk: string, at = 1): NostrEvent {
  return finalizeEvent(
    { kind: SIGNET_AUTH_KIND, created_at: at, tags: [['challenge', rootChallenge(guardianPk)]], content: '' },
    sk,
  )
}

const p = (m: string, pk: string, at: number, sk: Uint8Array = rootSk) => ({
  payload: { v: 1, type: 'vault', mnemonic: m, guardianPk: pk, authEvent: attest(sk, pk, at), createdAt: at },
  createdAt: at,
})

describe('pickNewestVault', () => {
  it('picks the newest valid, self-consistent vault', () => {
    const got = pickNewestVault(
      [p('old', 'a'.repeat(64), 1), p('new', 'b'.repeat(64), 9)],
      rootPk,
      () => true,
      (m) => (m === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)),
    )
    expect(got?.mnemonic).toBe('new')
  })

  it('skips a vault whose mnemonic fails validation or does not derive its guardianPk', () => {
    expect(pickNewestVault([p('bad', 'a'.repeat(64), 9)], rootPk, () => false, () => 'a'.repeat(64))).toBeNull()
    expect(pickNewestVault([p('ok', 'a'.repeat(64), 9)], rootPk, () => true, () => 'c'.repeat(64))).toBeNull()
  })

  it('returns null for garbage candidates', () => {
    expect(pickNewestVault([{ payload: null, createdAt: 1 }], rootPk, () => true, () => '')).toBeNull()
    expect(pickNewestVault([], rootPk, () => true, () => '')).toBeNull()
  })

  it('falls back to an older vault when the newest one is unusable', () => {
    const got = pickNewestVault(
      [p('good', 'a'.repeat(64), 1), p('torn', 'b'.repeat(64), 9)],
      rootPk,
      (m) => m !== 'torn',
      () => 'a'.repeat(64),
    )
    expect(got?.mnemonic).toBe('good')
  })

  it('carries the roster the vault was published with', () => {
    const roster = { pubkey: 'c'.repeat(64), name: 'Alex', index: 0 }
    const got = pickNewestVault(
      [
        {
          payload: {
            v: 1,
            type: 'vault',
            mnemonic: 'ok',
            guardianPk: 'a'.repeat(64),
            authEvent: attest(rootSk, 'a'.repeat(64), 7),
            children: [roster],
            relays: ['wss://relay.example'],
            createdAt: 7,
          },
          createdAt: 7,
        },
      ],
      rootPk,
      () => true,
      () => 'a'.repeat(64),
    )
    expect(got?.children).toEqual([roster])
    expect(got?.relays).toEqual(['wss://relay.example'])
  })

  it('is total — a validator or derivation that throws is a skipped candidate, not a crash', () => {
    expect(() =>
      pickNewestVault([p('ok', 'a'.repeat(64), 1)], rootPk, () => {
        throw new Error('boom')
      }, () => 'a'.repeat(64)),
    ).not.toThrow()
    expect(
      pickNewestVault([p('ok', 'a'.repeat(64), 1)], rootPk, () => true, () => {
        throw new Error('boom')
      }),
    ).toBeNull()
  })

  // ==========================================================================
  // Item C1 — the vault recovery hijack.
  //
  // The recovery inbox is a PUBLIC relay filter: `{kinds:[1059],
  // '#p':[signetPk]}`. Anyone at all can gift-wrap an event to a Signet
  // pubkey, and the wrap author is not the family's guardian and never had
  // to be. So an attacker who knows (or scrapes) a victim's Signet pubkey
  // could publish a vault holding THEIR OWN mnemonic and their own guardian
  // key — a vault that parses, whose mnemonic passes BIP-39, and which
  // derives exactly the guardianPk it claims. Every gate this function had
  // was satisfiable by the attacker, and newest-first ordering made a
  // freshly planted vault beat the family's real one every time. The
  // guardian recovering from a lost phone would then commit the attacker's
  // family: the attacker's keys, the attacker's roster, the attacker's
  // relays, and — since the guardian goes on to publish from it — a family
  // whose ledger the attacker can write.
  //
  // The attestation closes it. It is signed by the Signet key the recovery
  // is logging in AS, over a challenge bound to the vault's own guardianPk;
  // an attacker with no access to that key cannot produce one, and cannot
  // reuse the family's real attestation either, because it binds the real
  // guardianPk and the attacker's vault claims a different one.
  // ==========================================================================

  it('ignores a planted vault attested by a FOREIGN Signet key, and takes the genuine older one', () => {
    const genuine = p('genuine', 'a'.repeat(64), 1)
    const planted = p('planted', 'b'.repeat(64), 9, attackerSk)
    const got = pickNewestVault([genuine, planted], rootPk, () => true, (m) => (m === 'genuine' ? 'a'.repeat(64) : 'b'.repeat(64)))
    expect(got?.mnemonic).toBe('genuine')
  })

  it('returns null when the ONLY vault on offer is a planted one', () => {
    expect(pickNewestVault([p('planted', 'b'.repeat(64), 9, attackerSk)], rootPk, () => true, () => 'b'.repeat(64))).toBeNull()
  })

  it('ignores an attestation that binds a DIFFERENT guardian key — a stolen one, replayed', () => {
    const stolen = attest(rootSk, 'f'.repeat(64), 9)
    const candidate = {
      payload: { v: 1, type: 'vault', mnemonic: 'planted', guardianPk: 'b'.repeat(64), authEvent: stolen, createdAt: 9 },
      createdAt: 9,
    }
    expect(pickNewestVault([candidate], rootPk, () => true, () => 'b'.repeat(64))).toBeNull()
  })

  it('ignores a vault whose attestation signature has been tampered with', () => {
    const good = attest(rootSk, 'b'.repeat(64), 9)
    const candidate = {
      payload: {
        v: 1,
        type: 'vault',
        mnemonic: 'planted',
        guardianPk: 'b'.repeat(64),
        authEvent: { ...good, sig: good.sig.replace(/^./, good.sig[0] === '0' ? '1' : '0') },
        createdAt: 9,
      },
      createdAt: 9,
    }
    expect(pickNewestVault([candidate], rootPk, () => true, () => 'b'.repeat(64))).toBeNull()
  })

  it('ignores a vault with no attestation at all — there is no legacy tolerance', () => {
    const candidate = {
      payload: { v: 1, type: 'vault', mnemonic: 'legacy', guardianPk: 'a'.repeat(64), createdAt: 9 },
      createdAt: 9,
    }
    expect(pickNewestVault([candidate], rootPk, () => true, () => 'a'.repeat(64))).toBeNull()
  })

  // The frozen golden vector for exactly this attack (`vault-foreign-
  // attestation` in wire-v1.json) — asserted HERE rather than in the parser
  // suite, because the parser accepts it on purpose: it is well-formed on
  // the wire, and only the layer that knows which Signet identity is being
  // recovered into can tell that it does not belong.
  it('refuses the frozen vault-foreign-attestation golden vector', () => {
    const vectors = vectorsRaw as unknown as { vectors: { name: string; malformed: unknown }[] }
    const planted = vectors.vectors.find((v) => v.name === 'vault-foreign-attestation')
    expect(planted).toBeDefined()
    const guardianPk = (planted!.malformed as { guardianPk: string }).guardianPk
    expect(pickNewestVault([{ payload: planted!.malformed, createdAt: 1756900000 }], rootPk, () => true, () => guardianPk)).toBeNull()
  })
})

// --- the bounded relay hunt (spec §1.6, recovery step 2-3) --------------------

// An attestation is a generic Signet login, so a phishing site can
// obtain one over an attacker's guardian key (writing our origin tag itself).
// Two families among the AUTHENTIC vaults is refused, never resolved by
// recency.
describe('pickFamilyVault', () => {
  const pkOf = (m: string) => (m.startsWith('genuine') ? 'a'.repeat(64) : 'b'.repeat(64))

  it('refuses when authentic vaults name two guardian keys, listing both newest first', () => {
    const got = pickFamilyVault([p('genuine', 'a'.repeat(64), 1), p('phished', 'b'.repeat(64), 9)], rootPk, () => true, pkOf)
    expect(got).toEqual({
      kind: 'conflicting-vaults',
      families: [
        { guardianPk: 'b'.repeat(64), newestAt: 9 },
        { guardianPk: 'a'.repeat(64), newestAt: 1 },
      ],
    })
  })

  it('several vaults for ONE guardian key are re-publishes: the newest wins', () => {
    const got = pickFamilyVault([p('genuine-1', 'a'.repeat(64), 1), p('genuine-2', 'a'.repeat(64), 5)], rootPk, () => true, pkOf)
    expect(got.kind === 'vault' && got.vault.mnemonic).toBe('genuine-2')
  })

  it('a vault attested by a foreign Signet key is not a conflict', () => {
    const got = pickFamilyVault([p('genuine', 'a'.repeat(64), 1), p('planted', 'b'.repeat(64), 9, attackerSk)], rootPk, () => true, pkOf)
    expect(got.kind === 'vault' && got.vault.mnemonic).toBe('genuine')
  })

  it('nothing authentic is none', () => {
    expect(pickFamilyVault([], rootPk, () => true, pkOf)).toEqual({ kind: 'none' })
  })
})

describe('collectVaultCandidates', () => {
  const guardianSk = generateSecretKey()
  const signetSk = generateSecretKey()
  const signetPk = getPublicKey(signetSk)

  function vaultWrap(mnemonic: string, at: number): NostrEvent {
    return wrapFor({
      innerKind: KIND_VAULT,
      payload: buildVaultPayload({
        mnemonic,
        guardianPk: getPublicKey(guardianSk),
        authEvent: attest(rootSk, getPublicKey(guardianSk), at),
        children: [],
        relays: [],
        createdAt: at,
      }),
      authorSk: guardianSk,
      recipientPk: signetPk,
      nowSec: at,
    })
  }


  it('stops at the wrap bound without waiting for the timeout', async () => {
    const relay = makeFakeRelay()
    await relay.publish(vaultWrap('one', 10))
    await relay.publish(vaultWrap('two', 20))
    await relay.publish(vaultWrap('three', 30))

    const seen: NostrEvent[] = []
    const got = await collectVaultCandidates({
      relay,
      signetPk,
      maxWraps: 2,
      timeoutMs: 60_000,
      unwrap: async (w) => {
        seen.push(w)
        return { innerKind: KIND_VAULT, payload: { mnemonic: 'x' }, innerCreatedAt: w.created_at }
      },
    })
    expect(seen).toHaveLength(2)
    expect(got.candidates).toHaveLength(2)
    // A third wrap was on offer and never opened.
    expect(got.truncated).toBe(true)
  })

  it('gives up after the timeout with whatever it has', async () => {
    const relay = makeFakeRelay()
    const got = await collectVaultCandidates({ relay, signetPk, maxWraps: 200, timeoutMs: 5, unwrap: async () => null })
    expect(got).toEqual({ candidates: [], truncated: false })
  })

  // Dated by the INNER event's created_at, never the wrap's: `wrapFor`
  // deliberately jitters the wrap timestamp by up to two days.
  it('keeps only KIND_VAULT wraps it could actually open, dated by the inner event', async () => {
    const relay = makeFakeRelay()
    await relay.publish(vaultWrap('good', 42))
    await relay.publish(vaultWrap('unopenable', 43))
    let call = 0
    const got = await collectVaultCandidates({
      relay,
      signetPk,
      maxWraps: 200,
      timeoutMs: 30,
      unwrap: async () => {
        call += 1
        return call === 1 ? { innerKind: KIND_VAULT, payload: { mnemonic: 'good' }, innerCreatedAt: 42 } : null
      },
    })
    expect(got.candidates).toEqual([{ payload: { mnemonic: 'good' }, createdAt: 42 }])
    expect(got.truncated).toBe(false)
  })

  it('unsubscribes when it is done', async () => {
    const relay = makeFakeRelay()
    let live = 0
    const wrapped = {
      ...relay,
      subscribe: (f: Parameters<typeof relay.subscribe>[0], cb: Parameters<typeof relay.subscribe>[1]) => {
        live += 1
        const off = relay.subscribe(f, cb)
        return () => {
          live -= 1
          off()
        }
      },
    }
    await collectVaultCandidates({ relay: wrapped, signetPk, maxWraps: 200, timeoutMs: 5, unwrap: async () => null })
    expect(live).toBe(0)
  })

  it('ignores an inner kind that is not a vault', async () => {
    const relay = makeFakeRelay()
    await relay.publish(vaultWrap('good', 42))
    const got = await collectVaultCandidates({
      relay,
      signetPk,
      maxWraps: 200,
      timeoutMs: 30,
      unwrap: async (w) => ({ innerKind: 31120, payload: { mnemonic: 'no' }, innerCreatedAt: w.created_at }),
    })
    expect(got.candidates).toEqual([])
  })

  // The bound used to resolve when the LAST wrap's unwrap settled,
  // discarding an earlier, slower one still in flight — possibly the vault.
  it('waits for every in-flight unwrap once the bound is reached', async () => {
    const relay = makeFakeRelay()
    await relay.publish(vaultWrap('slow-genuine', 10))
    await relay.publish(vaultWrap('fast-junk', 20))
    let call = 0
    const got = await collectVaultCandidates({
      relay,
      signetPk,
      maxWraps: 2,
      timeoutMs: 5_000,
      unwrap: async () => {
        call += 1
        if (call === 1) {
          await new Promise((r) => setTimeout(r, 30))
          return { innerKind: KIND_VAULT, payload: { mnemonic: 'slow-genuine' }, innerCreatedAt: 10 }
        }
        return null
      },
    })
    expect(got.candidates).toEqual([{ payload: { mnemonic: 'slow-genuine' }, createdAt: 10 }])
    expect(got.truncated).toBe(false)
  })

  it('never has more than `concurrency` unwraps in flight', async () => {
    const relay = makeFakeRelay()
    for (let i = 0; i < 10; i++) await relay.publish(vaultWrap(`w${i}`, i + 1))
    let live = 0
    let peak = 0
    const got = await collectVaultCandidates({
      relay,
      signetPk,
      maxWraps: 10,
      timeoutMs: 5_000,
      concurrency: 3,
      unwrap: async () => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 2))
        live -= 1
        return null
      },
    })
    expect(peak).toBe(3)
    expect(got).toEqual({ candidates: [], truncated: false })
  })

  it('reports truncation when the deadline leaves wraps unopened (a flooded inbox)', async () => {
    const relay = makeFakeRelay()
    for (let i = 0; i < 5; i++) await relay.publish(vaultWrap(`junk${i}`, i + 1))
    const got = await collectVaultCandidates({
      relay,
      signetPk,
      maxWraps: 1_000,
      timeoutMs: 20,
      concurrency: 1,
      unwrap: () => new Promise(() => {}), // a signer that never answers
    })
    expect(got).toEqual({ candidates: [], truncated: true })
  })
})

describe('vaultPayloadFor', () => {
  const roster = [{ pubkey: 'd'.repeat(64), name: 'Alex', index: 0 }]
  const auth = attest(rootSk, 'a'.repeat(64), 1756800000)

  it('carries the family roster and relays at publish time', () => {
    const payload = vaultPayloadFor(
      { children: roster, relays: ['wss://relay.example', 'nonsense'], revoked: undefined },
      'abandon about',
      'a'.repeat(64),
      auth,
      1756800000,
    )
    expect(payload).toEqual({
      v: 1,
      type: 'vault',
      mnemonic: 'abandon about',
      guardianPk: 'a'.repeat(64),
      authEvent: auth,
      children: roster,
      relays: ['wss://relay.example'],
      createdAt: 1756800000,
    })
  })

  // Item C1: what the guardian seals must be what a recovery can verify, so
  // the round trip is asserted end to end rather than trusted.
  it('produces a vault its own recovery gate accepts', () => {
    const payload = vaultPayloadFor({ children: [], relays: [], revoked: undefined }, 'abandon about', 'a'.repeat(64), auth, 1756800000)
    const got = pickNewestVault([{ payload, createdAt: payload.createdAt }], rootPk, () => true, () => 'a'.repeat(64))
    expect(got).toEqual(payload)
  })

  it('is a pure function of its arguments — same in, same out', () => {
    const a = vaultPayloadFor({ children: [], relays: [], revoked: undefined }, 'm', 'a'.repeat(64), auth, 1)
    const b = vaultPayloadFor({ children: [], relays: [], revoked: undefined }, 'm', 'a'.repeat(64), auth, 1)
    expect(a).toEqual(b)
  })

  // Fix round 1 ruling: a recovered guardian rebuilds its roster from the
  // vault, so a revoked child left in it would be silently re-admitted —
  // resubscribed to, and sent every family config doc again.
  it('omits a revoked child, so recovery never re-admits one', () => {
    const bo = { pubkey: 'e'.repeat(64), name: 'Bo', index: 1 }
    const payload = vaultPayloadFor(
      { children: [...roster, bo], relays: ['wss://relay.example'], revoked: { [bo.pubkey]: 500 } },
      'm',
      'a'.repeat(64),
      auth,
      1,
    )
    expect(payload.children).toEqual(roster)
  })

  it('keeps every child when nothing is revoked', () => {
    const payload = vaultPayloadFor({ children: roster, relays: [], revoked: {} }, 'm', 'a'.repeat(64), auth, 1)
    expect(payload.children).toEqual(roster)
  })
})

// The roster signature is what tells the guardian shell that a vault is now
// out of date — a child added or revoked, a relay edited.
describe('vaultRosterSignature', () => {
  it('changes when the roster or the relay list changes, and not otherwise', async () => {
    const { vaultRosterSignature } = await import('./signetVault')
    const base = { children: [{ pubkey: 'd'.repeat(64), name: 'Alex', index: 0 }], relays: ['wss://a'], revoked: undefined }
    expect(vaultRosterSignature(base)).toBe(vaultRosterSignature({ ...base }))
    expect(vaultRosterSignature({ ...base, relays: ['wss://b'] })).not.toBe(vaultRosterSignature(base))
    expect(vaultRosterSignature({ ...base, children: [] })).not.toBe(vaultRosterSignature(base))
    expect(
      vaultRosterSignature({ ...base, children: [{ pubkey: 'd'.repeat(64), name: 'Alexa', index: 0 }] }),
    ).not.toBe(vaultRosterSignature(base))
  })

  // A revoke (v0.2 spec §4.5) changes the ACCOUNTS doc, never `children` —
  // without `revoked` in the signature the vault would never be re-published
  // for one, and it must be: the vault carries the roster.
  it('changes when a child is revoked', async () => {
    const { vaultRosterSignature } = await import('./signetVault')
    const base = { children: [{ pubkey: 'd'.repeat(64), name: 'Alex', index: 0 }], relays: ['wss://a'], revoked: undefined }
    expect(vaultRosterSignature({ ...base, revoked: {} })).toBe(vaultRosterSignature(base))
    expect(vaultRosterSignature({ ...base, revoked: { ['d'.repeat(64)]: 500 } })).not.toBe(vaultRosterSignature(base))
  })

  it('does not change when only the revocation TIMESTAMP differs', async () => {
    const { vaultRosterSignature } = await import('./signetVault')
    const base = { children: [{ pubkey: 'd'.repeat(64), name: 'Alex', index: 0 }], relays: ['wss://a'], revoked: undefined }
    expect(vaultRosterSignature({ ...base, revoked: { ['d'.repeat(64)]: 500 } })).toBe(
      vaultRosterSignature({ ...base, revoked: { ['d'.repeat(64)]: 900 } }),
    )
  })
})

// The guardian shell re-publishes the vault when the roster changes. The
// decision is pulled out of the effect so the cases that actually bite — a
// second change landing while the first publish is still in flight, a publish
// that failed and must be retried — are testable without React.
describe('shouldPublishVault', () => {
  it('publishes a signature that has neither been published nor started', () => {
    expect(shouldPublishVault('sig-1', null, null)).toBe(true)
    expect(shouldPublishVault('sig-2', 'sig-1', null)).toBe(true)
  })

  it('does not re-publish the signature already published', () => {
    expect(shouldPublishVault('sig-1', 'sig-1', null)).toBe(false)
  })

  it('does not start a second publish of a signature already in flight', () => {
    expect(shouldPublishVault('sig-1', null, 'sig-1')).toBe(false)
  })

  it('publishes a NEW signature even while an older one is still in flight', () => {
    expect(shouldPublishVault('sig-2', null, 'sig-1')).toBe(true)
  })

  it('retries a signature whose publish failed — nothing was stamped, so it is due again', () => {
    // The failed attempt cleared its in-flight slot and never stamped
    // `lastPublished`, which is exactly what makes the retry possible.
    expect(shouldPublishVault('sig-2', 'sig-1', null)).toBe(true)
  })
})

// Fix round 1: the one place AppState's shape is mapped onto a VaultRoster.
describe('vaultRosterOf', () => {
  it('lifts revoked off the accounts doc, where every hand-rolled roster missed it', async () => {
    const { vaultRosterOf } = await import('./signetVault')
    const { emptyState } = await import('../state/state')
    const base = emptyState()
    const app = {
      ...base,
      children: [{ pubkey: 'd'.repeat(64), name: 'Alex', index: 0 }],
      relays: ['wss://a'],
      docs: { ...base.docs, accounts: { ...base.docs.accounts, revoked: { ['d'.repeat(64)]: 500 } } },
    }
    expect(vaultRosterOf(app)).toMatchObject({
      children: app.children,
      relays: ['wss://a'],
      revoked: { ['d'.repeat(64)]: 500 },
    })
    expect(vaultRosterOf(app).checkpointSignature).toMatch(/^[0-9a-f]{64}$/)
    expect(vaultRosterOf(app).checkpointSignature).not.toBe(vaultRosterOf(base).checkpointSignature)
    expect(vaultRosterOf(base).revoked).toBeUndefined()
  })
})

describe('vaultPublishDue (v0.3 vault freshness)', () => {
  const NOW = 2_000_000_000
  const base = { signature: 'sig-b', lastPublished: 'sig-b', inFlight: null, backedUpAt: NOW - 60, nowSec: NOW }

  it('is due when the roster or relays changed since the last publish that landed', () => {
    expect(vaultPublishDue({ ...base, lastPublished: 'sig-a' })).toBe('changed')
  })

  it('publishes once when this device never recorded a publish', () => {
    expect(vaultPublishDue({ ...base, lastPublished: null })).toBe('changed')
  })

  it('is due weekly even with nothing changed, since relays may expire the wrap', () => {
    expect(vaultPublishDue({ ...base, backedUpAt: NOW - VAULT_REPUBLISH_AFTER_SECS + 1 })).toBe('none')
    expect(vaultPublishDue({ ...base, backedUpAt: NOW - VAULT_REPUBLISH_AFTER_SECS })).toBe('stale')
    expect(vaultPublishDue({ ...base, backedUpAt: null })).toBe('stale')
  })

  it('never starts a twin of a publish already under way', () => {
    expect(vaultPublishDue({ ...base, lastPublished: 'sig-a', inFlight: 'sig-b' })).toBe('none')
    expect(vaultPublishDue({ ...base, backedUpAt: null, inFlight: 'sig-b' })).toBe('none')
  })
})
