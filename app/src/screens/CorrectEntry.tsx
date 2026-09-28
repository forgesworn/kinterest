import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Entry } from '../domain/types'
import { appendCorrection, correctionEntries } from '../domain/corrections'
import { newId } from '../domain/id'
import { formatMinor } from '../domain/money'
import { Banner, Button, Sheet } from '../components/ui'
import { MoneyInput, parseAmount } from '../components/MoneyInput'
import { useApp } from '../store/store'
import { flushDataStorage } from '../platform/dataStorage'

export function CorrectEntry({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const { dispatch, guardianSk } = useApp()
  const [reason, setReason] = useState('')
  const [replace, setReplace] = useState(false)
  const [amounts, setAmounts] = useState(entry.legs.map(() => ''))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const pending = useRef<Entry[] | null>(null)
  async function save() {
    if (submitting.current || !guardianSk) return
    submitting.current = true; setBusy(true); setError(null)
    try {
      const replacements = replace ? entry.legs.map((l, i) => parseAmount(amounts[i]!, l.currency)) : undefined
      if (replacements?.some(n => n === null)) throw new Error('Enter a positive amount for each side of the replacement.')
      const nowMs = Date.now(), nowSec = Math.floor(nowMs / 1000)
      const bundle = pending.current ?? correctionEntries(entry, { id: newId(nowMs), child: entry.child, author: 'guardian', createdAt: nowSec }, reason, replacements as number[] | undefined)
      flushSync(() => dispatch({ type: 'updateApp', update: app => ({ ...app, entries: appendCorrection(app.entries, app.docs.accounts.accounts, bundle), pendingCorrections: app.pendingCorrections?.some(b => b[0]?.id === bundle[0]!.id) ? app.pendingCorrections : [...(app.pendingCorrections ?? []),bundle] }) }))
      pending.current = bundle
      if (!await flushDataStorage()) throw new Error('The correction is waiting to be saved. Keep the app open and try again.')
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save this correction.') }
    finally { submitting.current = false; setBusy(false) }
  }
  return <Sheet title="Correct this entry" onClose={onClose}>
    <p>Original: {entry.legs.map(l => formatMinor(l.currency, l.amountMinor)).join(' / ')}. The original stays in history, followed by its reversal and your reason.</p>
    <label className="field-label" htmlFor="correction-reason">Reason</label>
    <textarea id="correction-reason" className="text-input" maxLength={500} value={reason} disabled={busy || pending.current !== null} onChange={e => setReason(e.target.value)} />
    <label><input type="checkbox" checked={replace} disabled={busy || pending.current !== null} onChange={e => setReplace(e.target.checked)} /> Add a replacement with the right amount</label>
    {replace && entry.legs.map((l, i) => <MoneyInput key={i} currency={l.currency} rawValue={amounts[i]!} onRawChange={text => setAmounts(old => old.map((a, j) => i === j ? text : a))} label={`Replacement amount ${i + 1}`} />)}
    <p>Correcting pocket money, interest or a match keeps that paid period closed. Other interest and match payments stay as recorded.</p>
    {error && <Banner tone="bad">{error}</Banner>}
    <Button variant="primary" block disabled={busy || !reason.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save correction'}</Button>
  </Sheet>
}
