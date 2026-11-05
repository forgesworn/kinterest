// Copy for the non-fatal storage banners both shells show. Kept pure so the
// rules are testable without a DOM.
//
// Three facts, three lines, each shown only while true:
//   - the latest save failed (`storageError`, the store's own flag);
//   - rows that failed validation on load were set aside
//     (state/persist.ts#quarantinedEntries) — they are never folded into
//     balances, and the family should know the ledger on this phone may be
//     short rather than find out from the numbers;
//   - the whole saved state could not be read and was set aside
//     (state/persist.ts#unreadableStateBlob) — this phone has started again
//     from nothing, and the copy says so instead of pretending it is a new
//     install.

export const STORAGE_ERROR_COPY =
  'This phone couldn\u2019t save your latest changes \u2014 free up some space, then reopen the app.'

export const UNREADABLE_STATE_COPY =
  'The data saved on this phone couldn\u2019t be read, so the app has started again. The old copy has been kept aside \u2014 recover the family from My Signet or re-pair this phone.'

export function quarantinedCopy(count: number): string {
  return count === 1
    ? '1 saved money entry couldn\u2019t be read and has been set aside \u2014 balances on this phone may be missing it.'
    : `${count} saved money entries couldn\u2019t be read and have been set aside \u2014 balances on this phone may be missing them.`
}

export function storageWarning(storageError: boolean): string | null {
  return storageError ? STORAGE_ERROR_COPY : null
}

/** Every banner line to show, worst first. */
export function storageWarnings(input: { storageError: boolean; quarantined: number; unreadable: boolean }): string[] {
  const out: string[] = []
  if (input.storageError) out.push(STORAGE_ERROR_COPY)
  if (input.unreadable) out.push(UNREADABLE_STATE_COPY)
  if (input.quarantined > 0) out.push(quarantinedCopy(input.quarantined))
  return out
}
