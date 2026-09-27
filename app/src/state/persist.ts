import type { NostrEvent } from 'nostr-tools/pure'
import { assertEntry } from '../domain/ledger'
import type { Entry } from '../domain/types'
import { isNostrEventShape, parseRequestPayload } from '../wire/payloads'
import { emptyState, retainInnerEvents } from './state'
import type { AppState, ConfigDocs, RootRecord, StoredRequest } from './types'

// Name-free by design: no product name on disk.
const STORAGE_KEY = 'kinjar.state.v1'

// Minimal Storage surface — matches the DOM Storage interface's read/write
// members without depending on "dom" lib types, so this compiles the same
// whether or not DOM lib is present. vitest runs with environment 'node',
// where globalThis.localStorage does not exist, so callers under test must
// inject a fake; browser callers get the real thing via the default.
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function noopStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

// Reading `globalThis.localStorage` can itself throw (some browsers raise a
// SecurityError just accessing the property in restricted/privacy contexts),
// as well as simply not exist (vitest's node environment, where the property
// is undefined rather than throwing). Either way, fall back to an in-memory
// no-op store rather than letting default-parameter evaluation throw.
function defaultStorage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage
    if (ls) return ls
  } catch {
    // fall through to no-op
  }
  return noopStorage()
}

function looksLikeAppState(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && (x as { v?: unknown }).v === 1
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isRole(x: unknown): x is AppState['role'] {
  return x === 'unset' || x === 'guardian' || x === 'child'
}

function isSelfShape(x: unknown): x is AppState['self'] {
  return (
    isPlainObject(x) &&
    (x.pubkey === null || typeof x.pubkey === 'string') &&
    (x.childIndex === null || typeof x.childIndex === 'number')
  )
}

function isNumberRecord(x: unknown): x is Record<string, number> {
  return isPlainObject(x) && Object.values(x).every((v) => typeof v === 'number')
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === 'string')
}

// Per-doc-kind shape guard for `sanitiseState`'s `docs` field below — each of
// the four doc kinds (accounts/allowance/interest/chores) must have its OWN
// safe-integer `issuedAt` and its own list array (`listKey` — 'accounts',
// 'configs' x2, 'chores'), independently of the others, or it falls back to
// `emptyState()`'s value for THAT kind alone. Found by review: the previous
// check (`isPlainObject(raw.docs)`, applied once to the WHOLE `docs` object)
// accepted `raw.docs` wholesale the instant it was *any* plain object,
// regardless of what its nested doc kinds actually contained — a corrupt or
// hand-edited blob with, say, `docs.allowance` missing its `configs` array
// "loaded" successfully every time (nothing here threw), only to then blow
// up scheduler.ts#runSchedulers the moment it tried to iterate
// `state.docs.allowance.configs` — on EVERY launch thereafter, since the
// corrupt blob was exactly what got persisted right back by the next
// `saveState`. Deliberately shallow: this only checks the list is AN array
// and `issuedAt` is a safe integer, not that every element inside the list
// is itself well-formed — that finer-grained validation is each doc kind's
// own consumer's job (e.g. scheduler.ts's own per-config try/catch), same
// division of responsibility `entries`' own `assertEntry` filter above has
// relative to the rest of this function.
function hasValidDocShape(x: unknown, listKey: string): x is Record<string, unknown> {
  return isPlainObject(x) && Number.isSafeInteger(x.issuedAt) && Array.isArray(x[listKey])
}

// docHighWater is a Record<docKind, number> — unlike docs' four fixed keys,
// its keys are arbitrary (whatever ConfigDocKind strings have ever been
// published), so it can't be validated key-by-key against a fixed shape the
// way `hasValidDocShape` above does. Each VALUE must still be a safe integer
// (state/state.ts#applyConfigDoc compares it with `<=` against an inbound
// doc's own `issuedAt`) — a non-numeric value there wouldn't throw
// immediately, but would silently and permanently wedge that doc kind's own
// anti-rollback check (every comparison against it would be nonsensical).
// Invalid keys are dropped individually rather than discarding the whole
// record, mirroring every other per-row sanitiser in this file.
function sanitiseDocHighWater(x: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(x)) {
    if (Number.isSafeInteger(value)) result[key] = value as number
  }
  return result
}

const HEX64 = /^[0-9a-f]{64}$/
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x !== ''
}

function isNonNegSafeInt(x: unknown): x is number {
  return Number.isSafeInteger(x) && (x as number) >= 0
}

// Per-row guards (audit D13): additive fields must be sanitised row by row,
// not just checked for an `id`. A child without an `index` broke
// nextFreeChildIndex; a tick without a `day` or an audit without amounts
// breaks every consumer that reads them.
function isChildProfile(x: unknown): x is AppState['children'][number] {
  return isPlainObject(x) && isNonEmptyString(x.pubkey) && typeof x.name === 'string' && isNonNegSafeInt(x.index)
}

function isChoreTick(x: unknown): x is AppState['ticks'][number] {
  return (
    isPlainObject(x) &&
    isNonEmptyString(x.id) &&
    isNonEmptyString(x.chore) &&
    typeof x.day === 'string' &&
    DAY_KEY.test(x.day) &&
    isNonNegSafeInt(x.at)
  )
}

function isAuditResult(x: unknown): x is AppState['audits'][number] {
  return (
    isPlainObject(x) &&
    isNonEmptyString(x.id) &&
    isNonEmptyString(x.account) &&
    isNonEmptyString(x.child) &&
    Number.isSafeInteger(x.countedMinor) &&
    Number.isSafeInteger(x.expectedMinor) &&
    Number.isSafeInteger(x.deltaMinor) &&
    isNonNegSafeInt(x.at) &&
    (x.author === 'guardian' || x.author === 'child')
  )
}

/** The Signet root attestation event kind (v0.2 spec §1.1). */
const KIND_SIGNET_AUTH = 21236

/**
 * `AppState.root` (v0.2 spec §1.4). A `phrase` root carries nothing to check;
 * a `signet` root must name a 64-hex pubkey and carry an attestation event of
 * the right kind with 64-hex `id`/`pubkey`. Anything else -> null (i.e. "this
 * device has no root on record"), which is a safe fallback: the app then
 * offers to establish one again rather than acting on a half-read record.
 *
 * DELIBERATELY no signature check here — verifying one is async, and
 * `loadState` is synchronous by design. The attestation is re-verified
 * wherever it is DISPLAYED AS PROOF or accepted from a peer (spec §1.5); the
 * local record is a convenience, never the authority.
 */
function sanitiseRoot(x: unknown): RootRecord | null {
  if (!isPlainObject(x)) return null
  if (x.kind === 'phrase') return { kind: 'phrase' }
  if (x.kind !== 'signet') return null
  if (typeof x.pubkey !== 'string' || !HEX64.test(x.pubkey)) return null
  const ev = x.authEvent
  // Full event shape, `sig` included — see `wire/payloads.ts`'s
  // `parseRootAttestation`. A record missing a field cannot be re-verified
  // where it is displayed as proof, so it is not worth carrying.
  if (!isNostrEventShape(ev) || ev.kind !== KIND_SIGNET_AUTH) return null
  if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey)) return null
  const backedUpAt = Number.isSafeInteger(x.backedUpAt) ? (x.backedUpAt as number) : null
  const displayName = typeof x.displayName === 'string' && x.displayName.length <= 64 ? x.displayName : undefined
  return {
    kind: 'signet',
    pubkey: x.pubkey,
    authEvent: ev as unknown as NostrEvent,
    backedUpAt,
    ...(displayName !== undefined ? { displayName } : {}),
  }
}

/**
 * `AppState.innerEvents` (v0.2 spec §2.3) — the raw signed corpus this device
 * can replay to a peer. Keyed by event id, so a row whose key is not 64-hex,
 * whose value is not event-shaped, or whose key disagrees with the event's own
 * `id` is dropped: every consumer looks events up BY id, and a mis-keyed row
 * is one that would be served in answer to a request for a different event.
 * Bounded by `retainInnerEvents` afterwards, exactly as an insert batch is.
 */
function sanitiseInnerEvents(x: unknown): Record<string, NostrEvent> {
  if (!isPlainObject(x)) return {}
  const out: Record<string, NostrEvent> = {}
  for (const [key, value] of Object.entries(x)) {
    if (!HEX64.test(key)) continue
    if (!isNostrEventShape(value)) continue
    if (value.id !== key) continue
    out[key] = value
  }
  return retainInnerEvents(out)
}

/** `docs.accounts.revoked` (v0.2 spec §4.5): child pubkey -> unix SECONDS.
 *  Rows that aren't a 64-hex key with a safe-integer value are dropped
 *  individually; a `revoked` that isn't an object at all drops the FIELD, never
 *  the accounts doc around it — the accounts list is the more valuable of the
 *  two and has its own, independent validity. */
function sanitiseRevoked(x: unknown): Record<string, number> | undefined {
  if (!isPlainObject(x)) return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(x)) {
    if (HEX64.test(key) && Number.isSafeInteger(value)) out[key] = value as number
  }
  return out
}

function sanitiseAccountsDoc(raw: unknown, fallback: ConfigDocs['accounts']): ConfigDocs['accounts'] {
  if (!hasValidDocShape(raw, 'accounts')) return fallback
  const { revoked: rawRevoked, ...rest } = raw as ConfigDocs['accounts']
  const revoked = rawRevoked === undefined ? undefined : sanitiseRevoked(rawRevoked)
  return revoked === undefined ? (rest as ConfigDocs['accounts']) : { ...(rest as ConfigDocs['accounts']), revoked }
}

const REQUEST_STATUSES: readonly StoredRequest['status'][] = ['pending', 'approved', 'denied', 'dismissed']
function isRequestStatus(x: unknown): x is StoredRequest['status'] {
  return typeof x === 'string' && (REQUEST_STATUSES as readonly string[]).includes(x)
}

// A StoredRequest's inner `request` is validated via wire/payloads.ts's own
// total parser (the same one the wire layer uses for an inbound REQUEST) —
// there is no separate shape authority for RequestPayload, and this on-disk
// blob is exactly as untrusted as anything arriving over the wire. Invalid
// rows are dropped rather than failing the whole `requests` array.
/** The lenient shape a `synthetic` row's request is held to (audit D9): the
 *  envelope fields and a known op, but params need only be an object. */
function parseSyntheticRequest(x: unknown): StoredRequest['request'] | null {
  if (!isPlainObject(x) || x.v !== 1) return null
  if (typeof x.reqId !== 'string' || x.reqId === '' || typeof x.nonce !== 'string' || x.nonce === '') return null
  if (typeof x.child !== 'string' || x.child === '') return null
  if (!Number.isSafeInteger(x.ts) || (x.ts as number) < 0) return null
  if (x.op !== 'allowance.claim' && x.op !== 'spend.request') return null
  if (!isPlainObject(x.params)) return null
  return { v: 1, op: x.op, reqId: x.reqId, nonce: x.nonce, child: x.child, ts: x.ts as number, params: x.params }
}

function sanitiseStoredRequest(x: unknown): StoredRequest | null {
  if (!isPlainObject(x)) return null
  const synthetic = x.synthetic === true
  const request = parseRequestPayload(x.request) ?? (synthetic ? parseSyntheticRequest(x.request) : null)
  if (request === null) return null
  if (typeof x.authorPk !== 'string' || x.authorPk === '') return null
  if (!isRequestStatus(x.status)) return null
  if (!Number.isSafeInteger(x.createdAt)) return null
  const decidedAt = Number.isSafeInteger(x.decidedAt) ? (x.decidedAt as number) : undefined
  const grantedAmountMinor = Number.isSafeInteger(x.grantedAmountMinor) ? (x.grantedAmountMinor as number) : undefined
  return {
    request,
    authorPk: x.authorPk,
    status: x.status,
    createdAt: x.createdAt as number,
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    ...(grantedAmountMinor !== undefined ? { grantedAmountMinor } : {}),
    ...(x.periodLegitimateAtReceipt === true ? { periodLegitimateAtReceipt: true as const } : {}),
    ...(synthetic ? { synthetic: true as const } : {}),
  }
}

// Persisted state was written by our own saveState in the common case, but a
// corrupted or hand-edited blob must never smuggle an invalid entry into
// balances() — assertEntry (domain/ledger.ts) is the ledger's sole gate, and
// on-disk data has not passed through it. Each collection is sanitised
// independently: invalid rows are dropped rather than failing the whole
// load, and any field of the wrong basic shape falls back to emptyState()'s
// value for that field. Never throws (its only caller wraps it in try/catch
// too, as a second line of defence).
//
// `seenEventIds` is the sharp one of the scalar fields below: it isn't just
// display state, it's read with `.includes()` on every inbound wrap
// (sync/ingress.ts#handleWrap) — a corrupted non-array value there doesn't
// just look wrong, it throws the first time a wrap arrives, well after
// loadState returned successfully. `role`, `guardianPubkey`, `self` and
// `acks` get the same treatment for consistency (and because `role`/
// `guardianPubkey` now gate CONFIG/SNAPSHOT/GRANT direction in handleWrap —
// see MAX_ISSUED_AT_SKEW_SECS's doc comment in sync/ingress.ts — so a
// corrupted value there would fail closed in a confusing way rather than a
// clean, obvious one).
function sanitiseState(raw: Record<string, unknown>): AppState {
  const empty = emptyState()

  const entries = Array.isArray(raw.entries)
    ? raw.entries.filter((e): e is Entry => {
        try {
          assertEntry(e as Entry)
          return true
        } catch {
          return false
        }
      })
    : empty.entries

  const ticks = Array.isArray(raw.ticks) ? raw.ticks.filter(isChoreTick) : empty.ticks
  const audits = Array.isArray(raw.audits) ? raw.audits.filter(isAuditResult) : empty.audits
  const requests = Array.isArray(raw.requests)
    ? raw.requests.map(sanitiseStoredRequest).filter((r): r is StoredRequest => r !== null)
    : empty.requests
  // `rawDocs` is deliberately allowed to be `{}` (never itself falls back to
  // `empty.docs` in one shot) — each of the four fields below is validated,
  // and falls back, independently; see `hasValidDocShape`'s own doc comment.
  const rawDocs = isPlainObject(raw.docs) ? raw.docs : {}
  const docs: ConfigDocs = {
    accounts: sanitiseAccountsDoc(rawDocs.accounts, empty.docs.accounts),
    allowance: hasValidDocShape(rawDocs.allowance, 'configs') ? (rawDocs.allowance as ConfigDocs['allowance']) : empty.docs.allowance,
    interest: hasValidDocShape(rawDocs.interest, 'configs') ? (rawDocs.interest as ConfigDocs['interest']) : empty.docs.interest,
    chores: hasValidDocShape(rawDocs.chores, 'chores') ? (rawDocs.chores as ConfigDocs['chores']) : empty.docs.chores,
  }
  const docHighWater = isPlainObject(raw.docHighWater) ? sanitiseDocHighWater(raw.docHighWater) : empty.docHighWater
  const children = Array.isArray(raw.children) ? raw.children.filter(isChildProfile) : empty.children
  const relays = Array.isArray(raw.relays) ? raw.relays.filter((r): r is string => typeof r === 'string') : empty.relays

  const role = isRole(raw.role) ? raw.role : empty.role
  const guardianPubkey =
    raw.guardianPubkey === null || typeof raw.guardianPubkey === 'string' ? raw.guardianPubkey : empty.guardianPubkey
  const self = isSelfShape(raw.self) ? raw.self : empty.self
  const acks = isNumberRecord(raw.acks) ? raw.acks : empty.acks
  const seenEventIds = isStringArray(raw.seenEventIds) ? raw.seenEventIds : empty.seenEventIds
  const root = sanitiseRoot(raw.root)
  const innerEvents = sanitiseInnerEvents(raw.innerEvents)

  return {
    ...empty,
    ...raw,
    entries,
    ticks,
    audits,
    requests,
    docs,
    docHighWater,
    children,
    relays,
    role,
    guardianPubkey,
    self,
    acks,
    seenEventIds,
    root,
    innerEvents,
  } as AppState
}

// Total: any missing key, JSON parse failure, or shape that doesn't look
// like an AppState (wrong version, non-object, etc.) yields emptyState()
// rather than throwing. A shape that does look like an AppState still has
// its collections sanitised (see sanitiseState) before being trusted.
export function loadState(storage: StorageLike = defaultStorage()): AppState {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return emptyState()
    const parsed: unknown = JSON.parse(raw)
    if (!looksLikeAppState(parsed)) return emptyState()
    return sanitiseState(parsed)
  } catch {
    return emptyState()
  }
}

/** Never throws (audit D7): a full or blocked storage (QuotaExceededError,
 *  private mode) must not take the app down through the effect that calls
 *  this on every state change. Returns `true` when the write succeeded and
 *  `false` otherwise, so the caller can surface a non-fatal warning; the
 *  in-memory state keeps running and the next successful save catches up. */
export function saveState(s: AppState, storage: StorageLike = defaultStorage()): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(s))
    return true
  } catch {
    return false
  }
}

/** Removes the persisted blob entirely — the "Start again" button on the
 *  Unpaired screen (v0.2 spec §4.5). Deliberately a REMOVE, not a
 *  `saveState(emptyState())`: a device the family has removed should leave
 *  no ledger, no roster and no request history behind on disk at all. Total;
 *  a storage that throws is not this function's problem to report. */
export function clearState(storage: StorageLike = defaultStorage()): void {
  storage.removeItem(STORAGE_KEY)
}
