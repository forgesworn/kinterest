import { dataStorage } from '../platform/dataStorage'
// The onboarding screen — drives screens/onboardingFlow.ts's pure step
// machine and turns each step into real identity: deriving keys, sealing
// the family mnemonic into the vault, dispatching into the store, and
// binding a root to My Signet. See internal plan 2026-08-11-parent-mode,
// Task 3, and the v0.3 "My Signet is mandatory for guardians" change.
//
// Guardian identity is committed (vault + `startAsGuardian` dispatch) the
// MOMENT a Signet sign-in/recovery starts, or a recovery-words restore is
// confirmed — never later. The family mnemonic itself is never shown on
// this screen: "Sign in with My Signet" generates and vaults it silently
// (spec §1.2), and it stays viewable only as an advanced, clearly optional
// action from Settings ("Show recovery words") — nothing here nags a
// guardian to write anything down. The standalone mnemonic-ceremony setup
// path is not reachable from this screen's UI at all any more — existing
// families already set up that way keep working unchanged (this only
// changes onboarding).
//
// Recovery words remain a fallback, but only INSIDE the Signet recovery
// path: when "I already have a family on My Signet" cannot find or pick a
// vault, the screen offers restoring from words instead, worded as
// optional (the guardian may never have looked at Settings to save them).
// That restore is bound back to the SAME signed-in Signet session —
// `connectAndSealSignetRoot` below, shared with the ordinary sign-in path.
//
// App.tsx resumes this screen correctly after a reload that landed with the
// guardian role already set but no children yet, via `initialStep` — see
// its own routing.

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Card, Pill, Screen } from '../components/ui'
import { useApp } from '../store/store'
import { generateMnemonic, guardianFromMnemonic, validateMnemonic } from '../identity/derive'
import { addChild, startAsGuardian } from '../state/onboarding'
import { loadFamilyMnemonic, storeFamilyMnemonic, vaultStore } from '../identity/vault'
import {
  connectSignetRoot,
  recoverFamilyFromSignet,
  type ConnectedRoot,
  type SignetRoot,
} from '../identity/signetConnect'
import { vaultPayloadFor, vaultRosterOf } from '../identity/signetVault'
import { buildResyncRequestPayload } from '../wire/payloads'
import { sendResyncRequest, sendVault } from '../sync/publish'
import type { AppState } from '../state/types'
import {
  addChildStep,
  backToWelcome,
  beginRestore,
  beginSignetConnect,
  beginSignetRecover,
  normalizeMnemonicInput,
  signetFailed,
  signetSucceeded,
  submitRestoreMnemonic,
  welcomeStep,
  type OnboardingStep,
} from './onboardingFlow'

const NO_FAMILY_FOUND = 'We could not find a family backed up to that My Signet account.'
const TOO_MANY_CANDIDATES = 'We found too many backups to check in time — try again in a moment.'
const CONFLICTING_VAULTS =
  'We found more than one family backup for this My Signet account, so we have not restored either. If you did not create a second family, contact support.'
const NEEDS_FULL_SIGNER = 'That sign-in cannot open a backup. Reconnect My Signet and approve encryption access.'
const BACKUP_DEFERRED = 'Backup to My Signet needs a connected My Signet — reconnect from Settings.'
const BACKUP_QUEUED = 'Your backup is queued and will finish when you are back online.'
const ROOT_NOT_REBOUND = 'Your family is back. Reconnect My Signet from Settings to show it on your children’s phones.'
// Deliberately says nothing about recovery words: a guardian on the Signet
// path was never asked to look at them, so a failed/incomplete sign-in must
// not turn into a nag to go and write them down. The family is already set
// up and vaulted by this point regardless.
const SIGNIN_INCOMPLETE =
  'My Signet sign-in didn’t finish. Sign in to continue setting up your family.'
const RECOVERY_CANCELLED = 'Sign-in wasn’t completed — you can try again.'
// Framed as optional, not a requirement — plenty of guardians will never
// have looked at Settings' "Show recovery words" before hitting this.
const WORDS_FALLBACK_HINT = 'If you saved recovery words from Settings, you can use them instead.'

/** Matches store.tsx's own literal — see that module's doc comment on why
 *  it is kept as a literal rather than re-exported (store.tsx predates this
 *  screen and owns none of onboarding's concerns either). */
const GUARDIAN_SK_NAME = 'guardian-sk'

/** Whether a `signetRecovering` error is one where nothing was set up yet
 *  but a usable-looking backup might still exist elsewhere — as opposed to
 *  `NEEDS_FULL_SIGNER` (the session itself can't decrypt: retrying, not
 *  recovery words, is the fix) or a cancelled picker. */
function offersWordsFallback(error: string): boolean {
  return error === NO_FAMILY_FOUND || error === TOO_MANY_CANDIDATES || error === CONFLICTING_VAULTS
}

export function Onboarding({
  initialStep = welcomeStep(),
  onJoinFamily,
  onAddChildDone,
}: {
  initialStep?: OnboardingStep
  /** "Join your family" tapped on the welcome step — a CHILD device pairing
   *  to an existing family, not this screen's own concern (see
   *  screens/ChildOnboarding.tsx, Plan 4 Task 2). Optional so this component
   *  stays mountable/testable without it; App.tsx always supplies it. */
  onJoinFamily?: () => void
  /** Fired with the new child's pubkey after a successful `addChild`
   *  submit, but ONLY meaningful when this component was mounted at
   *  `addChildStep()` with children ALREADY on the roster (GuardianShell.tsx's
   *  own 'addChild' route: "Add a child" from the family home screen,
   *  reusing this exact ceremony at a fresh derivation index) — wired to
   *  land the guardian straight on that child's Settings (v0.3), so they
   *  are prompted to add a first pot rather than left on Home. The genuine
   *  first-run path (App.tsx's `children.length === 0` gate) needs no
   *  callback of its own — once that dispatch lands, App.tsx's next render
   *  already swaps this whole component out for GuardianShell, whose own
   *  initial route makes the same "prompt for a first pot" call itself
   *  (see GuardianShell.tsx) — so App.tsx passes nothing here and this
   *  stays a no-op for that path. */
  onAddChildDone?: (childPubkey: string) => void
}) {
  const { state, dispatch, relay } = useApp()
  const [step, setStep] = useState<OnboardingStep>(initialStep)
  const [busy, setBusy] = useState(false)
  // A calm, non-blocking note after a sign-in that worked but could not seal
  // the backup (an auth-only session — spec §1.8 step 7).
  const [signetNote, setSignetNote] = useState<string | null>(null)
  const [restoreInput, setRestoreInput] = useState('')
  // Set only by "Use recovery words instead" on a `signetRecovering`
  // failure — marks that the words about to be submitted must be bound back
  // to that same signed-in Signet session once they validate, rather than
  // left on a bare phrase root. Cleared on any way back to welcome.
  const [restoreSignetBound, setRestoreSignetBound] = useState(false)
  const [childName, setChildName] = useState('')
  // Kept only in memory (never in AppState — see Global Constraints): the
  // `addChild` step needs it to derive the new child's key. Resuming
  // straight into `addChild` after a reload (no fresh/restore step run in
  // THIS session) loads it back from the vault below.
  const [familyMnemonic, setFamilyMnemonic] = useState<string | null>(null)

  useEffect(() => {
    if (step.kind !== 'addChild' || familyMnemonic !== null) return
    let cancelled = false
    void loadFamilyMnemonic().then((m) => {
      if (!cancelled) setFamilyMnemonic(m)
    })
    return () => {
      cancelled = true
    }
  }, [step.kind, familyMnemonic])

  /** Derives the guardian's keypair from `mnemonic`, vaults both, and folds
   *  `startAsGuardian` into the store via an `updateApp` updater (never a
   *  precomputed whole state — see store.tsx's `storeReducer` doc comment).
   *  `startAsGuardian` is deterministic in `mnemonic`, so calling it once
   *  here (via `guardianFromMnemonic`, for the vault) and again fresh
   *  inside the updater is safe and side-effect-free either way. Returns
   *  whether it succeeded. */
  async function vaultGuardian(mnemonic: string): Promise<boolean> {
    const { sk } = guardianFromMnemonic(mnemonic)
    try {
      await vaultStore(GUARDIAN_SK_NAME, sk)
      await storeFamilyMnemonic(mnemonic)
    } catch {
      return false
    }
    return true
  }

  async function commitGuardian(mnemonic: string): Promise<boolean> {
    if (!await vaultGuardian(mnemonic)) return false
    dispatch({ type: 'updateApp', update: (app) => startAsGuardian(app, mnemonic)?.state ?? app })
    setFamilyMnemonic(mnemonic)
    return true
  }

  /** Seals the family mnemonic to the My Signet identity and reports whether
   *  it actually left the outbox. `nowSec` is the caller's, per Global
   *  Constraints. */
  //
  // Takes the whole ROOT, not just its pubkey: the vault must carry the
  // root's own kind-21236 attestation (item C1), and a signature over a
  // pubkey is not something a caller can reconstruct from the pubkey.
  async function publishVault(root: SignetRoot, mnemonic: string, nowSec: number): Promise<boolean> {
    try {
      const { sk, pk } = guardianFromMnemonic(mnemonic)
      const { sent } = await sendVault(
        vaultPayloadFor(vaultRosterOf(state.app), mnemonic, pk, root.authEvent, nowSec),
        { selfSk: sk, peerPk: root.pubkey, relay, storage: dataStorage(), nowSec },
      )
      return sent
    } catch {
      return false
    }
  }

  function dispatchRoot(root: SignetRoot | null) {
    dispatch({ type: 'updateApp', update: (app) => ({ ...app, root: root ?? { kind: 'phrase' } }) })
  }

  /** Runs a My Signet login and, on success, seals `mnemonic` to it — the
   *  exact steps "Sign in with My Signet" takes once the guardian is
   *  committed. Shared with the recovery-words fallback so a family restored
   *  from words after a Signet recovery miss is bound to that SAME
   *  signed-in session, never left on a bare phrase root. Returns the
   *  connected root, or `null` if the login itself did not complete — the
   *  caller decides what that means for its own step (it never means
   *  showing the mnemonic: nothing here does that). */
  async function connectAndSealSignetRoot(mnemonic: string, guardianPk: string): Promise<ConnectedRoot | null> {
    const connected = await connectSignetRoot({ guardianPk, relayUrls: state.app.relays })
    if (connected === null) return null
    if (connected.full) {
      const nowSec = Math.floor(Date.now() / 1000)
      const sent = await publishVault(connected.root, mnemonic, nowSec)
      dispatchRoot(sent ? { ...connected.root, backedUpAt: nowSec } : connected.root)
      if (!sent) setSignetNote(BACKUP_QUEUED)
    } else {
      dispatchRoot(connected.root)
      setSignetNote(BACKUP_DEFERRED)
    }
    return connected
  }

  /**
   * "Sign in with My Signet" — spec §1.8, and the step ORDER is the whole
   * point: the challenge binds the attestation to the guardian device key, so
   * the key has to exist and be vaulted BEFORE the picker opens. An
   * interrupted login then costs nothing but the login.
   */
  async function handleSignetConnect() {
    const connecting = beginSignetConnect()
    setStep(connecting)
    setSignetNote(null)
    setBusy(true)
    try {
      const existing = await loadFamilyMnemonic()
      const mnemonic = existing ?? generateMnemonic()
      const { pk } = guardianFromMnemonic(mnemonic)
      const committed = await vaultGuardian(mnemonic)
      if (!committed) {
        setStep(signetFailed(connecting, 'Something went wrong setting up your family — please try again.'))
        return
      }

      const connected = await connectAndSealSignetRoot(mnemonic, pk)
      if (connected === null) {
        setStep(signetFailed(connecting, SIGNIN_INCOMPLETE))
        return
      }
      if (!await commitGuardian(mnemonic)) {
        setStep(signetFailed(connecting, 'Something went wrong saving your family — please try again.'))
        return
      }
      setStep(signetSucceeded(connecting))
    } finally {
      setBusy(false)
    }
  }

  /** "I already have a family on My Signet" — spec §1.6's recovery flow. The
   *  mnemonic is vaulted (`commitGuardian`) before anything else, and the
   *  vault's own roster is restored with it so this device can
   *  reach every child immediately rather than waiting for a heartbeat. */
  async function handleSignetRecover() {
    const recovering = beginSignetRecover()
    setStep(recovering)
    setBusy(true)
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const got = await recoverFamilyFromSignet({ relay, relayUrls: state.app.relays, nowSec })
      if (got === 'needs-full-signer') {
        setStep(signetFailed(recovering, NEEDS_FULL_SIGNER))
        return
      }
      if (got === 'cancelled') {
        setStep(signetFailed(recovering, RECOVERY_CANCELLED))
        return
      }
      if (got === 'no-vault') {
        setStep(signetFailed(recovering, NO_FAMILY_FOUND))
        return
      }
      // `recoveryMiss(truncated)` (identity/signetConnect.ts) — some usable
      // vault may exist, but the hunt hit its own bound/deadline before
      // opening every wrap on offer, so this must stay distinct from
      // `no-vault`'s "definitely nothing there" copy: retrying (or falling
      // back to recovery words) can still succeed here.
      if (got === 'too-many-candidates') {
        setStep(signetFailed(recovering, TOO_MANY_CANDIDATES))
        return
      }
      // Authentic backups for more than one family were found.
      // One may have been planted via a phished Signet login, so nothing is
      // restored and the user is offered their recovery words instead.
      if (got === 'conflicting-vaults') {
        setStep(signetFailed(recovering, CONFLICTING_VAULTS))
        return
      }

      const committed = await commitGuardian(got.vault.mnemonic)
      if (!committed) {
        setStep(signetFailed(recovering, 'Something went wrong restoring your family — please try again.'))
        return
      }
      dispatch({
        type: 'updateApp',
        update: (app): AppState => ({
          ...app,
          // The roster travels in the vault, so a recovered guardian can
          // ask every child to resync at once instead of waiting an hour for
          // each of them to call in.
          children: got.vault.children.length > 0 ? got.vault.children : app.children,
          relays: got.vault.relays.length > 0 ? got.vault.relays : app.relays,
          root: got.root ?? { kind: 'phrase' },
        }),
      })
      // The roster is back, so ask every child for a
      // full replay NOW (`since: null` — a recovered device holds no ledger
      // at all) instead of waiting up to an hour for each child's own
      // heartbeat to reveal the gap. Swallowed failures are queued, not
      // lost: `sendResyncRequest` enqueues to the durable outbox first, and
      // the periodic flush carries it out — including against the recovered
      // relay list, once this dispatch has rebuilt the pool.
      const { sk } = guardianFromMnemonic(got.vault.mnemonic)
      for (const restored of got.root === null ? [] : got.vault.children) {
        void sendResyncRequest(buildResyncRequestPayload(null), {
          selfSk: sk,
          peerPk: restored.pubkey,
          relay,
          storage: dataStorage(),
          nowSec,
        }).catch(() => {})
      }

      // A restored roster (children.length > 0) swaps the app straight
      // to GuardianShell, unmounting this screen and its local `signetNote`
      // with it — so hand the note to the store as a one-off notice too,
      // which GuardianShell shows once, dismissably.
      if (got.root === null) {
        setSignetNote(ROOT_NOT_REBOUND)
        if (got.vault.children.length > 0) dispatch({ type: 'setNotice', notice: ROOT_NOT_REBOUND })
      }
      setStep(signetSucceeded(recovering))
    } finally {
      setBusy(false)
    }
  }

  /** "Use recovery words instead" on a `signetRecovering` failure that
   *  offers it (see `offersWordsFallback`). Marks the restore that follows
   *  as needing to bind back to the Signet session once the words validate
   *  — see `handleRestoreSubmit`. */
  function handleUseWordsInstead() {
    setRestoreSignetBound(true)
    setStep(beginRestore())
  }

  async function handleRestoreSubmit() {
    const next = submitRestoreMnemonic(step, restoreInput, validateMnemonic)
    if (next.kind === 'restoreEntry') {
      setStep(next)
      return
    }
    setBusy(true)
    try {
      // The SAME normalisation `submitRestoreMnemonic` just validated
      // against — a plain `.trim()` here would leave stray
      // capitals/line breaks/double spaces in place, deriving a DIFFERENT
      // (and wrong) key from text that was only ever checked in its
      // normalised form.
      const mnemonic = normalizeMnemonicInput(restoreInput)
      const ok = await vaultGuardian(mnemonic)
      if (!ok) {
        setStep({ kind: 'restoreEntry', error: 'Something went wrong restoring your family — please try again.' })
        return
      }
      const { pk } = guardianFromMnemonic(mnemonic)
      const connected = await connectAndSealSignetRoot(mnemonic, pk)
      if (connected === null) {
        setStep({ kind: 'restoreEntry', error: SIGNIN_INCOMPLETE })
        return
      }
      if (!await commitGuardian(mnemonic)) {
        setStep({ kind: 'restoreEntry', error: 'Something went wrong saving your family — please try again.' })
        return
      }
      setStep(next)
    } finally {
      setBusy(false)
    }
  }

  // Captured inside the dispatched updater — `addChild` derives the new
  // child's pubkey from `nextFreeChildIndex(app.children)` (state/onboarding.ts),
  // which must read the REDUCER's own current roster, not a stale
  // render-time snapshot (the same reasoning store.tsx#stampConfigDoc's own
  // CAUTION spells out for `issuedAt`) — so the pubkey `onAddChildDone`
  // needs is only known once that updater has actually run. Drained by the
  // effect below once the commit has landed.
  const pendingAddedChildRef = useRef<string | null>(null)

  async function handleAddChildSubmit() {
    const name = childName.trim()
    if (name === '' || familyMnemonic === null) return
    setBusy(true)
    try {
      dispatch({
        type: 'updateApp',
        update: (app) => {
          const result = addChild(app, familyMnemonic, name)
          pendingAddedChildRef.current = result.child.pubkey
          return result.state
        },
      })
      setChildName('')
    } finally {
      setBusy(false)
    }
  }

  // v0.3: prompts the guardian to add the new child's first pot (account)
  // straight away, rather than landing back on a child with nothing set up
  // — see `onAddChildDone`'s own doc comment on why this only fires for the
  // "add another child" path.
  useEffect(() => {
    const pubkey = pendingAddedChildRef.current
    if (pubkey === null) return
    pendingAddedChildRef.current = null
    onAddChildDone?.(pubkey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.app])

  if (step.kind === 'welcome') {
    const error = step.error ?? null
    return (
      <Screen title="Welcome">
        <div className="onboarding-hero">
          <h2>Kinterest</h2>
          <p>A shared purse for your family — one secure sign-in across all your family's apps.</p>
        </div>
        {error && <Banner tone="bad">{error}</Banner>}
        {signetNote && <Banner tone="info">{signetNote}</Banner>}
        <Card>
          <div className="pill-row">
            <Pill tone="good">Recommended</Pill>
          </div>
          <Button variant="primary" block onClick={() => void handleSignetConnect()} disabled={busy}>
            Sign in with My Signet
          </Button>
          <p className="card-sub">One login for your whole family's apps — nothing extra to write down.</p>
        </Card>
        <Card>
          <Button variant="quiet" block onClick={() => void handleSignetRecover()} disabled={busy}>
            I already have a family on My Signet
          </Button>
          <p className="card-sub">Bring back a family you set up on another phone.</p>
        </Card>
        {onJoinFamily && (
          <Card>
            <Button variant="quiet" block onClick={onJoinFamily} disabled={busy}>
              Join your family
            </Button>
          </Card>
        )}
      </Screen>
    )
  }

  if (step.kind === 'signetConnecting') {
    return (
      <Screen title="Connecting My Signet">
        <Card>
          <p>Approve the sign-in on My Signet. This window will move on by itself.</p>
        </Card>
      </Screen>
    )
  }

  if (step.kind === 'signetRecovering') {
    return (
      <Screen title="Finding your family" onBack={busy ? undefined : () => setStep(backToWelcome())}>
        <Card>
          <p>Sign in to My Signet, then we will look for your family's backup. This can take a few seconds.</p>
        </Card>
        {step.error && <Banner tone="bad">{step.error}</Banner>}
        {step.error && (
          <Button variant="quiet" block onClick={() => void handleSignetRecover()} disabled={busy}>
            Try again
          </Button>
        )}
        {step.error && offersWordsFallback(step.error) && (
          <>
            <Button variant="quiet" block onClick={handleUseWordsInstead} disabled={busy}>
              Use recovery words instead
            </Button>
            <p className="card-sub">{WORDS_FALLBACK_HINT}</p>
          </>
        )}
      </Screen>
    )
  }

  if (step.kind === 'restoreEntry') {
    return (
      <Screen
        title="Recovery words"
        onBack={() => {
          setRestoreSignetBound(false)
          setStep(backToWelcome())
        }}
      >
        <p>Enter your 12 recovery words, separated by spaces.</p>
        {restoreSignetBound && (
          <Banner tone="info">These will be linked to the My Signet account you just signed in with.</Banner>
        )}
        <textarea
          className="textarea-input"
          value={restoreInput}
          onChange={(e) => setRestoreInput(e.target.value)}
          aria-label="Recovery words"
          rows={4}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
        />
        {step.error && <Banner tone="bad">{step.error}</Banner>}
        <Button
          variant="primary"
          block
          onClick={() => void handleRestoreSubmit()}
          disabled={busy || restoreInput.trim() === ''}
        >
          Continue
        </Button>
      </Screen>
    )
  }

  // step.kind === 'addChild' — title/copy differ between the genuine
  // first-run ceremony and "Add a child" reached later from GuardianShell's
  // own route, which mounts this same step against a roster
  // that already has children on it.
  return (
    <Screen title={state.app.children.length === 0 ? 'Add your first child' : 'Add a child'}>
      {/* A My Signet sign-in/recovery that succeeded but
          couldn't seal the backup (an auth-only session, spec §1.8 step 7),
          or didn't complete at all, previously set this note and moved
          straight here without ever showing it — this was the next step
          reached, not the one the note was actually rendered on. */}
      {signetNote && <Banner tone="info">{signetNote}</Banner>}
      <p>What's their name?</p>
      <input
        className="text-input"
        value={childName}
        onChange={(e) => setChildName(e.target.value)}
        aria-label="Child's name"
        placeholder="Child's name"
      />
      <Button
        variant="primary"
        block
        onClick={() => void handleAddChildSubmit()}
        disabled={busy || childName.trim() === '' || familyMnemonic === null}
      >
        Add child
      </Button>
    </Screen>
  )
}
