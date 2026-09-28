// The guardian's whole navigable app once onboarding is complete: Home ->
// ChildDetail (-> its own QuickActions sheets, self-contained) ->
// ChildSettings -> PairDevice, and Home -> Approvals. Navigation is a plain
// `useState<Route>` switched through routes.ts's pure, separately-tested
// transition table — no router library, per the plan's own Architecture
// line ("Screens are switched by a `screen` value in component state").
//
// Split out of App.tsx into its own module (default-exported, rather than a
// named function App.tsx declared inline as before) so App.tsx can
// `React.lazy()` it — see App.tsx's own header and this file's sibling,
// ChildShell.tsx, for why: a guardian device should never need to download
// the child-only screens (Ask/Chores/Audit/ChildHome/ChildLock) bundled
// together with this, and vice versa. Plan:
// internal plan 2026-08-11-android-apk, Task 1.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Home } from './Home'
import { ChildDetail } from './ChildDetail'
import { ChildSettings } from './ChildSettings'
import { Approvals } from './Approvals'
import { PairDevice } from './PairDevice'
import { Onboarding } from './Onboarding'
import { StorageBanner } from '../components/StorageBanner'
import { NotificationOptIn } from '../components/NotificationOptIn'
import { Banner, Button } from '../components/ui'
import { useApp } from '../store/store'
import { childNeedingFirstPot } from '../state/state'
import { consumeInitialPendingRoute, onPendingRoute } from '../platform/pendingRoute'
import { addChildStep } from './onboardingFlow'
import {
  addChildRoute,
  approvalsRoute,
  childDetailRoute,
  childSettingsRoute,
  goBack,
  homeRoute,
  pairDeviceRoute,
  type Route,
} from './routes'

// Explicit `: ReactElement` return type (not inferred) — needed for TS to
// actually flag it as an error if a future `Route['screen']` variant is
// added to routes.ts without a matching `case` here: without an ANNOTATED
// return type, an accidentally-non-exhaustive switch just infers
// `ReactElement | undefined` and compiles silently; every case below
// returning `ReactElement` against a DECLARED `ReactElement` return type is
// what makes a missing case a real compile error instead.
export default function GuardianShell(): ReactElement {
  const { state, dispatch } = useApp()
  return (
    <>
      <StorageBanner />
      {state.notice !== null && (
        <Banner tone="info">
          {state.notice}{' '}
          <Button variant="quiet" onClick={() => dispatch({ type: 'clearNotice' })}>
            Dismiss
          </Button>
        </Banner>
      )}
      <NotificationOptIn />
      <GuardianRoutes />
    </>
  )
}

function GuardianRoutes(): ReactElement {
  const { state } = useApp()
  // Computed once, at mount, via the lazy `useState` initializer — not on
  // every navigation. This is deliberately the ONLY place the shell
  // auto-redirects: it covers both a fresh page load AND the moment App.tsx
  // swaps a brand-new family's Onboarding out for this component (its
  // first-ever child, added a moment ago, is exactly a "needs a first pot"
  // child — see childNeedingFirstPot's own doc comment on why the "add
  // another child" path needs its own separate wiring instead, below).
  const [route, setRoute] = useState<Route>(() => {
    // v0.3: a tap on the "New ask from … — tap to decide" notification
    // (cold start — platform/pendingRoute.ts's own header on the
    // cold/warm split) takes priority over the ordinary first-pot redirect
    // below. An explicit tap is a stronger signal of guardian intent than
    // an automatic "you just added a child" nudge, and the two are in
    // practice mutually exclusive anyway — a family with a pending ask
    // already has a child, almost certainly with a pot.
    if (consumeInitialPendingRoute() === 'approvals') return approvalsRoute()
    const needsFirstPot = childNeedingFirstPot(state.app)
    return needsFirstPot !== null ? childSettingsRoute(needsFirstPot.pubkey) : homeRoute()
  })

  // Warm start (v0.3): the Activity and this page are already running
  // (MainActivity's singleTask launchMode means a second notification tap
  // never re-runs the lazy initializer above) — `onPendingRoute` is the
  // native shell's own event for that case. A guardian device has no
  // PIN/lock concept of its own today (store.tsx's `locked` only ever
  // tracks a CHILD device's session; App.tsx's own role/children/revoked
  // gate is the entire reason GuardianShell mounts at all), so there is
  // nothing to wait on here: the moment this effect is live, the shell is
  // exactly as "unlocked" as it is ever going to get. A future guardian
  // lock only has to gate this subscription the same way.
  useEffect(
    () =>
      onPendingRoute((r) => {
        if (r === 'approvals') setRoute(approvalsRoute())
      }),
    [],
  )

  switch (route.screen) {
    case 'home':
      return (
        <Home
          onSelectChild={(childPubkey) => setRoute(childDetailRoute(childPubkey))}
          onApprovals={() => setRoute(approvalsRoute())}
          onAddChild={() => setRoute(addChildRoute())}
        />
      )
    case 'childDetail':
      return (
        <ChildDetail
          childPubkey={route.childPubkey}
          onBack={() => setRoute(goBack(route))}
          onSettings={() => setRoute(childSettingsRoute(route.childPubkey))}
          onPairDevice={() => setRoute(pairDeviceRoute(route.childPubkey))}
        />
      )
    case 'childSettings':
      return (
        <ChildSettings
          childPubkey={route.childPubkey}
          onBack={() => setRoute(goBack(route))}
          onPairDevice={() => setRoute(pairDeviceRoute(route.childPubkey))}
        />
      )
    case 'pairDevice':
      return <PairDevice childPubkey={route.childPubkey} onDone={() => setRoute(goBack(route))} />
    case 'approvals':
      return <Approvals onBack={() => setRoute(goBack(route))} />
    case 'addChild':
      // "Add a child" reuses the SAME add-child ceremony
      // Onboarding.tsx's first-run flow uses (onboardingFlow.ts's
      // `addChildStep`) — the guardian identity and family mnemonic already
      // exist by the time this screen is reachable, so mounting it directly
      // at that step (rather than at `welcomeStep()`) skips straight to "what's
      // their name?". `onAddChildDone` lands on the NEW child's own Settings
      // once they've actually been added, not Home (v0.3) — Onboarding's
      // own step machine has no way to know this route should end, since
      // `app.children.length` is already > 0 both before and after (unlike
      // the first-run path, which App.tsx itself swaps away from the
      // moment the FIRST child lands), and a guardian who has just named a
      // child is prompted straight away to add their first pot, rather
      // than left on Home with a child that has nothing set up yet.
      return <Onboarding initialStep={addChildStep()} onAddChildDone={(childPubkey) => setRoute(childSettingsRoute(childPubkey))} />
  }
}
