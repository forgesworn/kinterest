import { finalizeEvent, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import type { AppState } from '../state/types'
import { singleton, verifyChildConsent, wireEvent, type ChildConsent } from './familyAuthority'

export interface ChildIdentity {
  identityPk: string; selectionProof: NostrEvent; avatar?: ChildConsent['avatar'];
}
export interface ChildDevice {
  child: string; identityPk: string; devicePk: string; role: ChildConsent['role'];
  consent: NostrEvent; grant: NostrEvent;
}
export function deviceGrant(child: string, consent: NostrEvent, guardianSk: Uint8Array, rootPk: string, revision: number, nowSec: number): ChildDevice {
  const familyPk = getPublicKey(guardianSk)
  const c = verifyChildConsent(consent, rootPk, familyPk)
  if (!c || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid device consent')
  const grant = finalizeEvent({ kind: 30078, created_at: nowSec, content: 'Admit this authorised Kinterest child device to this family.',
    tags: [['d', `kin-jar/device-grant/v2/${familyPk}/${c.devicePk}`], ['family', familyPk], ['child', child], ['identity', c.identityPk], ['device', c.devicePk], ['role', c.role], ['consent', consent.id], ['revision', String(revision)]],
  }, guardianSk)
  return { child, identityPk: c.identityPk, devicePk: c.devicePk, role: c.role, consent, grant }
}
export function validDevice(d: ChildDevice, familyPk: string, rootPk: string): boolean {
  try {
    const c = verifyChildConsent(d.consent, rootPk, familyPk)
    const g = wireEvent(d.grant)
    const revision = g && singleton(g, 'revision')
    return isChildDevice(d) && !!c && !!g && Number.isSafeInteger(g.created_at) && g.created_at >= 0 && c.identityPk === d.identityPk && c.devicePk === d.devicePk && c.role === d.role && g.kind === 30078 && g.pubkey === familyPk && g.tags.length === 8 &&
      g.content === 'Admit this authorised Kinterest child device to this family.' &&
      singleton(g, 'd') === `kin-jar/device-grant/v2/${familyPk}/${d.devicePk}` && singleton(g, 'family') === familyPk && singleton(g, 'child') === d.child &&
      singleton(g, 'identity') === d.identityPk && singleton(g, 'device') === d.devicePk && singleton(g, 'role') === d.role && singleton(g, 'consent') === d.consent.id &&
      revision !== null && /^[1-9][0-9]*$/.test(revision) && Number.isSafeInteger(Number(revision))
  } catch { return false }
}
/** Returns ledger identity only for a currently authorised operational key.
 * A legacy ledger identifier is an immutable alias, never new signing authority.
 */
export function childForDevice(app: AppState, devicePk: string): string | null {
  if (app.docs.accounts.revoked?.[devicePk] !== undefined) return null
  const matches = (app.docs.accounts.devices ?? []).filter(d => d.devicePk === devicePk)
  if (matches.length === 1 && app.guardianPubkey && app.root?.kind === 'signet') {
    const d = matches[0]!
    const child = app.children.find(c => c.pubkey === d.child && c.archived === undefined)
    if (child && child.signet?.identityPk === d.identityPk && validDevice(d, app.guardianPubkey, app.root.pubkey)) return d.child
    return null
  }
  if (matches.length !== 0) return null
  const legacy = app.children.find(c => c.pubkey === devicePk && !c.signet && c.archived === undefined)
  return legacy ? legacy.pubkey : null
}
export function devicesForChild(app: AppState, child: string, includeRevoked = false): string[] {
  const profile = app.children.find(c => c.pubkey === child)
  if (!profile || (!includeRevoked && profile.archived !== undefined)) return []
  if (!profile.signet) return includeRevoked || app.docs.accounts.revoked?.[child] === undefined ? [child] : []
  return (app.docs.accounts.devices ?? []).filter(d => d.child === child && (includeRevoked || childForDevice(app, d.devicePk) === child)).map(d => d.devicePk)
}
export function activeDevicePks(app: AppState): string[] {
  return app.children.flatMap(c => devicesForChild(app, c.pubkey))
}
export function mergeDevices(existing: readonly ChildDevice[], incoming: readonly ChildDevice[]): ChildDevice[] {
  const byPk = new Map(existing.map(d => [d.devicePk, d]))
  for (const d of incoming) if (!byPk.has(d.devicePk)) byPk.set(d.devicePk, d)
  return [...byPk.values()]
}

export function isChildDevice(input: unknown): input is ChildDevice {
  try {
    const d = input as ChildDevice
    return /^[0-9a-f]{64}$/.test(d.child) && /^[0-9a-f]{64}$/.test(d.identityPk) && /^[0-9a-f]{64}$/.test(d.devicePk) &&
      ['shared-phone', 'child-phone'].includes(d.role) && wireEvent(d.consent) !== null && wireEvent(d.grant) !== null
  } catch { return false }
}

/** Restartable legacy mapping: preserve every ledger identifier and amount. */
export function admitSignetChild(app: AppState, proof: NostrEvent, guardianSk: Uint8Array, nowSec: number, legacyChild?: string): AppState {
  if (app.root?.kind !== 'signet' || !app.guardianPubkey || getPublicKey(guardianSk) !== app.guardianPubkey) throw new Error('Parent identity is unavailable')
  const c = verifyChildConsent(proof, app.root.pubkey, app.guardianPubkey)
  if (!c || c.role !== 'shared-phone') throw new Error('The child authorisation did not verify')
  const legacy = legacyChild === undefined ? undefined : app.children.find(row => row.pubkey === legacyChild && row.archived === undefined)
  if (legacyChild !== undefined && (!legacy || (legacy.signet && legacy.signet.identityPk !== c.identityPk))) throw new Error('Choose the same My Signet child as this saved child')
  const existing = app.children.find(row => row.signet?.identityPk === c.identityPk)
  const child = legacy?.pubkey ?? c.identityPk
  const repeated = app.docs.accounts.devices?.find(d => d.devicePk === c.devicePk && d.child === child && d.consent.id === proof.id)
  if (repeated && childForDevice(app, c.devicePk) === child) return app
  if (existing && existing.pubkey !== legacyChild) throw new Error('This My Signet child is already in the family')
  if (app.docs.accounts.revoked?.[c.devicePk] !== undefined || (app.docs.accounts.devices ?? []).some(d => d.devicePk === c.devicePk)) throw new Error('This device key has already been used')
  const revision = (app.docs.accounts.deviceRevision ?? 0) + 1
  const d = deviceGrant(child, proof, guardianSk, app.root.pubkey, revision, nowSec)
  const profile = { pubkey: child, name: c.name, index: legacy?.index ?? Math.max(-1, ...app.children.map(row => row.index)) + 1,
    ...(legacy ?? {}), signet: { identityPk: c.identityPk, selectionProof: proof, ...(c.avatar ? { avatar: c.avatar } : {}) } }
  profile.name = c.name
  const issuedAt = Math.max(nowSec, (app.docHighWater.accounts ?? 0) + 1)
  return { ...app, children: legacy ? app.children.map(row => row.pubkey === child ? profile : row) : [...app.children, profile],
    docs: { ...app.docs, accounts: { ...app.docs.accounts, issuedAt, devices: [...(app.docs.accounts.devices ?? []), d], deviceRevision: revision,
      revoked: { ...app.docs.accounts.revoked, ...(legacy && !legacy.signet ? { [legacy.pubkey]: nowSec } : {}), ...Object.fromEntries((app.docs.accounts.devices ?? []).filter(old => old.child === child && old.role === 'shared-phone').map(old => [old.devicePk, nowSec])) },
    } }, docHighWater: { ...app.docHighWater, accounts: issuedAt },
  }
}

/** Admit a freshly confirmed phone and retire every older phone credential.
 * Shared-phone credentials are independent and remain available. */
export function replaceChildPhone(app: AppState, child: string, proof: NostrEvent, guardianSk: Uint8Array, nowSec: number): AppState {
  if (app.root?.kind !== 'signet' || getPublicKey(guardianSk) !== app.guardianPubkey) throw new Error('Parent identity is unavailable')
  const profile = app.children.find(c => c.pubkey === child && c.archived === undefined)
  const consent = verifyChildConsent(proof, app.root.pubkey, app.guardianPubkey!)
  if (!profile?.signet || !consent || consent.role !== 'child-phone' || consent.identityPk !== profile.signet.identityPk) throw new Error('This phone was not authorised for the selected child')
  if (app.docs.accounts.revoked?.[consent.devicePk] !== undefined || (app.docs.accounts.devices ?? []).some(d => d.devicePk === consent.devicePk)) throw new Error('This device key has already been used')
  const revision = (app.docs.accounts.deviceRevision ?? 0) + 1
  const admission = deviceGrant(child, proof, guardianSk, app.root.pubkey, revision, nowSec)
  const oldPhones = (app.docs.accounts.devices ?? []).filter(d => d.child === child && d.role === 'child-phone').map(d => d.devicePk)
  const issuedAt = Math.max(nowSec, (app.docHighWater.accounts ?? 0) + 1)
  return { ...app, children: app.children.map(c => c.pubkey === child ? { ...c, pairedAt: nowSec } : c),
    docs: { ...app.docs, accounts: { ...app.docs.accounts, issuedAt, devices: [...(app.docs.accounts.devices ?? []), admission], deviceRevision: revision,
      revoked: { ...app.docs.accounts.revoked, ...Object.fromEntries(oldPhones.map(pk => [pk, nowSec])) },
    } }, docHighWater: { ...app.docHighWater, accounts: issuedAt } }
}

/** Historical provenance for a signed activity replayed by an authorised peer.
 * This is never a permission to accept live traffic from a retired key. */
export function historicalChildForDevice(app: AppState, devicePk: string, createdAtSec: number): string | null {
  if (!Number.isSafeInteger(createdAtSec) || createdAtSec < 0) return null
  const revoked = app.docs.accounts.revoked?.[devicePk]
  if (revoked !== undefined && createdAtSec >= revoked) return null
  const matches = (app.docs.accounts.devices ?? []).filter(d => d.devicePk === devicePk)
  if (matches.length === 1 && app.root?.kind === 'signet' && app.guardianPubkey) {
    const d = matches[0]!
    if (createdAtSec < d.grant.created_at || !validDevice(d, app.guardianPubkey, app.root.pubkey)) return null
    const child = app.children.find(c => c.pubkey === d.child && c.signet?.identityPk === d.identityPk)
    return child?.pubkey ?? null
  }
  if (matches.length !== 0) return null
  // The guardian's saved immutable alias binds an old derived device.
  return app.children.find(c => c.pubkey === devicePk)?.pubkey ?? null
}
