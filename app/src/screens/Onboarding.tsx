// The onboarding screen — drives screens/onboardingFlow.ts's pure step
// machine and turns each step into real identity: deriving keys, sealing
// the family mnemonic into the vault, dispatching into the store. See
// internal plan 2026-08-11-parent-mode, Task 3.
//
// Guardian identity is committed (vault + `startAsGuardian` dispatch) the
// MOMENT "Set up with a recovery phrase"/a valid restore is confirmed — not
// later, when "I've written these down" is tapped. That way the mnemonic is
// already durably in the vault before it is ever shown on screen: if the device
// dies the instant after the words appear, nothing set up so far is lost.
// The mnemonic-reveal step that follows is then purely a backup ceremony,
// with nothing left to fail.
//
// App.tsx resumes this screen correctly after a reload that landed
// mid-ceremony (guardian role already set, no children yet) via
// `initialStep` — see its own routing.

import { useEffect, useState } from 'react'
import { Banner, Button, Card, Pill, Screen } from '../components/ui'
import { useApp } from '../store/store'
import { generateMnemonic, guardianFromMnemonic, validateMnemonic } from '../identity/derive'
import { addChild, startAsGuardian } from '../state/onboarding'
import { loadFamilyMnemonic, storeFamilyMnemonic, vaultStore } from '../identity/vault'
import { connectSignetRoot, recoverFamilyFromSignet, type SignetRoot } from '../identity/signetConnect'
import { vaultPayloadFor, vaultRosterOf } from '../identity/signetVault'
import { buildResyncRequestPayload } from '../wire/payloads'
import { sendResyncRequest, sendVault } from '../sync/publish'
import type { AppState } from '../state/types'
import {
  addChildStep,
  backToWelcome,
  beginMnemonicReveal,
  beginRestore,
  beginSignetConnect,
  beginSignetRecover,
  confirmMnemonicWritten,
  normalizeMnemonicInput,
  signetFailed,
  signetSucceeded,
  submitRestoreMnemonic,
  welcomeStep,
  type OnboardingStep,
} from './onboardingFlow'

const NO_FAMILY_FOUND = 'We could not find a family backed up to that My Signet account.'
const TOO_MANY_CANDIDATES = 'We found too many backups to check in time — try again, or use your recovery words.'
const CONFLICTING_VAULTS =
  'We found more than one family backup for this My Signet account, so we have not restored either. Please use your recovery words instead. If you did not create a second family, contact support.'
const NEEDS_FULL_SIGNER = 'That sign-in cannot open a backup. Reconnect My Signet and approve encryption access.'
const BACKUP_DEFERRED = 'Backup to My Signet needs a connected My Signet — reconnect from Settings.'
const BACKUP_QUEUED = 'Your backup is queued and will finish when you are back online.'
const ROOT_NOT_REBOUND = 'Your family is back. Reconnect My Signet from Settings to show it on your children\u2019s phones.'
const SIGNIN_FELL_BACK =
  'My Signet sign-in didn\u2019t complete — here are your recovery words instead. You can connect My Signet later from Settings.'
const RECOVERY_CANCELLED = 'Sign-in wasn\u2019t completed — you can try again.'

/** Matches store.tsx's own literal — see that module's doc comment on why
 *  it is kept as a literal rather than re-exported (store.tsx predates this
 *  screen and owns none of onboarding's concerns either). */
const GUARDIAN_SK_NAME = 'guardian-sk'

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
  /** Fired after a successful `addChild` submit, but ONLY meaningful when
   *  this component was mounted at `addChildStep()` with children ALREADY
   *  on the roster (GuardianShell.tsx's own 'addChild' route — U5, UI
   *  audit: "Add a child" from the family home screen, reusing this exact
   *  ceremony at a fresh derivation index). The genuine first-run path
   *  (App.tsx's `children.length === 0` gate) needs no callback of its own —
   *  once that dispatch lands, App.tsx's next render already swaps this
   *  whole component out for GuardianShell (see this module's own header) —
   *  so App.tsx passes nothing here and this stays a no-op for that path. */
  onAddChildDone?: () => void
}) {
  const { state, dispatch, relay } = useApp()
  const [step, setStep] = useState<OnboardingStep>(initialStep)
  const [busy, setBusy] = useState(false)
  const [welcomeError, setWelcomeError] = useState<string | null>(null)
  // A calm, non-blocking note after a sign-in that worked but could not seal
  // the backup (an auth-only session — spec §1.8 step 7).
  const [signetNote, setSignetNote] = useState<string | null>(null)
  const [restoreInput, setRestoreInput] = useState('')
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
  async function commitGuardian(mnemonic: string): Promise<boolean> {
    const { sk } = guardianFromMnemonic(mnemonic)
    try {
      await vaultStore(GUARDIAN_SK_NAME, sk)
      await storeFamilyMnemonic(mnemonic)
    } catch {
      return false
    }
    dispatch({ type: 'updateApp', update: (app) => startAsGuardian(app, mnemonic)?.state ?? app })
    setFamilyMnemonic(mnemonic)
    return true
  }

  async function handleSetUpAsParent() {
    setBusy(true)
    setWelcomeError(null)
    try {
      // Reuse an already-vaulted mnemonic rather than blindly generating a
      // fresh one — guards against this running a second time after an
      // interruption between `commitGuardian`'s vault write and AppState's
      // own persistence (a crash, or `localStorage` cleared independently
      // of IndexedDB) landing `role` back at 'unset' while the vault still
      // holds a real family mnemonic. Without this, tapping "Set up with a
      // recovery phrase" again would overwrite that mnemonic with an
      // unrelated one, silently orphaning any child keys already derived
      // from the original. Ported from the debug App.tsx this screen
      // replaces, which had the identical guard.
      const existing = await loadFamilyMnemonic()
      const mnemonic = existing ?? generateMnemonic()
      const ok = await commitGuardian(mnemonic)
      if (!ok) {
        setWelcomeError('Something went wrong setting up your family — please try again.')
        return
      }
      setStep(beginMnemonicReveal(mnemonic))
    } finally {
      setBusy(false)
    }
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
      // against (U10, UI audit) — a plain `.trim()` here would leave stray
      // capitals/line breaks/double spaces in place, deriving a DIFFERENT
      // (and wrong) key from text that was only ever checked in its
      // normalised form.
      const ok = await commitGuardian(normalizeMnemonicInput(restoreInput))
      setStep(ok ? next : { kind: 'restoreEntry', error: 'Something went wrong restoring your family — please try again.' })
    } finally {
      setBusy(false)
    }
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
        { selfSk: sk, peerPk: root.pubkey, relay, storage: window.localStorage, nowSec },
      )
      return sent
    } catch {
      return false
    }
  }

  function dispatchRoot(root: SignetRoot | null) {
    dispatch({ type: 'updateApp', update: (app) => ({ ...app, root: root ?? { kind: 'phrase' } }) })
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
    setWelcomeError(null)
    setSignetNote(null)
    setBusy(true)
    try {
      const existing = await loadFamilyMnemonic()
      const mnemonic = existing ?? generateMnemonic()
      const { pk } = guardianFromMnemonic(mnemonic)
      const committed = await commitGuardian(mnemonic)
      if (!committed) {
        setStep(signetFailed(connecting, 'Something went wrong setting up your family — please try again.'))
        return
      }

      const connected = await connectSignetRoot({ guardianPk: pk, relayUrls: state.app.relays })
      if (connected === null) {
        // The family is already set up and vaulted by this point, so bouncing
        // back to welcome would leave it with NO backup the user knows about —
        // and "Set up with a recovery phrase" would then re-run the ceremony
        // over the very mnemonic just vaulted. Instead: record a phrase root
        // and show the words. Whatever happened to the sign-in, the user ends
        // up with a family they can actually recover.
        dispatchRoot(null)
        setSignetNote(SIGNIN_FELL_BACK)
        setStep(beginMnemonicReveal(mnemonic))
        return
      }

      if (connected.full) {
        const nowSec = Math.floor(Date.now() / 1000)
        const sent = await publishVault(connected.root, mnemonic, nowSec)
        dispatchRoot(sent ? { ...connected.root, backedUpAt: nowSec } : connected.root)
        if (!sent) setSignetNote(BACKUP_QUEUED)
      } else {
        dispatchRoot(connected.root)
        setSignetNote(BACKUP_DEFERRED)
      }
      setStep(signetSucceeded(connecting))
    } finally {
      setBusy(false)
    }
  }

  /** "I already have a family on My Signet" — spec §1.6's recovery flow. The
   *  mnemonic is vaulted (`commitGuardian`) before anything else, and the
   *  vault's own roster is restored with it (ruling R1) so this device can
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
      // Review R3: authentic backups for more than one family were found.
      // One may have been planted via a phished Signet login, so nothing is
      // restored and the user is sent to their recovery words.
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
          // R1: the roster travels in the vault, so a recovered guardian can
          // ask every child to resync at once instead of waiting an hour for
          // each of them to call in.
          children: got.vault.children.length > 0 ? got.vault.children : app.children,
          relays: got.vault.relays.length > 0 ? got.vault.relays : app.relays,
          root: got.root ?? { kind: 'phrase' },
        }),
      })
      // R1, the other half: the roster is back, so ask every child for a
      // full replay NOW (`since: null` — a recovered device holds no ledger
      // at all) instead of waiting up to an hour for each child's own
      // heartbeat to reveal the gap. Swallowed failures are queued, not
      // lost: `sendResyncRequest` enqueues to the durable outbox first, and
      // the periodic flush carries it out — including against the recovered
      // relay list, once this dispatch has rebuilt the pool.
      const { sk } = guardianFromMnemonic(got.vault.mnemonic)
      for (const restored of got.vault.children) {
        void sendResyncRequest(buildResyncRequestPayload(null), {
          selfSk: sk,
          peerPk: restored.pubkey,
          relay,
          storage: window.localStorage,
          nowSec,
        }).catch(() => {})
      }

      // U8: a restored roster (children.length > 0) swaps the app straight
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

  async function handleAddChildSubmit() {
    const name = childName.trim()
    if (name === '' || familyMnemonic === null) return
    setBusy(true)
    try {
      dispatch({ type: 'updateApp', update: (app) => addChild(app, familyMnemonic, name).state })
      setChildName('')
      onAddChildDone?.()
    } finally {
      setBusy(false)
    }
  }

  if (step.kind === 'welcome') {
    // `welcomeError` is this screen's own (a vault write that failed);
    // `step.error` is a My Signet sign-in bouncing back here (spec §1.8).
    const error = welcomeError ?? step.error ?? null
    return (
      <Screen title="Welcome">
        <div className="onboarding-hero">
          <h2>Jar</h2>
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
        <Card>
          <Button variant="quiet" block onClick={() => void handleSetUpAsParent()} disabled={busy}>
            Set up with a recovery phrase
          </Button>
        </Card>
        <Card>
          <Button variant="quiet" block onClick={() => setStep(beginRestore())} disabled={busy}>
            I have recovery words
          </Button>
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
      </Screen>
    )
  }

  if (step.kind === 'mnemonicReveal') {
    const words = step.mnemonic.split(' ')
    return (
      <Screen title="Write these down">
        {signetNote && <Banner tone="info">{signetNote}</Banner>}
        <Banner tone="info">
          This is the standalone way to back up your family — no My Signet needed. These {words.length} words are
          the only way to recover your family's account. Write them down and keep them somewhere safe — we cannot
          show them to you again after this.
        </Banner>
        <Card>
          <ol className="mnemonic-grid">
            {words.map((word, i) => (
              <li key={i}>
                <span className="mnemonic-index">{i + 1}</span>
                <span className="mnemonic-word">{word}</span>
              </li>
            ))}
          </ol>
        </Card>
        <Button variant="primary" block onClick={() => setStep(confirmMnemonicWritten(step))}>
          I've written these down
        </Button>
      </Screen>
    )
  }

  if (step.kind === 'restoreEntry') {
    return (
      <Screen title="Recovery words" onBack={() => setStep(backToWelcome())}>
        <p>Enter your 12 recovery words, separated by spaces.</p>
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
  // own route (U5, UI audit), which mounts this same step against a roster
  // that already has children on it.
  return (
    <Screen title={state.app.children.length === 0 ? 'Add your first child' : 'Add a child'}>
      {/* U8 (UI audit): a My Signet sign-in/recovery that succeeded but
          couldn't seal the backup (an auth-only session, spec §1.8 step 7)
          previously set this note and moved straight here without ever
          showing it — this was the next step reached, not the ones the
          note was actually rendered on. */}
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
