// Copy for the non-fatal "couldn't save" banner both shells show while the
// store's `storageError` flag is up (a localStorage write failed — quota,
// or storage blocked; audit D7). Kept pure so the rule is testable without
// a DOM: no flag, no banner.

export const STORAGE_ERROR_COPY =
  'This phone couldn’t save your latest changes — free up some space, then reopen the app.'

export function storageWarning(storageError: boolean): string | null {
  return storageError ? STORAGE_ERROR_COPY : null
}
