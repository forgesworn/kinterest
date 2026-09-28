import { useEffect, useRef, useState } from 'react'
import { Banner, Button, PinPad, Screen } from '../components/ui'
import { useApp } from '../store/store'
import { parentPinIsSet, setParentPin, unlockParent } from '../identity/parentPin'
import { isValidPinFormat } from '../identity/pinLock'

export function ParentLock({ onUnlocked }: { onUnlocked: () => void }) {
  const { state } = useApp()
  const [hasPin, setHasPin] = useState<boolean | null>(null)
  const [authorised, setAuthorised] = useState(false)
  const [confirmedUntil, setConfirmedUntil] = useState(0)
  const confirmedBinding = useRef<{ familyPk: string; rootPk: string } | null>(null)
  const latest = useRef(state.app)
  latest.current = state.app
  const authorisedUntil = useRef(0)
  const operation = useRef(false)
  const epoch = useRef(0), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++ } }, [])
  const [first, setFirst] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000))
  useEffect(() => { void parentPinIsSet().then(setHasPin).catch(e => { setHasPin(true); setError(String(e)) }) }, [])
  useEffect(() => { const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(id) }, [])
  useEffect(() => {
    const clear = () => { if (document.visibilityState === 'hidden') { epoch.current++; setConfirmedUntil(0); confirmedBinding.current = null; if (authorisedUntil.current) { authorisedUntil.current = 0; setAuthorised(false); setFirst(null); setPin('') } } }
    document.addEventListener('visibilitychange', clear)
    return () => document.removeEventListener('visibilitychange', clear)
  }, [])
  async function authenticate() {
    if (operation.current || state.app.root?.kind !== 'signet' || !state.app.guardianPubkey) return
    operation.current = true; setBusy(true); setError(null); setPin(''); setFirst(null); setConfirmedUntil(0)
    const binding = { familyPk: state.app.guardianPubkey, rootPk: state.app.root.pubkey }
    try {
      const { confirmParentPresence } = await import('../identity/signetLogin')
      if (!await confirmParentPresence(state.app.guardianPubkey, state.app.root.pubkey, state.app.relays)) throw new Error('Approve this parent-lock reset in My Signet to continue.')
      if (!mounted.current || latest.current.guardianPubkey !== binding.familyPk || latest.current.root?.kind !== 'signet' || latest.current.root.pubkey !== binding.rootPk) return
      // A completed external approval may arrive while My Signet is still
      // foregrounded. Hold it briefly, then require a visible user gesture.
      confirmedBinding.current = binding
      setConfirmedUntil(Math.floor(Date.now() / 1000) + 300)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not confirm My Signet.') }
    finally { operation.current = false; setBusy(false) }
  }
  function continueConfirmation() {
    const binding = confirmedBinding.current
    if (document.visibilityState === 'hidden' || !binding) return
    if (confirmedUntil <= Math.floor(Date.now() / 1000) || latest.current.guardianPubkey !== binding.familyPk || latest.current.root?.kind !== 'signet' || latest.current.root.pubkey !== binding.rootPk) {
      setConfirmedUntil(0); confirmedBinding.current = null; setError('Confirm My Signet again to choose a parent PIN.'); return
    }
    authorisedUntil.current = confirmedUntil
    setConfirmedUntil(0); confirmedBinding.current = null; setLockedUntil(0); setAuthorised(true)
  }
  async function submit() {
    if (operation.current || !isValidPinFormat(pin) || nowSec < lockedUntil) return
    if (authorised && Math.floor(Date.now() / 1000) >= authorisedUntil.current) { setAuthorised(false); setFirst(null); setPin(''); setError('Confirm My Signet again to choose a parent PIN.'); return }
    if (authorised && first === null) { setFirst(pin); setPin(''); return }
    operation.current = true; const attemptEpoch = epoch.current; setBusy(true); setError(null)
    try {
      if (authorised) {
        if (pin !== first) { setFirst(null); throw new Error('Those PINs did not match. Choose your parent PIN again.') }
        if (!await setParentPin(pin)) throw new Error('Choose a PIN of 4 to 8 digits.')
        setAuthorised(false); setFirst(null); setPin(''); if (mounted.current && epoch.current === attemptEpoch && document.visibilityState !== 'hidden') onUnlocked()
      } else {
        const r = await unlockParent(pin, nowSec)
        setLockedUntil(r.lockedUntilSec); setPin('')
        if (!r.unlocked) throw new Error(r.lockedUntilSec > nowSec ? 'Please wait before trying again.' : 'That parent PIN did not match.')
        if (mounted.current && epoch.current === attemptEpoch && document.visibilityState !== 'hidden') onUnlocked()
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open parent mode.'); setPin('') }
    finally { operation.current = false; setBusy(false) }
  }
  return <Screen title={authorised ? first === null ? 'Choose your parent PIN' : 'Confirm your parent PIN' : 'Parent mode'}>
    <p>This PIN protects parent approvals and settings when you hand the phone to a child. It is separate from your My Signet PIN.</p>
    {error && <Banner tone="bad">{error}</Banner>}
    {hasPin === null ? <p>Checking your parent lock…</p> : confirmedUntil > 0 ? <>
      <p>My Signet confirmed your presence. Continue here to choose your separate parent PIN.</p>
      <Button variant="primary" block onClick={continueConfirmation}>Continue after My Signet approval</Button>
    </> : !hasPin && !authorised ? <>
      <p>Confirm My Signet once to set up your parent lock.</p>
      <Button variant="primary" block disabled={busy} onClick={() => void authenticate()}>Confirm with My Signet</Button>
    </> : <>
      <PinPad value={pin} onChange={setPin} disabled={busy || nowSec < lockedUntil} label="Kinterest parent PIN" />
      {nowSec < lockedUntil && <p>Try again in {lockedUntil - nowSec}s.</p>}
      <Button variant="primary" block disabled={busy || !isValidPinFormat(pin) || nowSec < lockedUntil} onClick={() => void submit()}>{authorised ? first === null ? 'Continue' : 'Set parent PIN' : 'Unlock parent mode'}</Button>
      {!authorised && <Button variant="quiet" block disabled={busy} onClick={() => void authenticate()}>Forgot parent PIN? Reset with My Signet</Button>}
    </>}
  </Screen>
}
