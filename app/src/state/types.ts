import type { ChildDevice, ChildIdentity } from '../identity/devices'
import type { Account } from '../domain/types'
import type { Entry } from '../domain/types'
import type { AllowanceConfig } from '../domain/allowance'
import type { InterestConfig } from '../domain/interest'
import type { Chore, ChoreTick } from '../domain/chores'
import type { AuditResult } from '../domain/audit'
import type { NostrEvent } from 'nostr-tools/pure'
import type { RequestPayload } from '../wire/payloads'

export type Role = 'unset' | 'guardian' | 'child'

// index = dependant derivation index (see identity/derive.ts, Task 2)
export interface ChildProfile {
  pubkey: string
  name: string
  index: number
  /** Stable My Signet persona; pubkey remains an immutable ledger alias on legacy families. */
  signet?: ChildIdentity
  /** Unix SECONDS the guardian's own "pair.claim" ceremony last succeeded
   *  for this child (store.tsx's `onPairClaimAnswered`) — additive/optional
   *  so an existing snapshot/vault/persisted state that predates it parses
   *  exactly as before (field simply absent, meaning "no device has ever
   *  paired"). Never cleared once set, even across a later revoke/re-pair —
   *  it answers "has a device EVER claimed this identity", not "is one
   *  paired right now" (that's `docs.accounts.revoked`, separately). */
  pairedAt?: number
  /** Unix SECONDS the guardian archived ("removed") this child — additive/
   *  optional for the same reason as `pairedAt`. An archived child stays in
   *  `state.children` and its ledger entries are untouched (money must
   *  always add up); it is simply hidden from Home and the other family
   *  lists, and the scheduler stops paying it. Never removed once set. A
   *  paired device is revoked separately, via `docs.accounts.revoked`, at
   *  the same moment a child with one is archived. */
  archived?: number
}

// Each doc is full-state replaceable: a later doc of the same kind wholly
// supersedes the earlier one (see applyConfigDoc's LWW-by-issuedAt in state.ts).
export interface ConfigDocs {
  accounts: {
    v: 1
    issuedAt: number
    accounts: Account[]
    /** Additive (v0.2 spec §4.5): child pubkey -> unix SECONDS the guardian
     *  revoked that device. It rides the accounts doc so it replicates with
     *  the same LWW-by-issuedAt machinery every other policy change uses,
     *  and it is never removed — the entry IS the record of the revocation. */
    revoked?: Record<string, number>
    devices?: ChildDevice[]
    deviceRevision?: number
  }
  allowance: { v: 1; issuedAt: number; configs: AllowanceConfig[] }
  interest: { v: 1; issuedAt: number; configs: InterestConfig[] }
  chores: { v: 1; issuedAt: number; chores: Chore[] }
}

/**
 * How this device's family identity is rooted (v0.2 spec §1.4).
 *
 * `phrase` — the pre-v0.2 fallback: a BIP-39 recovery phrase the user wrote
 * down, and nothing else. `signet` — a My Signet identity is the root of
 * RECOVERY and AUTHORITY (never of the key tree): it holds the encrypted
 * family vault and it attests, via a kind-21236 event, that this guardian
 * device speaks for the family.
 */
export type RootRecord =
  | { kind: 'phrase' }
  | {
      kind: 'signet'
      /** 64-hex My Signet pubkey. */
      pubkey: string
      /** The kind-21236 attestation. JSON-safe; persisted and put on the wire. */
      authEvent: NostrEvent
      /** Sanitised display name the user shared at approval, if any. */
      displayName?: string
      /** Unix SECONDS of the last successful vault backup publish, or null. */
      backedUpAt: number | null
    }

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'dismissed'

// The Approvals inbox's durable record of one spend.request/allowance.claim
// — see internal plan 2026-08-11-parent-mode, Task 5, and
// state/state.ts's upsertRequest/recordRequestDecision (the pure fold
// functions that create/mutate these). "dismissed"/"denied" are STATUSES,
// never deletions: a relay replaying the same REQUEST wrap (or the child's
// own device retrying because it never saw an ack) must dedupe by
// `request.reqId` against whatever record already exists here, rather than
// resurrecting an already-decided request back to 'pending'.
export interface StoredRequest {
  request: RequestPayload
  /** The wire-authenticated sender (sync/multi.ts's membership-checked
   *  `authorPk`, or — for a scheduler-synthesised gated allowance claim,
   *  which never crosses the wire — the same child pubkey the claim itself
   *  names). MUST equal `request.child`: see upsertRequest/
   *  recordRequestDecision's doc comments for why that's enforced, not
   *  assumed — `request.child` is self-reported INSIDE the payload, this
   *  field is what was actually authenticated. */
  authorPk: string
  status: RequestStatus
  /** Set only once `status` moves off 'pending'. */
  decidedAt?: number
  /** `spend.request` 'approved' only, and only when the grant was clamped
   *  below what was asked (Task 5's stepper) — the amount actually granted.
   *  Absent for `allowance.claim` (paid in full or not at all — a period
   *  has no partial grant) and for any other status. */
  grantedAmountMinor?: number
  createdAt: number
  /** `allowance.claim` only: set by `upsertRequest` when the claimed
   *  periodKey was legitimate under the allowance config in force when the
   *  claim was received. A claim still pending when a later edit re-anchors
   *  that config stays grantable — see
   *  state.ts#claimPeriodGrantable. */
  periodLegitimateAtReceipt?: true
  /** Child side only: this row was synthesised by `recordGrantResult` from a
   *  GRANT for a reqId this device never held (a scheduler claim, or after
   *  local state loss). Its `request` may not satisfy `parseRequestPayload`
   *  (e.g. a spend with no currency), so persistence loads it through a
   *  lenient path instead of dropping it. Display only. */
  synthetic?: true
}

export interface AppState {
  v: 1
  role: Role
  guardianPubkey: string | null
  self: { pubkey: string | null; childIndex: number | null; devicePk?: string }
  children: ChildProfile[]
  entries: Entry[]
  /** Durable correction delivery intents, committed with their ledger rows. */
  pendingCorrections?: Entry[][]
  /** Highest complete family backup revision restored on this installation. */
  backupRevision?: number
  acks: Record<string, number>
  ticks: ChoreTick[]
  audits: AuditResult[]
  requests: StoredRequest[]
  docs: ConfigDocs
  docHighWater: Record<string, number>
  /** Guardian recovery: per-kind, per-child source timestamps, unix SECONDS.
   * A newer sibling view must not pin another child's older rows. */
  docChildHighWater?: Record<string, Record<string, number>>
  /** Local scheduler cache: last evaluated deposit-match due day (YYYY-MM-DD),
   * tied to the exact config. No money entry is minted for a zero payout. */
  matchEvaluations?: Record<string, { config: string; ledger: string; throughDay: string }>
  relays: string[]
  seenEventIds: string[]
  /** null = never established (pre-v0.2 state, or a role-unset device). */
  root: RootRecord | null
  /** Raw signed inner events, by event id — the lossless resync corpus
   *  (v0.2 spec §2.3). Bounded by state.ts#retainInnerEvents. */
  innerEvents: Record<string, NostrEvent>
}
