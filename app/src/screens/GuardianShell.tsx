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

import { useState } from 'react'
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
  const [route, setRoute] = useState<Route>(homeRoute())

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
      // their name?". `onAddChildDone` returns to Home once the new child has
      // actually been added — Onboarding's own step machine has no way to
      // know this route should end, since `app.children.length` is already
      // > 0 both before and after (unlike the first-run path, which App.tsx
      // itself swaps away from the moment the FIRST child lands).
      return <Onboarding initialStep={addChildStep()} onAddChildDone={() => setRoute(homeRoute())} />
  }
}
