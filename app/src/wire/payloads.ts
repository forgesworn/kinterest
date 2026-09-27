// Wire payload shapes for every inner event kind (see ./kinds.ts) plus the
// builders that construct them and the TOTAL parsers that validate untrusted
// JSON back into them. "Total" (forgesworn kit convention): every parseX
// NEVER throws — malformed input, including a completely unrelated shape,
// always yields null, never a partial trust and never an exception. Parsers
// also ignore unknown extra fields (forward compatibility): they pick out
// only the fields they know about rather than rejecting or passing through
// anything else, so a payload from a newer build with additional fields this
// build doesn't understand still parses cleanly (an unknown `op`/`docKind`
// value itself, though, is refused — null, not a throw).

import type { NostrEvent } from 'nostr-tools/pure'
import { assertEntry } from '../domain/ledger'
import type { Account, Entry } from '../domain/types'
import type { AllowanceConfig } from '../domain/allowance'
import type { InterestConfig } from '../domain/interest'
import type { Chore, ChoreTick } from '../domain/chores'
import type { AuditResult } from '../domain/audit'
import type { ChildProfile, ConfigDocs } from '../state/types'

// --- generic structural helpers --------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0
}
function isSafeInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x)
}
function isNonNegSafeInt(x: unknown): x is number {
  return isSafeInt(x) && x >= 0
}
function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === 'string')
}

const HEX64 = /^[0-9a-f]{64}$/

// Relay URLs are always ws:// or wss:// — anything else (a bare hostname, an
// http(s):// URL, a non-string) is refused rather than trusted through to
// wherever a relay list eventually gets handed to nostr-tools' SimplePool.
const RELAY_URL_RE = /^wss?:\/\//
function isRelayUrlArray(x: unknown): x is string[] {
  return isStringArray(x) && x.every((s) => RELAY_URL_RE.test(s))
}

// --- EntryPayload ------------------------------------------------------------

export interface EntryPayload {
  v: 1
  entry: Entry
}

export function buildEntryPayload(entry: Entry): EntryPayload {
  return { v: 1, entry }
}

/** Validates the entry via assertEntry (domain/ledger.ts) — the ledger's sole
 *  shape authority — catching its throw into a null rather than propagating. */
export function parseEntryPayload(json: unknown): EntryPayload | null {
  if (!isPlainObject(json) || json.v !== 1) return null
  try {
    assertEntry(json.entry as Entry)
  } catch {
    return null
  }
  return { v: 1, entry: json.entry as Entry }
}

// --- ConfigPayload -----------------------------------------------------------

export type ConfigDocKind = 'accounts' | 'allowance' | 'interest' | 'chores'
const CONFIG_DOC_KINDS: readonly ConfigDocKind[] = ['accounts', 'allowance', 'interest', 'chores']

export interface ConfigPayload {
  v: 1
  docKind: ConfigDocKind
  doc: unknown
}

export function buildConfigPayload(docKind: ConfigDocKind, doc: unknown): ConfigPayload {
  return { v: 1, docKind, doc }
}

function isAccountShape(x: unknown): x is Account {
  return (
    isPlainObject(x) &&
    isNonEmptyString(x.id) &&
    isNonEmptyString(x.child) &&
    isNonEmptyString(x.name) &&
    isNonEmptyString(x.currency) &&
    (x.custody === 'ledger' || x.custody === 'physical' || x.custody === 'external') &&
    (x.archived === undefined || typeof x.archived === 'boolean') &&
    // Additive field (domain/types.ts's own doc comment on Account.auditCadence
    // — Plan 3 Task 6): an ABSENT field parses exactly as before (an older
    // snapshot/device that predates it), but a PRESENT one must be checked
    // to the same closed-set convention every other typed field on this
    // shape already follows (`custody` just above) — found by review: this
    // previously accepted ANY value at all here (a stray string, a number,
    // an object), which would have let a malformed/hostile wire doc smuggle
    // a bad `auditCadence` straight through this "total" parser undetected.
    (x.auditCadence === undefined || x.auditCadence === 'weekly' || x.auditCadence === 'monthly')
  )
}

function isAllowanceConfigShape(x: unknown): x is AllowanceConfig {
  return (
    isPlainObject(x) &&
    isNonEmptyString(x.child) &&
    isNonEmptyString(x.account) &&
    isSafeInt(x.amountMinor) &&
    (x.cadence === 'weekly' || x.cadence === 'monthly') &&
    isSafeInt(x.day) &&
    isNonEmptyString(x.tz) &&
    isNonEmptyString(x.startDay) &&
    (x.paused === undefined || typeof x.paused === 'boolean') &&
    (x.choresGate === undefined || typeof x.choresGate === 'boolean') &&
    (x.auditGate === undefined || typeof x.auditGate === 'boolean')
  )
}

function isInterestConfigShape(x: unknown): x is InterestConfig {
  return (
    isPlainObject(x) &&
    isNonEmptyString(x.child) &&
    isNonEmptyString(x.account) &&
    isSafeInt(x.rateBps) &&
    (x.cadence === 'weekly' || x.cadence === 'monthly') &&
    isSafeInt(x.day) &&
    isNonEmptyString(x.tz) &&
    isNonEmptyString(x.startDay) &&
    (x.matchBps === undefined || isSafeInt(x.matchBps)) &&
    (x.matchCapMinor === undefined || isSafeInt(x.matchCapMinor)) &&
    (x.paused === undefined || typeof x.paused === 'boolean')
  )
}

function isChoreShape(x: unknown): x is Chore {
  return (
    isPlainObject(x) &&
    isNonEmptyString(x.id) &&
    isNonEmptyString(x.child) &&
    isNonEmptyString(x.name) &&
    (x.cadence === 'daily' || x.cadence === 'weekly') &&
    (x.archived === undefined || typeof x.archived === 'boolean')
  )
}

// Shared by ConfigPayload and SnapshotPayload (a snapshot carries a full
// ConfigDocs, i.e. one of each kind).
function isConfigDocShape(docKind: ConfigDocKind, doc: unknown): boolean {
  if (!isPlainObject(doc) || doc.v !== 1 || !isNonNegSafeInt(doc.issuedAt)) return false
  if (docKind === 'accounts') return Array.isArray(doc.accounts) && doc.accounts.every(isAccountShape)
  if (docKind === 'allowance') return Array.isArray(doc.configs) && doc.configs.every(isAllowanceConfigShape)
  if (docKind === 'interest') return Array.isArray(doc.configs) && doc.configs.every(isInterestConfigShape)
  return Array.isArray(doc.chores) && doc.chores.every(isChoreShape) // docKind === 'chores'
}

function isConfigDocsShape(x: unknown): x is ConfigDocs {
  return (
    isPlainObject(x) &&
    isConfigDocShape('accounts', x.accounts) &&
    isConfigDocShape('allowance', x.allowance) &&
    isConfigDocShape('interest', x.interest) &&
    isConfigDocShape('chores', x.chores)
  )
}

/** Unknown docKind -> null (fail-closed for now, forward-compat per the plan);
 *  never throws. Per-kind structural checks, not classes. */
export function parseConfigPayload(json: unknown): ConfigPayload | null {
  if (!isPlainObject(json) || json.v !== 1) return null
  if (!CONFIG_DOC_KINDS.includes(json.docKind as ConfigDocKind)) return null
  const docKind = json.docKind as ConfigDocKind
  if (!isConfigDocShape(docKind, json.doc)) return null
  return { v: 1, docKind, doc: json.doc }
}

// --- RequestPayload ------------------------------------------------------------

export type RequestOp = 'spend.request' | 'allowance.claim' | 'pair.claim'
const REQUEST_OPS: readonly RequestOp[] = ['spend.request', 'allowance.claim', 'pair.claim']

export interface RequestPayload {
  v: 1
  op: RequestOp
  reqId: string
  nonce: string
  child: string
  ts: number
  params: Record<string, unknown>
}

export function buildRequestPayload(fields: Omit<RequestPayload, 'v'>): RequestPayload {
  return { v: 1, ...fields }
}

function isSpendRequestParams(p: unknown): boolean {
  return (
    isPlainObject(p) &&
    isSafeInt(p.amountMinor) &&
    isNonEmptyString(p.currency) &&
    isNonEmptyString(p.account) &&
    (p.note === undefined || typeof p.note === 'string') &&
    (p.link === undefined || typeof p.link === 'string')
  )
}
function isAllowanceClaimParams(p: unknown): boolean {
  return isPlainObject(p) && isNonEmptyString(p.periodKey)
}
function isPairClaimParams(p: unknown): boolean {
  return (
    isPlainObject(p) &&
    isNonEmptyString(p.token) &&
    isNonEmptyString(p.devicePk) &&
    (p.name === undefined || typeof p.name === 'string')
  )
}

/** Unknown op -> null; op-specific params structurally validated. */
export function parseRequestPayload(json: unknown): RequestPayload | null {
  if (!isPlainObject(json) || json.v !== 1) return null
  if (!isNonEmptyString(json.reqId) || !isNonEmptyString(json.nonce)) return null
  if (!isNonEmptyString(json.child)) return null
  if (!isNonNegSafeInt(json.ts)) return null
  if (!REQUEST_OPS.includes(json.op as RequestOp)) return null
  const op = json.op as RequestOp
  const params = json.params
  if (op === 'spend.request' && !isSpendRequestParams(params)) return null
  if (op === 'allowance.claim' && !isAllowanceClaimParams(params)) return null
  if (op === 'pair.claim' && !isPairClaimParams(params)) return null
  return {
    v: 1,
    op,
    reqId: json.reqId,
    nonce: json.nonce,
    child: json.child,
    ts: json.ts,
    params: params as Record<string, unknown>,
  }
}

// --- GrantPayload --------------------------------------------------------------

/** `dismissed` (v0.2 spec §4.3) is a real DECISION, not a silent drop: the
 *  guardian swiping a card away sends one, so the child's app stops showing
 *  "No reply yet" for a request that was in fact seen and set aside. It
 *  carries no ledger entry and no params. */
export type GrantDecision = 'allow' | 'deny' | 'dismissed'
const GRANT_DECISIONS: readonly GrantDecision[] = ['allow', 'deny', 'dismissed']

export interface GrantPayload {
  v: 1
  reqId: string
  nonce: string
  decision: GrantDecision
  ts: number
  params: Record<string, unknown>
}

export function buildGrantPayload(fields: Omit<GrantPayload, 'v'>): GrantPayload {
  return { v: 1, ...fields }
}

/** reqId/nonce are echoed verbatim by convention (the caller's job when
 *  building a grant from a request) — this parser just validates shape. */
export function parseGrantPayload(json: unknown): GrantPayload | null {
  if (!isPlainObject(json) || json.v !== 1) return null
  if (!isNonEmptyString(json.reqId) || !isNonEmptyString(json.nonce)) return null
  if (!GRANT_DECISIONS.includes(json.decision as GrantDecision)) return null
  if (!isNonNegSafeInt(json.ts)) return null
  if (!isPlainObject(json.params)) return null
  return {
    v: 1,
    reqId: json.reqId,
    nonce: json.nonce,
    decision: json.decision as GrantDecision,
    ts: json.ts,
    params: json.params,
  }
}

// --- AckPayload ------------------------------------------------------------------

export interface AckPayload {
  v: 1
  entryId: string
  ts: number
}

export function buildAckPayload(entryId: string, ts: number): AckPayload {
  return { v: 1, entryId, ts }
}

export function parseAckPayload(json: unknown): AckPayload | null {
  if (!isPlainObject(json) || json.v !== 1) return null
  if (!isNonEmptyString(json.entryId)) return null
  if (!isNonNegSafeInt(json.ts)) return null
  return { v: 1, entryId: json.entryId, ts: json.ts }
}

// --- RootAttestation ---------------------------------------------------------

/**
 * The family's My Signet root, as it travels on the wire (v0.2 spec §1.5): the
 * root pubkey plus the kind-21236 attestation event that binds it to the
 * guardian device key.
 *
 * The parser below is a SHAPE authority only — it never verifies the
 * signature, exactly like every other parser here (parsers are synchronous;
 * verification is async and belongs to the consumer, `identity/signetRoot.ts`
 * via `pairing.ts#acceptPairOffer`, which checks the attestation against the
 * AUTHENTICATED seal author rather than anything read out of the payload).
 */
export interface RootAttestation {
  /** 64-hex My Signet pubkey. */
  pubkey: string
  /** The kind-21236 attestation event. */
  authEvent: NostrEvent
}

/** The Signet root attestation event kind (spec §1.1). */
const KIND_SIGNET_AUTH = 21236

/**
 * Total, and deliberately NOT fail-the-payload: a malformed `root` yields
 * `undefined`, leaving the offer/snapshot it decorates to parse normally.
 * Pairing must never be blocked by an unverifiable decoration (spec §1.5) —
 * the security property comes from the consumer's signature check, so a root
 * that is merely absent and a root that was dropped here are the same,
 * safe, state: no root claimed, no root trusted.
 */
function parseRootAttestation(x: unknown): RootAttestation | undefined {
  if (!isPlainObject(x)) return undefined
  if (typeof x.pubkey !== 'string' || !HEX64.test(x.pubkey)) return undefined
  const ev = x.authEvent
  // Full event shape, `sig` included: half an event is not an event, and the
  // consumer's `verifyRootAttestation` needs every NIP-01 field present to
  // have anything to check. Then the two root-specific narrowings.
  if (!isNostrEventShape(ev)) return undefined
  if (ev.kind !== KIND_SIGNET_AUTH) return undefined
  if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey)) return undefined
  return { pubkey: x.pubkey, authEvent: ev }
}

// --- SnapshotPayload / CheckpointPayload ------------------------------------------

export interface SnapshotState {
  children: ChildProfile[]
  entries: Entry[]
  docs: ConfigDocs
}

export interface SnapshotPayload {
  v: 1
  kind: 'snapshot'
  state: SnapshotState
  /** Additive (spec §1.5) — absent on any pre-v0.2 snapshot. */
  root?: RootAttestation
  /** Additive (v0.3) — the addressed child's own decided asks, as the GRANTs
   *  the guardian sent for them, so a GRANT a relay dropped is healed by the
   *  next snapshot. Absent on an older snapshot, and ignored by an older
   *  parser. */
  grants?: GrantPayload[]
}

/** Most GRANTs one snapshot carries — the newest decisions; older ones have
 *  long since been seen or stopped mattering. */
export const MAX_SNAPSHOT_GRANTS = 200

export interface CheckpointPayload {
  v: 1
  kind: 'checkpoint'
  balances: Record<string, number>
  lastEntryId: string
  ts: number
}

function isChildProfileShape(x: unknown): x is ChildProfile {
  return isPlainObject(x) && isNonEmptyString(x.pubkey) && isNonEmptyString(x.name) && isNonNegSafeInt(x.index)
}

export function buildSnapshotPayload(state: SnapshotState, root?: RootAttestation, grants?: GrantPayload[]): SnapshotPayload {
  return {
    v: 1,
    kind: 'snapshot',
    state,
    ...(root !== undefined ? { root } : {}),
    ...(grants !== undefined && grants.length > 0 ? { grants: grants.slice(0, MAX_SNAPSHOT_GRANTS) } : {}),
  }
}

/** Total, and like `root` a decoration that never fails the snapshot: a
 *  malformed GRANT is dropped on its own, a non-array is no grants, and more
 *  than `MAX_SNAPSHOT_GRANTS` refuses the whole list (a hostile size, not a
 *  real one). */
function parseSnapshotGrants(x: unknown): GrantPayload[] | undefined {
  if (!Array.isArray(x) || x.length > MAX_SNAPSHOT_GRANTS) return undefined
  const grants = x.map(parseGrantPayload).filter((g): g is GrantPayload => g !== null)
  return grants.length > 0 ? grants : undefined
}

export function parseSnapshotPayload(json: unknown): SnapshotPayload | null {
  if (!isPlainObject(json) || json.v !== 1 || json.kind !== 'snapshot') return null
  const state = json.state
  if (!isPlainObject(state)) return null
  if (!Array.isArray(state.children) || !state.children.every(isChildProfileShape)) return null
  const entries = state.entries
  if (!Array.isArray(entries)) return null
  for (const e of entries) {
    try {
      assertEntry(e as Entry)
    } catch {
      return null
    }
  }
  if (!isConfigDocsShape(state.docs)) return null
  const root = parseRootAttestation(json.root)
  const grants = parseSnapshotGrants(json.grants)
  return {
    v: 1,
    kind: 'snapshot',
    state: {
      children: state.children as ChildProfile[],
      entries: entries as Entry[],
      docs: state.docs as ConfigDocs,
    },
    ...(root !== undefined ? { root } : {}),
    ...(grants !== undefined ? { grants } : {}),
  }
}

export function buildCheckpointPayload(fields: Omit<CheckpointPayload, 'v' | 'kind'>): CheckpointPayload {
  return { v: 1, kind: 'checkpoint', ...fields }
}

function isBalancesShape(x: unknown): x is Record<string, number> {
  return isPlainObject(x) && Object.values(x).every((v) => isSafeInt(v))
}

export function parseCheckpointPayload(json: unknown): CheckpointPayload | null {
  if (!isPlainObject(json) || json.v !== 1 || json.kind !== 'checkpoint') return null
  if (!isBalancesShape(json.balances)) return null
  if (!isNonEmptyString(json.lastEntryId)) return null
  if (!isNonNegSafeInt(json.ts)) return null
  return { v: 1, kind: 'checkpoint', balances: json.balances, lastEntryId: json.lastEntryId, ts: json.ts }
}

/** Union parser for kind 31122, which carries either a snapshot or a
 *  checkpoint — dispatches on `.kind`. Unknown/missing kind -> null. */
export function parseSnapshotOrCheckpointPayload(json: unknown): SnapshotPayload | CheckpointPayload | null {
  if (!isPlainObject(json)) return null
  if (json.kind === 'snapshot') return parseSnapshotPayload(json)
  if (json.kind === 'checkpoint') return parseCheckpointPayload(json)
  return null
}

// --- ChildSigPayload ---------------------------------------------------------------

export type ChildSigPayload = { v: 1; kind: 'tick'; tick: ChoreTick } | { v: 1; kind: 'audit'; audit: AuditResult }

export function buildChildTickPayload(tick: ChoreTick): ChildSigPayload {
  return { v: 1, kind: 'tick', tick }
}
export function buildChildAuditPayload(audit: AuditResult): ChildSigPayload {
  return { v: 1, kind: 'audit', audit }
}

function isChoreTickShape(x: unknown): x is ChoreTick {
  return (
    isPlainObject(x) &&
    isNonEmptyString(x.id) &&
    isNonEmptyString(x.chore) &&
    isNonEmptyString(x.day) &&
    isNonNegSafeInt(x.at)
  )
}
function isAuditResultShape(x: unknown): x is AuditResult {
  return (
    isPlainObject(x) &&
    isNonEmptyString(x.id) &&
    isNonEmptyString(x.account) &&
    isNonEmptyString(x.child) &&
    isSafeInt(x.countedMinor) &&
    isSafeInt(x.expectedMinor) &&
    isSafeInt(x.deltaMinor) &&
    isNonNegSafeInt(x.at) &&
    (x.author === 'guardian' || x.author === 'child')
  )
}

/** Unknown kind -> null. */
export function parseChildSigPayload(json: unknown): ChildSigPayload | null {
  if (!isPlainObject(json) || json.v !== 1) return null
  if (json.kind === 'tick') {
    if (!isChoreTickShape(json.tick)) return null
    return { v: 1, kind: 'tick', tick: json.tick }
  }
  if (json.kind === 'audit') {
    if (!isAuditResultShape(json.audit)) return null
    return { v: 1, kind: 'audit', audit: json.audit }
  }
  return null
}

// --- PairOfferPayload ---------------------------------------------------------------

export interface PairOfferPayload {
  v: 1
  childSkHex: string
  childIndex: number
  name: string
  relays: string[]
  snapshot: SnapshotPayload
  /** Additive (spec §1.5) — absent on any pre-v0.2 offer. */
  root?: RootAttestation
}

export function buildPairOfferPayload(fields: Omit<PairOfferPayload, 'v'>): PairOfferPayload {
  return { v: 1, ...fields }
}

export function parsePairOfferPayload(json: unknown): PairOfferPayload | null {
  if (!isPlainObject(json) || json.v !== 1) return null
  if (typeof json.childSkHex !== 'string' || !HEX64.test(json.childSkHex)) return null
  if (!isNonNegSafeInt(json.childIndex)) return null
  if (!isNonEmptyString(json.name)) return null
  if (!isRelayUrlArray(json.relays)) return null
  const snapshot = parseSnapshotPayload(json.snapshot)
  if (!snapshot) return null
  const root = parseRootAttestation(json.root)
  return {
    v: 1,
    childSkHex: json.childSkHex,
    childIndex: json.childIndex,
    name: json.name,
    relays: json.relays,
    snapshot,
    ...(root !== undefined ? { root } : {}),
  }
}

// --- VaultPayload (KIND_VAULT, 31125) ------------------------------------------

/**
 * The Signet-encrypted family vault: everything a guardian needs to come back
 * from a lost device, gift-wrapped to the family's My Signet root identity
 * (v0.2 spec §1.6).
 *
 * Orchestrator ruling R1: the vault carries the family ROSTER as well as the
 * mnemonic — `children` and `relays` — so a recovered guardian can reach every
 * child immediately (`resync.request`) rather than waiting for each child's
 * hourly heartbeat to find it. Both are additive: a vault written by a
 * producer that predates them simply omits them and parses to `[]`, so an old
 * backup still restores (just without the roster shortcut). The guardian
 * re-publishes the vault whenever `children` or `relays` changes, not only at
 * first backup.
 *
 * `authEvent` is REQUIRED (fix round 2, item C1). Without it a vault proves
 * nothing about who wrote it: the recovery inbox is a PUBLIC relay filter
 * (`{kinds:[1059], '#p':[signetPk]}`) that anybody may address, so an
 * attacker could gift-wrap a vault holding THEIR OWN mnemonic to a victim's
 * Signet pubkey, and — being newer than the real one, and perfectly
 * self-consistent — it would win `pickNewestVault` outright. The recovering
 * guardian would then adopt the attacker's family. The attestation is the
 * one thing an attacker cannot forge: it is signed by the very Signet key
 * the recovery is logging in as, over a challenge bound to the vault's own
 * guardian key. See spec §1.6.
 */
export interface VaultPayload {
  v: 1
  type: 'vault'
  /** BIP-39 family mnemonic. */
  mnemonic: string
  /** 64-hex guardian device pubkey this mnemonic derives. */
  guardianPk: string
  /** The kind-21236 Signet root attestation binding this family's My Signet
   *  identity to `guardianPk` — the guardian's own `AppState.root.authEvent`,
   *  carried verbatim. Shape-checked here, signature-checked at recovery by
   *  `identity/signetVault.ts#pickNewestVault` (item C1). */
  authEvent: NostrEvent
  /** The family roster at publish time (R1). Defaults to `[]` when absent. */
  children: ChildProfile[]
  /** The relays the family syncs over at publish time (R1). Defaults to `[]`. */
  relays: string[]
  /** unix SECONDS. */
  createdAt: number
}

/**
 * `relays` is filtered to the `wss://`/`ws://` shape `parseVaultPayload`
 * accepts, rather than passed through: the caller hands this straight from
 * `AppState.relays`, and a vault that fails its OWN parser at recovery time is
 * the one failure mode that costs a family everything. Dropping an unusable
 * relay URL loses a hint; keeping it would lose the mnemonic.
 */
export function buildVaultPayload(fields: Omit<VaultPayload, 'v' | 'type'>): VaultPayload {
  return { v: 1, type: 'vault', ...fields, relays: fields.relays.filter((r) => RELAY_URL_RE.test(r)) }
}

/**
 * Total. Requires `v === 1`, `type === 'vault'`, a non-empty `mnemonic`,
 * 64-hex `guardianPk` and a non-negative safe-integer `createdAt`.
 *
 * Deliberately does NOT call `validateMnemonic`: a shape failure and a
 * checksum failure must stay distinguishable, and the checksum is the
 * recovery consumer's job (spec §1.6 step 4).
 *
 * `children`/`relays` are absent-tolerant (→ `[]`) but, when PRESENT, are
 * validated to the same closed shape every other typed field in this file
 * gets — a malformed roster fails the whole payload rather than being
 * silently emptied, because a half-read roster is exactly the case where
 * "recovered, but quietly missing a child" would be worse than "could not
 * read that backup".
 *
 * `authEvent`, by contrast, is REQUIRED and NOT absent-tolerant (item C1).
 * Every other optional field here is a convenience whose absence costs a
 * hint; this one is the only evidence that the vault belongs to the family
 * whose inbox it turned up in. There is no legacy producer to accommodate —
 * no vault has ever shipped — so a vault without one is refused outright
 * rather than admitted and hopefully caught later. Its SIGNATURE is not
 * checked here: this parser has no idea which Signet identity is being
 * recovered into, and a shape check that looked like a security check would
 * be worse than none. `pickNewestVault` does the verifying.
 */
export function parseVaultPayload(json: unknown): VaultPayload | null {
  if (!isPlainObject(json) || json.v !== 1 || json.type !== 'vault') return null
  if (!isNonEmptyString(json.mnemonic)) return null
  if (typeof json.guardianPk !== 'string' || !HEX64.test(json.guardianPk)) return null
  if (!isNonNegSafeInt(json.createdAt)) return null

  // Same three narrowings `parseRootAttestation` applies, and for the same
  // reasons: a full event (half an event cannot be verified at all), the
  // right kind, and hex keys.
  const authEvent = json.authEvent
  if (!isNostrEventShape(authEvent)) return null
  if (authEvent.kind !== KIND_SIGNET_AUTH) return null
  if (!HEX64.test(authEvent.id) || !HEX64.test(authEvent.pubkey)) return null

  let children: ChildProfile[] = []
  if (json.children !== undefined) {
    if (!Array.isArray(json.children) || !json.children.every(isChildProfileShape)) return null
    children = json.children as ChildProfile[]
  }

  let relays: string[] = []
  if (json.relays !== undefined) {
    if (!isRelayUrlArray(json.relays)) return null
    relays = json.relays
  }

  return {
    v: 1,
    type: 'vault',
    mnemonic: json.mnemonic,
    guardianPk: json.guardianPk,
    authEvent,
    children,
    relays,
    createdAt: json.createdAt,
  }
}

// --- Status / resync payloads (all ride KIND_STATUS, 31114) --------------------

/** Child -> guardian heartbeat: "here is my view of the ledger" (spec §2.1). */
export interface StatusPayload {
  v: 1
  type: 'status'
  /** unix SECONDS. */
  at: number
  lastEntryId: string | null
  entryCount: number
  docHighWater: Record<string, number>
  /** e.g. '0.2.0'. */
  appVersion: string
  /** Additive (v0.3): the child has seen evidence it is behind (a GRANT with
   *  no entry, an ENTRY on an account it does not know) and asks for a
   *  snapshot whatever the counts say. Absent means false; an older guardian
   *  ignores it and just compares. */
  catchUp?: true
}

/** "Send me everything you have after `since`" — either direction. */
export interface ResyncRequestPayload {
  v: 1
  type: 'resync.request'
  /** Entry id to resume after, or null for "everything you have". */
  since: string | null
}

/** One page of RAW SIGNED inner events (kinds ENTRY/CONFIG/GRANT/CHILD_SIG).
 *  The signatures are what make this safe to accept from a peer; verifying
 *  them is `sync/resync.ts`'s job, never this parser's (spec §2.4). */
export interface ResyncReplyPayload {
  v: 1
  type: 'resync.reply'
  events: NostrEvent[]
  /** 0-based. */
  page: number
  more: boolean
}

/** Events per `resync.reply` page. */
export const RESYNC_PAGE_SIZE = 100
/** Hard cap on a single reply — a peer sending more is refused outright, so a
 *  hostile page can never be unbounded work for the receiver. */
export const RESYNC_MAX_EVENTS_PER_REPLY = 200

/** Max `appVersion` length — a version string, not a free-text channel. */
const MAX_APP_VERSION_LEN = 32

export function buildStatusPayload(fields: Omit<StatusPayload, 'v' | 'type'>): StatusPayload {
  return { v: 1, type: 'status', ...fields }
}

export function buildResyncRequestPayload(since: string | null): ResyncRequestPayload {
  return { v: 1, type: 'resync.request', since }
}

export function buildResyncReplyPayload(fields: Omit<ResyncReplyPayload, 'v' | 'type'>): ResyncReplyPayload {
  return { v: 1, type: 'resync.reply', ...fields }
}

/** Structural mirror of `wire/giftwrap.ts`'s own private `isNostrEventShape`
 *  — shape only, never a signature check (see ResyncReplyPayload's comment).
 *  Exported because the same "is this even an event?" gate is needed wherever
 *  raw inner events are handled: `state/persist.ts`'s `innerEvents`
 *  sanitiser, and (Phase B) `sync/resync.ts`'s verified ingest. */
export function isNostrEventShape(x: unknown): x is NostrEvent {
  return (
    isPlainObject(x) &&
    typeof x.id === 'string' &&
    typeof x.pubkey === 'string' &&
    typeof x.created_at === 'number' &&
    typeof x.kind === 'number' &&
    Array.isArray(x.tags) &&
    typeof x.content === 'string' &&
    typeof x.sig === 'string'
  )
}

function isSafeIntRecord(x: unknown): x is Record<string, number> {
  return isPlainObject(x) && Object.values(x).every((v) => isSafeInt(v))
}

/** Union parser for kind 31114 — dispatches on `type`. Unknown type -> null. */
export function parseStatusKindPayload(
  json: unknown,
): StatusPayload | ResyncRequestPayload | ResyncReplyPayload | null {
  if (!isPlainObject(json) || json.v !== 1) return null

  if (json.type === 'status') {
    if (!isNonNegSafeInt(json.at)) return null
    if (json.lastEntryId !== null && !isNonEmptyString(json.lastEntryId)) return null
    if (!isNonNegSafeInt(json.entryCount)) return null
    if (!isSafeIntRecord(json.docHighWater)) return null
    if (typeof json.appVersion !== 'string' || json.appVersion.length > MAX_APP_VERSION_LEN) return null
    return {
      v: 1,
      type: 'status',
      at: json.at,
      lastEntryId: json.lastEntryId,
      entryCount: json.entryCount,
      docHighWater: json.docHighWater,
      appVersion: json.appVersion,
      ...(json.catchUp === true ? { catchUp: true as const } : {}),
    }
  }

  if (json.type === 'resync.request') {
    if (json.since !== null && !isNonEmptyString(json.since)) return null
    return { v: 1, type: 'resync.request', since: json.since }
  }

  if (json.type === 'resync.reply') {
    if (!isNonNegSafeInt(json.page)) return null
    if (typeof json.more !== 'boolean') return null
    if (!Array.isArray(json.events) || json.events.length > RESYNC_MAX_EVENTS_PER_REPLY) return null
    if (!json.events.every(isNostrEventShape)) return null
    return { v: 1, type: 'resync.reply', events: json.events as NostrEvent[], page: json.page, more: json.more }
  }

  return null
}
