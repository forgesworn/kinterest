// The child device's lock screen: a big friendly number pad gating entry
// into the jar home behind the PIN set during ChildOnboarding.tsx. See
// internal plan 2026-08-11-child-mode, Task 2, and
// identity/pinLock.ts's header ("THE MODEL") for why store.tsx renders THIS
// screen on every fresh app launch: the child sk is held ONLY in React
// memory once unlocked, never in any browser storage, so a reload / restored
// tab / new tab always finds nothing and lands here.
//
// The 5-attempt soft backoff (identity/pinLock.ts#backoffSecs et al.) is
// persisted to `localStorage` (`loadBackoffState`/`saveBackoffState`), so a
// page reload can't reset a live lockout for free — it survives exactly as
// long as the browser keeps that storage, independent of the in-memory sk
// above. Still a SOFT deterrent, not a hard security boundary: it slows a
// child mashing random numbers, not a determined attacker with the device in
// hand indefinitely, for whom `identity/pinLock.ts`'s own header already
// documents the real limit (a short numeric PIN's keyspace, however many
// PBKDF2 iterations guard it) — same trade-off keystore-kit's own README
// calls out for its PIN method.

import { useEffect, useState } from 'react'
import { Banner, Button, Card, EmptyState, PinPad, Screen } from '../components/ui'
import { useApp } from '../store/store'
import {
  canAttempt,
  clearBackoffState,
  loadBackoffState,
  nextLockedUntil,
  pinIsSet,
  saveBackoffState,
  unlockWithPin,
} from '../identity/pinLock'

const MIN_PIN_LENGTH = 4

export function ChildLock() {
  const { unlockChildSk } = useApp()
  const [ready, setReady] = useState(false)
  const [hasPin, setHasPin] = useState(false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Seeded synchronously from localStorage (not an effect — `getItem` is
  // synchronous) so a reload mid-lockout doesn't render one "unlocked" frame
  // before catching up. See this module's header.
  const [backoff, setBackoff] = useState(() => loadBackoffState(window.localStorage))
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    let cancelled = false
    void pinIsSet().then((isSet) => {
      if (!cancelled) {
        setHasPin(isSet)
        setReady(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // One-second tick, purely to count down a soft lockout — mirrors
  // PairDevice.tsx's own TTL countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])

  const locked = !canAttempt(backoff.lockedUntilSec, nowSec)

  async function handleUnlock() {
    if (locked || busy || pin.length < MIN_PIN_LENGTH) return
    const attemptNowSec = Math.floor(Date.now() / 1000)
    setBusy(true)
    setError(null)
    try {
      const sk = await unlockWithPin(pin)
      setPin('')
      if (sk === null) {
        const failures = backoff.consecutiveFailures + 1
        const next = { consecutiveFailures: failures, lockedUntilSec: nextLockedUntil(failures, attemptNowSec) }
        setBackoff(next)
        saveBackoffState(window.localStorage, next)
        setError("That PIN didn't match — try again.")
        return
      }
      setBackoff({ consecutiveFailures: 0, lockedUntilSec: 0 })
      clearBackoffState(window.localStorage)
      unlockChildSk(sk)
    } finally {
      setBusy(false)
    }
  }

  if (!ready) {
    return <Screen title="Jar">{null}</Screen>
  }

  if (!hasPin) {
    // Shouldn't happen via the normal pairing flow (ChildOnboarding only
    // ever flips role to 'child' after a PIN is already sealed) — but a
    // restored/imported AppState blob with no matching vault entry is a real
    // possibility this screen must fail calmly on, not crash into a PIN pad
    // that can never succeed.
    return (
      <Screen title="Jar">
        <EmptyState title="This device needs pairing">
          Ask whoever set this up to pair this device again.
        </EmptyState>
      </Screen>
    )
  }

  const waitSecs = Math.max(0, backoff.lockedUntilSec - nowSec)

  return (
    <Screen title="Enter your PIN">
      <Card>
        <PinPad value={pin} onChange={setPin} disabled={busy || locked} label="Enter your PIN" />
      </Card>
      {locked ? (
        <Banner tone="info">Too many tries — wait {waitSecs}s and try again.</Banner>
      ) : (
        error && <Banner tone="bad">{error}</Banner>
      )}
      <Button
        variant="primary"
        block
        onClick={() => void handleUnlock()}
        disabled={busy || locked || pin.length < MIN_PIN_LENGTH}
      >
        {busy ? 'Checking…' : 'Unlock'}
      </Button>
    </Screen>
  )
}
