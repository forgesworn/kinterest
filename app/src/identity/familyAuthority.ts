import { verifyEvent, type EventTemplate, type NostrEvent } from 'nostr-tools/pure'

export const AUTHORITY_KIND = 30078
export const AUTHORITY_SCOPE = 'kin-jar:family:v2'
export const ROOT_PURPOSE = 'Authorise this family key to manage Kinterest and its encrypted family backup.'
export const PARENT_PURPOSE = 'Confirm parent presence to set or reset this device’s separate Kinterest parent PIN.'
export const CHILD_PURPOSE = 'Choose this My Signet dependant for Kinterest and authorise this device for child actions.'
const HEX64 = /^[0-9a-f]{64}$/
export interface ChildConsent {
  v: 2; familyPk: string; identityPk: string; name: string; avatar?: { url: string; hash: string; key: string };
  devicePk: string; role: 'shared-phone' | 'child-phone'; statement: NostrEvent;
}
export function wireEvent(input: unknown): NostrEvent | null {
  try {
    const e = input as NostrEvent
    const wire = { id: e.id, pubkey: e.pubkey, kind: e.kind, created_at: e.created_at, tags: e.tags, content: e.content, sig: e.sig }
    return verifyEvent(wire) ? wire : null
  } catch { return null }
}
export function singleton(e: Pick<NostrEvent, 'tags'>, key: string): string | null {
  const rows = e.tags.filter(t => Array.isArray(t) && t[0] === key)
  return rows.length === 1 && rows[0]?.length === 2 && typeof rows[0][1] === 'string' ? rows[0][1] : null
}
export function authorityRequest(familyPk: string, challenge: string, nowSec: number, child?: { identityPk: string; devicePk: string; role: ChildConsent['role'] }): EventTemplate {
  return { kind: AUTHORITY_KIND, created_at: nowSec,
    content: child ? CHILD_PURPOSE : ROOT_PURPOSE,
    tags: [['d', `kin-jar/${child ? 'child-selection' : 'family-authorisation'}/v2/${familyPk}`], ['scope', AUTHORITY_SCOPE],
      ['family', familyPk], ['challenge', challenge], ['approval', 'request'],
      ...(child ? [['child', child.identityPk], ['device', child.devicePk], ['role', child.role]] : [])],
  }
}
function checked(input: unknown, rootPk: string, familyPk: string, purpose: 'family-authorisation' | 'child-selection' | 'parent-presence', challenge?: string): NostrEvent | null {
  const e = wireEvent(input)
  if (!e || e.kind !== AUTHORITY_KIND || e.pubkey !== rootPk || !HEX64.test(familyPk) ||
      singleton(e, 'd') !== `kin-jar/${purpose}/v2/${familyPk}` || singleton(e, 'family') !== familyPk ||
      singleton(e, 'scope') !== AUTHORITY_SCOPE || singleton(e, 'approval') !== 'confirmed' ||
      !HEX64.test(singleton(e, 'challenge') ?? '') || (challenge !== undefined && singleton(e, 'challenge') !== challenge) ||
      !Number.isSafeInteger(e.created_at) || e.created_at < 0) return null
  return e
}
export function verifyFamilyAuthority(input: unknown, rootPk: string, familyPk: string, challenge?: string): boolean {
  const e = checked(input, rootPk, familyPk, 'family-authorisation', challenge)
  return e !== null && e.content === ROOT_PURPOSE && e.tags.length === 5
}
export function parentPresenceRequest(familyPk: string, challenge: string, nowSec: number): EventTemplate {
  const t = authorityRequest(familyPk,challenge,nowSec)
  return { ...t,content:PARENT_PURPOSE,tags:t.tags.map(row => row[0] === 'd' ? ['d',`kin-jar/parent-presence/v2/${familyPk}`] : row) }
}
export function verifyParentPresence(input: unknown, rootPk: string, familyPk: string, challenge: string): boolean {
  const e = checked(input,rootPk,familyPk,'parent-presence',challenge)
  return e !== null && e.tags.length === 5 && e.content === PARENT_PURPOSE
}
export function deviceStatementTemplate(familyPk: string, identityPk: string, devicePk: string, role: ChildConsent['role'], nowSec: number): EventTemplate {
  return { kind: AUTHORITY_KIND, created_at: nowSec, content: 'Authorise this device for Kinterest child actions only.',
    tags: [['d', `kin-jar/device/v2/${familyPk}/${devicePk}`], ['scope', 'kin-jar:child-actions:v2'], ['family', familyPk], ['child', identityPk], ['device', devicePk], ['role', role]],
  }
}
export function verifyDeviceStatement(input: unknown, familyPk: string, identityPk: string, devicePk: string, role: ChildConsent['role']): boolean {
  const e = wireEvent(input)
  return !!e && Number.isSafeInteger(e.created_at) && e.created_at >= 0 && e.pubkey === identityPk && e.kind === AUTHORITY_KIND && e.tags.length === 6 &&
    e.content === 'Authorise this device for Kinterest child actions only.' &&
    singleton(e, 'd') === `kin-jar/device/v2/${familyPk}/${devicePk}` && singleton(e, 'scope') === 'kin-jar:child-actions:v2' &&
    singleton(e, 'family') === familyPk && singleton(e, 'child') === identityPk && singleton(e, 'device') === devicePk && singleton(e, 'role') === role
}
export function verifyChildConsent(input: unknown, rootPk: string, familyPk: string, expected?: { challenge: string; identityPk: string; devicePk: string; role: ChildConsent['role'] }): ChildConsent | null {
  const e = checked(input, rootPk, familyPk, 'child-selection', expected?.challenge)
  if (!e || e.tags.length !== 8) return null
  try {
    const c = JSON.parse(e.content) as ChildConsent
    if (c.v !== 2 || c.familyPk !== familyPk || !HEX64.test(c.identityPk) || !HEX64.test(c.devicePk) || c.devicePk === c.identityPk || c.devicePk === familyPk ||
        !['shared-phone','child-phone'].includes(c.role) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80 ||
        /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(c.name) ||
        (c.avatar !== undefined && (typeof c.avatar !== 'object' || c.avatar === null || typeof c.avatar.url !== 'string' || c.avatar.url.length > 2048 || !c.avatar.url.startsWith('https://') || !HEX64.test(c.avatar.hash) || !HEX64.test(c.avatar.key))) ||
        singleton(e, 'child') !== c.identityPk || singleton(e, 'device') !== c.devicePk || singleton(e, 'role') !== c.role ||
        (expected && (expected.identityPk !== c.identityPk || expected.devicePk !== c.devicePk || expected.role !== c.role)) ||
        !verifyDeviceStatement(c.statement, familyPk, c.identityPk, c.devicePk, c.role)) return null
    return c
  } catch { return null }
}
