// Root routing: role gate -> Onboarding | GuardianShell | ChildShell. See
// internal plan 2026-08-11-parent-mode, Task 7 — "final
// routing: role gate -> Onboarding | Home stack".
//
// Routing is entirely state-derived (AppState's `role`/`children`, read via
// `useApp()`) rather than imperative navigation callbacks: once
// `Onboarding` dispatches a guardian identity or a first child into the
// store, this component's own next render already lands on the right
// screen — see Onboarding.tsx's header comment for why it therefore needs
// no "on complete" callback of its own. `initialStep: addChildStep()`
// resumes a reload that landed after guardian setup but before a first
// child exists, rather than restarting the whole ceremony.
//
// GuardianShell/ChildShell themselves now live in their own modules
// (screens/GuardianShell.tsx, screens/ChildShell.tsx — see either file's
// header for the navigation shape each owns) and are loaded here via
// `React.lazy()` rather than a plain import — Task 1 of
// internal plan 2026-08-11-android-apk: "code-split App.tsx at
// the guardian/child seam". Once `app.role` settles onto 'guardian' or
// 'child' it never changes back (see state/types.ts), so a device only ever
// needs ONE of the two shells' worth of screens for the rest of its life —
// this way a guardian's bundle never has to download
// Ask/Chores/Audit/ChildHome/ChildLock, and a child device's bundle never
// downloads Home/ChildDetail/ChildSettings/Approvals/PairDevice. Onboarding
// and ChildOnboarding stay eagerly imported below: both are needed
// immediately, before `app.role` has settled onto anything, so lazy-loading
// them would only add a loading flash with no bundle ever avoided.

import { lazy, Suspense, useState } from 'react'
import { AppProvider, useApp } from './store/store'
import { Onboarding } from './screens/Onboarding'
import { ChildOnboarding } from './screens/ChildOnboarding'
import { Unpaired } from './screens/Unpaired'
import { addChildStep } from './screens/onboardingFlow'
import { guardianNeedsSignet } from './identity/guardianAccess'
import { selfRevokedAt } from './state/state'

const GuardianShell = lazy(() => import('./screens/GuardianShell'))
const GuardianSignetGate = lazy(() => import('./screens/ChildSettings').then(m => ({ default: m.GuardianSignetGate })))
const ChildShell = lazy(() => import('./screens/ChildShell'))

export function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  )
}

function AppShell() {
  const { state } = useApp()
  const { app } = state
  // A device with no role yet chooses between setting up as the family's
  // guardian (Onboarding's own welcome step) or joining an existing family
  // as a child (ChildOnboarding, Plan 4 Task 2) — a plain local toggle
  // rather than a `Route`/reducer concern, since it only ever matters before
  // `app.role` itself has settled onto anything (once it has, this whole
  // branch stops rendering and the toggle's value no longer matters).
  const [joiningFamily, setJoiningFamily] = useState(false)

  if (app.role === 'unset') {
    return joiningFamily ? (
      <ChildOnboarding onCancel={() => setJoiningFamily(false)} />
    ) : (
      <Onboarding onJoinFamily={() => setJoiningFamily(true)} />
    )
  }
  if (guardianNeedsSignet(app)) return <Suspense fallback={null}><GuardianSignetGate /></Suspense>
  if (app.role === 'guardian' && app.children.length === 0) return <Onboarding initialStep={addChildStep()} />

  // A child device its guardian has removed (v0.2 spec §4.5). Gated on state,
  // not on a one-shot navigation from the store's `revoked` effect handler:
  // the revocation rides the persisted accounts doc, so this must hold across
  // reloads too. Deliberately ABOVE the ChildShell branch — ChildShell would
  // otherwise show ChildLock (the key has been wiped), asking for a PIN that
  // no longer exists to unlock a device nothing will sync with again.
  //
  // Eagerly imported, unlike the two shells: it is tiny, and a device that
  // reaches it has just had its key taken away — a lazy chunk fetch is the
  // last thing that should stand between it and an explanation.
  if (selfRevokedAt(app) !== null) return <Unpaired />

  // Lazy-loaded past this point (see this module's own header). `fallback={
  // null}` rather than a spinner: both chunks are small next to the vendor
  // chunk already loaded to get this far (Task 1's own build measurements),
  // so a bare loading flash is imperceptible in practice, and a bespoke
  // splash risks being MORE visible than the gap it's covering for.
  return (
    <Suspense fallback={null}>
      {app.role === 'guardian' ? <GuardianShell /> : <ChildShell />}
    </Suspense>
  )
}
