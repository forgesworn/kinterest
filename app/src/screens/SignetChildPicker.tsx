import { flushSync } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Banner, Button, Screen } from '../components/ui'
import { QRScanner } from '../components/QRScanner'
import { useApp } from '../store/store'
import { admitSignetChild } from '../identity/devices'
import { vaultStore } from '../identity/vault'
import { flushDataStorage, dataStorage } from '../platform/dataStorage'
import { sendConfig } from '../sync/publish'
import { configRecipients } from '../state/state'

export function dependantHint(text: string): string | null {
  try {
    const url = new URL(text.trim())
    const pk = url.searchParams.get('dependant')
    return url.protocol === 'bunker:' && pk !== null && /^[0-9a-f]{64}$/.test(pk) ? pk : null
  } catch { return null }
}
export function SignetChildPicker({ onDone, legacyChild }: { onDone?: (child: string) => void; legacyChild?: string }) {
  const { state, dispatch, guardianSk, relay } = useApp()
  const live = useRef(true), choosing = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const [code, setCode] = useState('')
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  function scan(text: string): boolean {
    if (!dependantHint(text)) return false
    setCode(text); setScanning(false); return true
  }
  async function choose() {
    const hint = dependantHint(code)
    const app = state.app
    if (!hint || guardianSk === null || app.guardianPubkey === null || app.root?.kind !== 'signet' || choosing.current) return
    choosing.current = true; setBusy(true); setError(null)
    const sk = generateSecretKey()
    try {
      const { authoriseChild } = await import('../identity/signetLogin')
      const result = await authoriseChild(app.guardianPubkey, app.root.pubkey, app.relays, hint, getPublicKey(sk), 'shared-phone')
      if (!live.current) return
      if (!result) throw new Error('My Signet did not authorise that child. Use an updated My Signet, activate your real identity and approve the selected dependant.')
      const child = legacyChild ?? result.consent.identityPk
      // Secret and durable mapping precede retirement of legacy credentials.
      const nowSec = Math.floor(Date.now() / 1000)
      let next = app
      // Validate before writing; the unique slot keeps old access intact on a failed commit.
      admitSignetChild(app, result.proof, guardianSk, nowSec, legacyChild)
      await vaultStore(`shared-device:${child}:${getPublicKey(sk)}`, sk)
      if (!live.current) return
      flushSync(() => dispatch({ type: 'updateApp', update: current => { next = admitSignetChild(current, result.proof, guardianSk, nowSec, legacyChild); return next } }))
      if (!await flushDataStorage()) throw new Error('The child is in memory but could not be saved yet. Keep Kinterest open and retry storage before pairing another phone.')
      for (const peerPk of configRecipients(next)) await sendConfig('accounts', next.docs.accounts, { selfSk: guardianSk, peerPk, relay, storage: dataStorage(), nowSec: Math.floor(Date.now() / 1000) }).catch(() => {})
      setDone(result.consent.name)
      onDone?.(child)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not add this child. Please try again.') }
    finally { sk.fill(0); choosing.current = false; if (live.current) setBusy(false) }
  }
  return <Screen title={legacyChild ? 'Link this child to My Signet' : 'Choose your child'}>
    <p>In My Signet, choose the child’s dependant persona and open “Pair an app as this dependant”. Scan its QR or paste its pairing code here.</p>
    <p>My Signet supplies their name and picture. You will approve this child and this device before anything is added.</p>
    {error && <Banner tone="bad">{error}</Banner>}
    {done && <Banner tone="good">{done} is ready.</Banner>}
    {scanning && <QRScanner active onScan={scan} />}
    <Button variant="quiet" disabled={busy} onClick={() => setScanning(s => !s)}>{scanning ? 'Stop scanning' : 'Scan My Signet QR'}</Button>
    <input className="text-input" aria-label="My Signet dependant pairing code" value={code} onChange={e => setCode(e.target.value)} disabled={busy} autoComplete="off" />
    <Button variant="primary" block onClick={() => void choose()} disabled={busy || !dependantHint(code) || guardianSk === null}>{busy ? 'Waiting for My Signet…' : 'Choose this child with My Signet'}</Button>
  </Screen>
}
