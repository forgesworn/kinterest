// The child device's own pairing ceremony: "Join your family" -> scan the
// guardian's QR (camera, or paste as a fallback) -> a waiting screen showing
// the SAS code -> the guardian's PAIR_OFFER arrives -> set a PIN (twice) ->
// jar home. See internal plan 2026-08-11-child-mode, Task 2.
//
// Routing is state-derived, same convention as Onboarding.tsx: once this
// screen dispatches `startAsChildFromOffer` (flips `role` to 'child') and
// calls `unlockChildSk`, App.tsx's own next render already lands on the jar
// home stub — this component needs no "on complete" callback, only
// `onCancel` for backing out to the parent-onboarding welcome screen.
//
// THE ordering that matters: `startAsChildFromOffer` is deliberately NOT
// dispatched the moment the offer arrives — only once the chosen PIN has
// actually been sealed via `identity/pinLock.ts#setPin`. Dispatching earlier
// would flip `role` to 'child' while this component is still showing the PIN
// step; App.tsx's role-derived routing would then swap straight to
// ChildLock/the jar-home stub underneath it, stranding the ceremony
// mid-flow with no PIN ever set. The offer's contents (the real child sk,
// the guardian pk, the offer payload itself) are held in this component's
// own state (`pendingOffer`) until that PIN step completes.
//
// The child never sees a raw pubkey on this screen (Global Constraints):
// the guardian's pk from the QR and the SAS code are used to build wire
// traffic and a six-digit comparison code respectively, never rendered as
// hex.

import { useEffect, useState } from 'react'
import { Banner, Button, Card, PinPad, Screen } from '../components/ui'
import { QRScanner } from '../components/QRScanner'
import { useApp } from '../store/store'
import { newKeypair } from '../identity/keys'
import { isValidPinFormat, setPin as sealPin } from '../identity/pinLock'
import { acceptPairOffer, buildPairClaim } from '../pairing/pairing'
import type { PairOfferPayload } from '../wire/payloads'
import { sasDigits } from '../pairing/sas'
import { handlePairOfferWrap } from '../sync/ingress'
import { startAsChildFromOffer } from '../state/onboarding'
import { makePool } from '../wire/relayClient'
import { WRAP } from '../wire/kinds'
import { sendRequest } from '../sync/publish'
import {
  offerAccepted,
  retryPinEntry,
  rootRejectedStep,
  scanStep,
  submitConfirmPin,
  submitFirstPin,
  submitScannedText,
  type ChildOnboardingStep,
} from './childOnboardingFlow'

interface PendingOffer {
  offer: PairOfferPayload
  guardianPk: string
  childSk: Uint8Array
}

export function ChildOnboarding({ onCancel }: { onCancel: () => void }) {
  const { dispatch, unlockChildSk } = useApp()
  const [step, setStep] = useState<ChildOnboardingStep>(scanStep())
  const [pasteText, setPasteText] = useState('')
  const [sas, setSas] = useState<string | null>(null)
  const [pendingOffer, setPendingOffer] = useState<PendingOffer | null>(null)
  const [firstPin, setFirstPin] = useState('')
  const [confirmPinInput, setConfirmPinInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  // This device's own throwaway signing key, used only to authenticate the
  // pair.claim it sends and to unwrap the resulting PAIR_OFFER — see
  // pairing.ts's module header ("the claiming device's own key is the only
  // identifier it has to offer"). Generated once per ceremony; discarded if
  // the user backs out (never vaulted — only the REAL child sk the offer
  // carries is worth keeping, see identity/pinLock.ts).
  const [device] = useState(() => newKeypair())

  const waitingGuardianPk = step.kind === 'waiting' ? step.guardianPk : null
  const waitingToken = step.kind === 'waiting' ? step.token : null
  const waitingRelaysKey = step.kind === 'waiting' ? step.relays.join(',') : null

  // Send the pair.claim and listen for the guardian's PAIR_OFFER — opens its
  // own relay pool against the SCANNED QR's relay list (not the app's
  // default `state.app.relays`, which for a still-unpaired device may not
  // even name the same relays the guardian is actually listening on). Sent
  // once per distinct (guardianPk, token, relays) — i.e. once per fresh scan
  // — never re-sent on an unrelated re-render; React 18 StrictMode's dev-only
  // double-invoke sends it twice, which is harmless (the token is single-use
  // — see pairing/tokens.ts — so a guardian that already consumed it from
  // the first send simply drops the second silently).
  useEffect(() => {
    if (waitingGuardianPk === null || waitingToken === null || waitingRelaysKey === null) return
    const relays = waitingRelaysKey.split(',')
    const pool = makePool(relays)

    function sendClaim() {
      const nowSec = Math.floor(Date.now() / 1000)
      void sendRequest(buildPairClaim({ devicePk: device.pk, token: waitingToken!, nowSec }), {
        selfSk: device.sk,
        peerPk: waitingGuardianPk!,
        relay: pool,
        storage: window.localStorage,
        nowSec,
      }).catch(() => {})
    }
    sendClaim()

    const unsubscribe = pool.subscribe({ kinds: [WRAP], '#p': [device.pk] }, (wrap) => {
      const offer = handlePairOfferWrap({ wrap, deviceSk: device.sk, expectedGuardianPk: waitingGuardianPk! })
      if (offer === null) return
      const accepted = acceptPairOffer(offer, waitingGuardianPk!)
      if (accepted === null) return
      setPendingOffer({ offer, guardianPk: waitingGuardianPk!, childSk: accepted.childSk })
      setStep((prev) => offerAccepted(prev))
    })

    return () => {
      unsubscribe()
      pool.close?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingGuardianPk, waitingToken, waitingRelaysKey])

  // The SAS code — async (SHA-256), recomputed whenever the pairing target
  // changes. Same "check these match your parent's screen" copy/decision as
  // the guardian's own PairDevice.tsx (Plan 3 carry-forward: decorative
  // confirm, documented).
  useEffect(() => {
    if (waitingGuardianPk === null || waitingToken === null) {
      setSas(null)
      return
    }
    let cancelled = false
    void sasDigits(waitingGuardianPk, waitingToken).then((s) => {
      if (!cancelled) setSas(s)
    })
    return () => {
      cancelled = true
    }
  }, [waitingGuardianPk, waitingToken])

  function handleScan(text: string): boolean {
    const next = submitScannedText(text)
    setStep(next)
    return next.kind !== 'scan'
  }

  function handlePasteSubmit() {
    handleScan(pasteText)
  }

  function handleFirstPinSubmit() {
    if (!isValidPinFormat(firstPin)) return
    setStep((prev) => submitFirstPin(prev, firstPin))
    setConfirmPinInput('')
  }

  /** The actual join: dispatches `startAsChildFromOffer` (flips `role` to
   *  'child') and unlocks the freshly-sealed sk. Kept as its own function
   *  (rather than inline in `handleConfirmPinSubmit`) because it now has TWO
   *  callers — the ordinary path, and the "Continue" button on the
   *  `rootRejected` interstitial below. */
  function completePairing(pending: PendingOffer): void {
    const nowSec = Math.floor(Date.now() / 1000)
    dispatch({
      type: 'updateApp',
      update: (app) => startAsChildFromOffer(app, pending.offer, pending.guardianPk, nowSec)?.state ?? app,
    })
    unlockChildSk(pending.childSk)
  }

  async function handleConfirmPinSubmit() {
    const result = submitConfirmPin(step, confirmPinInput)
    if (!result.matched) {
      setStep(result.step)
      setFirstPin('')
      setConfirmPinInput('')
      return
    }
    if (pendingOffer === null) return
    setBusy(true)
    setBanner(null)
    try {
      const ok = await sealPin(result.pin, pendingOffer.childSk)
      if (!ok) {
        setBanner('Something went wrong setting your PIN — please try again.')
        setStep(retryPinEntry())
        setFirstPin('')
        setConfirmPinInput('')
        return
      }
      // Pairing is never blocked by a root that will not verify (spec §1.5),
      // but it must not slip past unseen either. This has to be checked
      // BEFORE `completePairing` dispatches `startAsChildFromOffer`: that
      // dispatch flips `role` to 'child', and App.tsx's own role-derived
      // routing swaps this whole screen out for ChildShell the very next
      // render — a banner set only AFTER dispatching would unmount along
      // with everything else here before the child ever saw it (found by
      // review: this used to `setBanner(...)` right after dispatching,
      // which never actually rendered). The `rootRejected` step instead asks
      // for an explicit "Continue" before this device joins at all.
      if (acceptPairOffer(pendingOffer.offer, pendingOffer.guardianPk)?.rootRejected === true) {
        setStep(rootRejectedStep())
        return
      }
      completePairing(pendingOffer)
    } finally {
      setBusy(false)
    }
  }

  function handleRootRejectedContinue(): void {
    if (pendingOffer === null) return
    setBusy(true)
    try {
      completePairing(pendingOffer)
    } finally {
      setBusy(false)
    }
  }

  if (step.kind === 'scan') {
    return (
      <Screen title="Join your family" onBack={onCancel}>
        <p>Ask your parent to show the code on their screen, then point your camera at it.</p>
        {step.error && <Banner tone="bad">{step.error}</Banner>}
        <Card>
          <QRScanner active onScan={handleScan} />
        </Card>
        <div className="qr-scan-divider">or</div>
        <Card>
          <p className="field-label">Paste the code instead</p>
          <textarea
            className="textarea-input"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            aria-label="Pasted pairing code"
            rows={3}
          />
          <Button variant="quiet" block onClick={handlePasteSubmit} disabled={pasteText.trim() === ''}>
            Use this code
          </Button>
        </Card>
      </Screen>
    )
  }

  if (step.kind === 'waiting') {
    return (
      <Screen title="Almost there" onBack={onCancel}>
        <Banner tone="info">Check these match your parent's screen.</Banner>
        <Card>
          <p className="sas-code">{sas ?? '··· ···'}</p>
        </Card>
        <p className="muted" style={{ textAlign: 'center', marginTop: 16 }}>
          Waiting for your parent to finish on their side…
        </p>
        <Button variant="quiet" block onClick={onCancel}>
          Cancel
        </Button>
      </Screen>
    )
  }

  if (step.kind === 'setPin') {
    return (
      <Screen title="Choose a PIN">
        <p>Pick 4 to 8 numbers you'll remember. You'll use this to open the app.</p>
        <Card>
          <PinPad value={firstPin} onChange={setFirstPin} label="Choose a PIN" />
        </Card>
        <Button variant="primary" block onClick={handleFirstPinSubmit} disabled={!isValidPinFormat(firstPin)}>
          Continue
        </Button>
      </Screen>
    )
  }

  if (step.kind === 'confirmPin') {
    return (
      <Screen title="Type it again">
        <p>Just to be sure — type the same numbers again.</p>
        <Card>
          <PinPad value={confirmPinInput} onChange={setConfirmPinInput} label="Confirm your PIN" />
        </Card>
        {banner && <Banner tone="bad">{banner}</Banner>}
        <Button
          variant="primary"
          block
          onClick={() => void handleConfirmPinSubmit()}
          disabled={busy || !isValidPinFormat(confirmPinInput)}
        >
          {busy ? 'Setting up…' : "That's my PIN"}
        </Button>
      </Screen>
    )
  }

  if (step.kind === 'pinMismatch') {
    return (
      <Screen title="Not quite">
        <Banner tone="info">Those didn't match — let's try again.</Banner>
        <Button
          variant="primary"
          block
          onClick={() => {
            setFirstPin('')
            setConfirmPinInput('')
            setStep(retryPinEntry())
          }}
        >
          Try again
        </Button>
      </Screen>
    )
  }

  // step.kind === 'rootRejected'
  return (
    <Screen title="Before you join">
      <Banner tone="bad">Could not verify the family root.</Banner>
      <p className="muted">
        You can still join — if that doesn't look right, check with whoever set this up before continuing.
      </p>
      <Button variant="primary" block onClick={handleRootRejectedContinue} disabled={busy || pendingOffer === null}>
        {busy ? 'Joining…' : 'Continue'}
      </Button>
    </Screen>
  )
}
