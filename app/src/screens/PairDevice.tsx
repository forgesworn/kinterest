// The guardian-side device-pairing screen: QR + SAS code for an existing
// child, TTL countdown, re-mint on expiry or burn, success banner naming
// the paired device. See internal plan 2026-08-11-parent-mode,
// Task 3 — "Child-side scanning is Plan 4 — guardian side only" applies
// here: this screen only ever shows a code and waits, it never scans one.

import { useEffect, useState } from 'react'
import { getPublicKey } from 'nostr-tools/pure'
import { Banner, Button, Card, Screen } from '../components/ui'
import { QRCode } from '../components/QRCode'
import { useApp } from '../store/store'
import { beginPairingSession, reMintPairingSession } from '../store/store'
import type { AnsweredPairClaim } from '../pairing/pairing'
import { qrContent } from '../pairing/pairing'
import { sasDigits } from '../pairing/sas'
import { TOKEN_TTL_SECS } from '../pairing/tokens'
import { sendPairOffer } from '../sync/publish'
import { loadFamilyMnemonic } from '../identity/vault'

/** Seconds remaining on a token minted at `mintedAt`, as of `nowSec`,
 *  floored at 0 — pure, tested directly in PairDevice.test.ts without
 *  mounting the component. */
export function pairingRemainingSecs(mintedAt: number, nowSec: number): number {
  return Math.max(0, TOKEN_TTL_SECS - (nowSec - mintedAt))
}

export function PairDevice({ childPubkey, onDone }: { childPubkey: string; onDone: () => void }) {
  const { state, dispatch, relay, guardianSk, onPairClaimAnsweredRef } = useApp()
  const child = state.app.children.find((c) => c.pubkey === childPubkey) ?? null
  const session = state.pairing

  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  const [banner, setBanner] = useState<string | null>(null)
  const [pairedName, setPairedName] = useState<string | null>(null)
  const [sas, setSas] = useState<string | null>(null)

  // The family mnemonic — needed to derive the claiming device's key
  // (`beginPairingSession`'s `mnemonic` param); never rendered on this
  // screen (see Global Constraints on secrets).
  useEffect(() => {
    let cancelled = false
    void loadFamilyMnemonic().then((m) => {
      if (!cancelled) setMnemonic(m)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Open (or replace) the ceremony for THIS child once prerequisites are
  // ready — but not on every `session` change, which would re-mint on
  // every tick; only when the target child itself changes, or nothing is
  // open yet for it.
  useEffect(() => {
    if (guardianSk === null || mnemonic === null || child === null) return
    if (state.pairing !== null && state.pairing.childIndex === child.index) return
    const started = beginPairingSession(state.app, child.pubkey, mnemonic, state.app.relays, nowSec)
    if (started !== null) {
      setBanner(null)
      setPairedName(null)
      dispatch({ type: 'beginPairing', session: started })
    }
    // Deliberately narrow deps: `state.app`/`nowSec` are read once at the
    // moment this effect actually runs, not tracked for re-runs — see
    // comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardianSk, mnemonic, child?.pubkey])

  // One-second countdown tick.
  useEffect(() => {
    const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Expiry re-mint.
  useEffect(() => {
    if (session === null || session.status !== 'active') return
    if (pairingRemainingSecs(session.token.mintedAt, nowSec) > 0) return
    setBanner("That code expired — here's a fresh one.")
    dispatch({ type: 'beginPairing', session: reMintPairingSession(session, nowSec) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, nowSec])

  // Burn re-mint (a claim was presented and refused — e.g. devicePk
  // mismatch; the token is single-use and now gone either way).
  useEffect(() => {
    if (session === null || session.status !== 'burned') return
    setBanner("Code used — here's a fresh one.")
    dispatch({ type: 'beginPairing', session: reMintPairingSession(session, nowSec) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // SAS digits — async (SHA-256), recomputed whenever the token changes.
  useEffect(() => {
    if (session === null || guardianSk === null) {
      setSas(null)
      return
    }
    let cancelled = false
    void sasDigits(getPublicKey(guardianSk), session.token.token).then((s) => {
      if (!cancelled) setSas(s)
    })
    return () => {
      cancelled = true
    }
  }, [session?.token.token, guardianSk])

  // Register this screen's handler for a successfully-answered pair.claim —
  // see store.tsx's AppContextValue doc comment: the generic provider
  // closes the ceremony either way, but has no child-specific context of
  // its own to send the resulting PAIR_OFFER or name the paired device, so
  // this screen supplies that while mounted.
  useEffect(() => {
    if (guardianSk === null) return
    onPairClaimAnsweredRef.current = (answered: AnsweredPairClaim) => {
      void sendPairOffer(answered.offer, {
        selfSk: guardianSk,
        peerPk: answered.recipientPk,
        relay,
        storage: window.localStorage,
        nowSec: Math.floor(Date.now() / 1000),
      }).catch(() => {})
      setBanner(null)
      setPairedName(answered.offer.name)
    }
    return () => {
      onPairClaimAnsweredRef.current = null
    }
  }, [guardianSk, relay, onPairClaimAnsweredRef])

  // Close the ceremony on unmount however the screen was left (Done,
  // Cancel, back navigation) — `endPairing` is a no-op if already closed
  // (e.g. straight after a successful pair), so this is safe unconditionally.
  useEffect(() => {
    return () => {
      dispatch({ type: 'endPairing' })
    }
  }, [dispatch])

  if (child === null) {
    return (
      <Screen title="Pair a device" onBack={onDone}>
        <Banner tone="bad">That child could not be found.</Banner>
      </Screen>
    )
  }

  const showingCode =
    pairedName === null && session !== null && session.childIndex === child.index && guardianSk !== null

  return (
    <Screen title={`Pair ${child.name}'s device`} onBack={onDone}>
      {pairedName !== null && <Banner tone="good">{pairedName}'s device is now paired.</Banner>}
      {banner !== null && pairedName === null && <Banner tone="info">{banner}</Banner>}
      {showingCode && session !== null && guardianSk !== null && (
        <Card>
          {(() => {
            const content = qrContent({ guardianPk: getPublicKey(guardianSk), relays: session.relays, token: session.token.token })
            return (
              <>
                <QRCode data={content} alt={`Pairing QR code for ${child.name}`} />
                <p className="sas-code">{sas ?? '··· ···'}</p>
                <p className="pairing-expiry">
                  Code expires in {pairingRemainingSecs(session.token.mintedAt, nowSec)}s
                </p>
                {/* Camera-less fallback's OTHER half — ChildOnboarding.tsx's
                   own "Paste the code instead" field needs something to
                   paste FROM. Without a real second camera pointed at this
                   screen (the ordinary case being no camera at all — see
                   scripts/dev-note.md's own two-browser-profile walkthrough,
                   Task 5), this plain-text readout is the only way to get
                   the SAME content the QR encodes onto the pairing device:
                   select it (auto-selected on focus/tap) and copy it across
                   by whatever channel is actually available — a message, a
                   second device's clipboard, or literally retyping it. */}
                <label className="field-label" htmlFor="pairing-code-text">Can't scan? Copy this code instead</label>
                <input
                  id="pairing-code-text"
                  className="text-input pairing-code-text"
                  value={content}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Pairing code text"
                />
              </>
            )
          })()}
        </Card>
      )}
      {!showingCode && pairedName === null && <Banner tone="info">Setting up a pairing code…</Banner>}
      <Button variant="quiet" block onClick={onDone}>
        {pairedName !== null ? 'Done' : 'Cancel'}
      </Button>
    </Screen>
  )
}
