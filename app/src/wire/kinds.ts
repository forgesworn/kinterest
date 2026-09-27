// Wire kind numbers for the inner (rumor) events this app exchanges over a
// relay. The outer transport is always NIP-59 gift wrap: seal (13) then wrap
// (1059) — see Task 4. MARKER_TAG identifies our events on a shared relay
// without leaking any product name (name-free by design: relay-visible
// artifacts are name-free — "kin-jar", never the app's real name).

export const SEAL = 13
export const WRAP = 1059

/** REQUEST — spend.request / allowance.claim / pair.claim. child -> guardian. */
export const KIND_REQUEST = 31111
/** GRANT — guardian's decision on a REQUEST. guardian -> child. */
export const KIND_GRANT = 31112
/** STATUS heartbeat. child -> guardian. */
export const KIND_STATUS = 31114
/** PAIR_OFFER — guardian's answer to a pair.claim. guardian -> child device. */
export const KIND_PAIR_OFFER = 31117
/** ENTRY — a ledger entry. either -> other. */
export const KIND_ENTRY = 31120
/** CONFIG — a replaceable config doc (accounts/allowance/interest/chores/family). guardian -> child. */
export const KIND_CONFIG = 31121
/** SNAPSHOT / CHECKPOINT. guardian -> child. */
export const KIND_SNAPSHOT = 31122
/** ACK — entry receipt. either -> other. */
export const KIND_ACK = 31123
/** CHILD_SIG — chore tick / audit result. child -> guardian. */
export const KIND_CHILD_SIG = 31124
/** VAULT — the Signet-encrypted family vault (mnemonic + roster + relays).
 *  guardian -> the family's My Signet root identity. See the v0.2 spec §1.6. */
export const KIND_VAULT = 31125

export const MARKER_TAG: readonly [string, string] = ['t', 'kin-jar']
