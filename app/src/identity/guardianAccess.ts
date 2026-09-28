import type { AppState } from '../state/types'
import { verifyFamilyAuthority } from './familyAuthority'

/** Parent operation requires a verified binding to this family's guardian key.
 * A saved binding permits offline use; a live Signet session is not required.
 */
export function guardianNeedsSignet(app: Pick<AppState, 'role' | 'root' | 'guardianPubkey'>): boolean {
  if (app.role !== 'guardian') return false
  return app.root?.kind !== 'signet' || app.guardianPubkey === null ||
    !verifyFamilyAuthority(app.root.authEvent, app.root.pubkey, app.guardianPubkey)
}
