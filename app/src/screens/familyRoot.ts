// The Settings "Family root" card, as a pure view model (v0.2 spec §1.8).
//
// Every string the card shows comes from here, so the copy is testable
// without React and cannot drift between the three states the card has:
// no root at all, a phrase root, and a My Signet root (backed up or not).

import type { RootRecord } from '../state/types'

export interface RootCardModel {
  title: string
  subtitle: string
  /** e.g. "Backed up to My Signet ✓ 2 September 2026" — null when this
   *  family has no backup on record yet. */
  backupLine: string | null
  showBackupButton: boolean
  /** "Back up now" the first time, "Back up again" once there is a backup on
   *  record — the action is the same either way. */
  backupButtonLabel: string
  showConnectButton: boolean
  showDisconnectButton: boolean
}

/** `<first 8 hex>…<last 8 hex>` — the shape used wherever a pubkey has to be
 *  recognisable to a person without being readable in full. */
export function shortNpub(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`
}

/**
 * Pure. `formatDate` takes unix SECONDS and is injected — no clock and no
 * locale table in here.
 *
 * A `phrase` root and no root at all read identically: both mean "this family
 * has no My Signet root", and the card offers to add one. The difference
 * between them matters to the app (one is a deliberate choice, the other is a
 * device that predates v0.2) but not to the person reading this card.
 */
export function rootCardModel(root: RootRecord | null, formatDate: (unixSec: number) => string): RootCardModel {
  const title = 'Family root'

  if (root === null || root.kind === 'phrase') {
    return {
      title,
      subtitle: 'Add a family root so a new phone can bring everything back.',
      backupLine: null,
      showBackupButton: false,
      backupButtonLabel: 'Back up now',
      showConnectButton: true,
      showDisconnectButton: false,
    }
  }

  const name = root.displayName !== undefined && root.displayName.trim() !== '' ? root.displayName : shortNpub(root.pubkey)
  const backedUp = root.backedUpAt !== null

  return {
    title,
    subtitle: `Signed in as ${name}`,
    backupLine: backedUp ? `Backed up to My Signet ✓ ${formatDate(root.backedUpAt as number)}` : null,
    // ALWAYS offered, alongside the date line rather than instead of it. The
    // guardian re-publishes the vault on its own whenever the roster changes,
    // but that publish can fail quietly — offline, no relay reachable —
    // and hiding this button once a family had ever backed up left that
    // failure with no remedy anywhere in the app.
    showBackupButton: true,
    backupButtonLabel: backedUp ? 'Back up again' : 'Back up now',
    showConnectButton: false,
    showDisconnectButton: false,
  }
}
