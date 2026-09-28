import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getPublicKey } from 'nostr-tools/pure'
import { AppContext, useApp, type AppContextValue } from '../store/store'
import { vaultLoad } from '../identity/vault'
import { childForDevice } from '../identity/devices'
import { dataStorage, flushDataStorage } from '../platform/dataStorage'
import { scopeDocs } from '../sync/snapshot'
import { Banner, Button, Screen } from '../components/ui'
import { ParentLock } from './ParentLock'

const ChildShell = lazy(() => import('./ChildShell'))
const MODE_KEY = 'kinjar.parent-view.v1'
const ParentModeContext = createContext<{ actAs: (child: string) => void } | null>(null)
export function useParentMode() { return useContext(ParentModeContext) }

/** The mode lives outside guardian routes, so Back, reload and notification
 * navigation cannot bypass the PIN when a phone is handed to a child. */
export default function ParentAccess({ children }: { children: React.ReactNode }) {
  const parent = useApp()
  const [unlocked, setUnlocked] = useState(false)
  const [child, setChild] = useState<string | null>(() => dataStorage().getItem(MODE_KEY))
  const [returning, setReturning] = useState(false)
  const [key, setKey] = useState<Uint8Array | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const ref = useRef(parent)
  ref.current = parent
  const profile = parent.state.app.children.find(c => c.pubkey === child)
  useEffect(() => {
    const lock = () => setUnlocked(false)
    const hidden = () => { if (document.visibilityState === 'hidden') lock() }
    window.addEventListener('blur', lock)
    document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('blur', lock); document.removeEventListener('visibilitychange', hidden) }
  }, [])
  useEffect(() => {
    let cancelled = false
    setKey(null); setKeyError(null)
    if (!child) return
    let held: Uint8Array | null = null
    void (async () => {
      const app = ref.current.state.app
      for (const device of app.docs.accounts.devices ?? []) {
        if (device.child !== child || device.role !== 'shared-phone' || childForDevice(app, device.devicePk) !== child) continue
        const sk = await vaultLoad(`shared-device:${child}:${device.devicePk}`)
        if (cancelled) { sk?.fill(0); return }
        if (sk && getPublicKey(sk) === device.devicePk && childForDevice(ref.current.state.app, device.devicePk) === child) { held = sk; setKey(sk); return }
        sk?.fill(0)
      }
      if (!cancelled) setKeyError('A parent needs to reconnect this child’s view on this phone with My Signet. Their money and history are still saved.')
    })().catch(() => { if (!cancelled) setKeyError('Could not open this child’s view. Return to parent mode and reconnect it.') })
    return () => { cancelled = true; held?.fill(0) }
  }, [child, parent.state.app.docs.accounts.devices, parent.state.app.docs.accounts.revoked])
  function actAs(id: string) {
    if (!unlocked || !ref.current.state.app.children.some(c => c.pubkey === id && c.signet && c.archived === undefined)) return
    dataStorage().setItem(MODE_KEY, id)
    void flushDataStorage()
    setChild(id); setReturning(false); setUnlocked(false)
  }
  const childContext = useMemo<AppContextValue | null>(() => {
    if (!profile || !key || !child) return null
    const app = parent.state.app
    const own = { ...app, role: 'child' as const, self: { pubkey: child, childIndex: profile.index, devicePk: getPublicKey(key) },
      children: [profile], entries: app.entries.filter(e => e.child === child), docs: scopeDocs(app.docs, child),
      audits: app.audits.filter(a => a.child === child),
      ticks: app.ticks.filter(t => app.docs.chores.chores.some(c => c.id === t.chore && c.child === child)),
      requests: app.requests.filter(r => r.request.child === child),
    }
    const devicePk = getPublicKey(key)
    return { ...parent, state: { ...parent.state, app: own, pairing: null }, effects: [], guardianSk: null, childSk: key, locked: false,
      unlockChildSk: () => {}, lockUi: () => {}, wipeChildSk: () => {}, onPairClaimAnsweredRef: { current: null }, onPairClaimPendingRef: { current: null },
      dispatch: action => {
        if (action.type !== 'updateApp') return
        parent.dispatch({ type: 'updateApp', update: current => {
          if (childForDevice(current, devicePk) !== child) return current
          const next = action.update({ ...own, requests: current.requests.filter(r => r.request.child === child), ticks: current.ticks.filter(t => current.docs.chores.chores.some(c => c.id === t.chore && c.child === child)), audits: current.audits.filter(a => a.child === child) })
          // Child mode cannot change any balance, policy, identity or approval.
          if (JSON.stringify(next.entries) !== JSON.stringify(own.entries) || JSON.stringify(next.docs) !== JSON.stringify(own.docs)) return current
          const requests = next.requests.filter(r => r.request.child === child && r.status === 'pending' && !current.requests.some(old => old.request.reqId === r.request.reqId))
            .map(r => ({ ...r, authorPk: devicePk }))
          const ticks = next.ticks.filter(t => !current.ticks.some(old => old.id === t.id) && current.docs.chores.chores.some(c => c.id === t.chore && c.child === child))
          const audits = next.audits.filter(a => a.child === child && !current.audits.some(old => old.id === a.id))
          return { ...current, requests: [...current.requests, ...requests], ticks: [...current.ticks, ...ticks], audits: [...current.audits, ...audits] }
        } })
      },
    }
  }, [parent, child, profile, key])
  if (returning) return <>
    <ParentLock onUnlocked={() => {
      dataStorage().removeItem(MODE_KEY); void flushDataStorage()
      setChild(null); setReturning(false); setUnlocked(true)
    }} />
    {child && <Button variant="quiet" block onClick={() => setReturning(false)}>Back to child view</Button>}
  </>
  if (child !== null) return <>
    <Button variant="quiet" block onClick={() => { setUnlocked(false); setReturning(true) }}>Return to parent mode</Button>
    {keyError ? <Screen title={profile?.name ?? 'Child view'}><Banner tone="info">{keyError}</Banner></Screen> : childContext ? <>
      <Banner tone="info">In {profile?.name}’s view. Actions are recorded from this shared phone.</Banner>
      <AppContext.Provider value={childContext}><Suspense fallback={null}><ChildShell /></Suspense></AppContext.Provider>
    </> : <Screen title="Opening child view"><p>Loading…</p></Screen>}
  </>
  return <ParentModeContext.Provider value={{ actAs }}><div hidden={!unlocked} {...(!unlocked ? { inert: '' } : {})}>{children}</div>{!unlocked && <ParentLock onUnlocked={() => setUnlocked(true)} />}</ParentModeContext.Provider>
}
