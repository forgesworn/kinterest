import { assertEntry, assertEntryAgainst, assertReversalOf, balances, reverseEntry, type EntryMeta } from './ledger'
import type { Account, Entry } from './types'

/** Append a reasoned reversal and optional replacement; never edit history.
 * Replacement amounts are absolute integer minor units, one per original leg. */
export function correctionEntries(original: Entry, meta: EntryMeta, reason: string, replacement?: readonly number[]): Entry[] {
  assertEntry(original)
  if (original.reverses || original.correctionOf || meta.author !== 'guardian' || meta.child !== original.child) throw new RangeError('Choose an original entry to correct')
  if (!reason.trim() || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) throw new RangeError('Enter a reason of 1 to 500 characters')
  if (meta.id === original.id) throw new RangeError('Correction needs a new identifier')
  const reversal: Entry = { ...reverseEntry(original, { ...meta, note: reason.trim() }), correctionOf: original.id, correctionGroup: meta.id }
  const result = [reversal]
  if (replacement !== undefined) {
    if (replacement.length !== original.legs.length || replacement.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new RangeError('Enter a positive amount for each leg')
    const corrected: Entry = { ...original, id: `${meta.id}:replacement`, createdAt: meta.createdAt, author: 'guardian', note: reason.trim(),
      correctionOf: original.id, correctionGroup: meta.id,
      legs: original.legs.map((l, i) => ({ ...l, amountMinor: l.amountMinor < 0 ? -replacement[i]! : replacement[i]! })),
    }
    // The replacement is part of a correction, never a second request grant.
    delete corrected.requestId
    delete corrected.countedMinor
    assertEntry(corrected)
    result.push(corrected)
  }
  assertEntry(reversal)
  return result
}

/** Validate a whole correction before changing any state. Safe to retry. */
export function appendCorrection(entries: readonly Entry[], accounts: readonly Account[], bundle: readonly Entry[]): Entry[] {
  if (bundle.length < 1 || bundle.length > 2) throw new RangeError('Invalid correction bundle')
  const reversal = bundle[0]!
  const original = entries.find(e => e.id === reversal.reverses)
  if (!original || reversal.correctionOf !== original.id || reversal.correctionGroup !== reversal.id || !reversal.note?.trim()) throw new RangeError('Correction must link its original and reason')
  const expected = correctionEntries(original, { id: reversal.id, child: reversal.child, createdAt: reversal.createdAt, author: reversal.author }, reversal.note,
    bundle[1]?.legs.map(l => Math.abs(l.amountMinor)))
  for (let i = 0; i < bundle.length; i++) {
    const e = bundle[i]!, want = expected[i]!
    assertEntry(e); assertEntryAgainst(accounts, e)
    if (e.id !== want.id || e.kind !== want.kind || e.child !== want.child || e.author !== 'guardian' || e.createdAt !== want.createdAt || e.correctionOf !== want.correctionOf || e.correctionGroup !== want.correctionGroup || e.note !== want.note || e.category !== want.category || e.periodKey !== want.periodKey || JSON.stringify(e.legs) !== JSON.stringify(want.legs)) throw new RangeError('Invalid correction linkage')
  }
  assertReversalOf(original, reversal)
  if (bundle.every(e => entries.some(old => old.id === e.id && JSON.stringify(old) === JSON.stringify(e)))) return entries as Entry[]
  if (entries.some(e => e.reverses === original.id || bundle.some(b => b.id === e.id))) throw new RangeError('This entry has already been corrected or reversed')
  const next = [...entries, ...bundle]
  balances(next)
  return next
}

/** Ordinary reversals reopen a period; an explicit correction closes it. */
export function reopenedEntryIds(entries: readonly Entry[]): Set<string> {
  const closed = new Set(entries.filter(e => e.reverses && e.correctionOf === e.reverses).map(e => e.reverses!))
  return new Set(entries.map(e => e.reverses).filter((id): id is string => id !== undefined && !closed.has(id)))
}
