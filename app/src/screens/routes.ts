// Pure screen-navigation state machine for the guardian shell: Home ->
// ChildDetail -> ChildSettings -> PairDevice, and Home -> Approvals. See
// internal plan 2026-08-11-parent-mode, Task 7 — "pure
// screen-state machine, tested" — the same shape screens/onboardingFlow.ts
// established for the onboarding ceremony (see that module's own header):
// every transition here is a total, side-effect-free function of the
// CURRENT route (plus whatever a caller supplies, e.g. which child was
// tapped), so screens/GuardianShell.tsx is a thin `useState<Route>` + switch,
// testable with no React/DOM at all. Matches the plan's Architecture line —
// "Screens are switched by a `screen` value in component state (no
// router)".

export type Route =
  | { screen: 'home' }
  | { screen: 'childDetail'; childPubkey: string }
  | { screen: 'childSettings'; childPubkey: string }
  | { screen: 'pairDevice'; childPubkey: string }
  | { screen: 'approvals' }
  | { screen: 'addChild' }

export function homeRoute(): Route {
  return { screen: 'home' }
}

/** Home's "Add a child" entry point — reuses the SAME
 *  add-child step Onboarding.tsx's own first-run ceremony uses
 *  (screens/onboardingFlow.ts's `addChildStep`), just reached from inside
 *  the guardian shell instead of from App.tsx's own `children.length === 0`
 *  gate. `state/onboarding.ts#addChild` always derives the NEXT FREE index
 *  (strictly greater than every index already present, including a
 *  revoked child's), so this is also the correct way to set up a
 *  replacement for a removed device — never "Pair a device" in Settings,
 *  which would reuse that same revoked index. */
export function addChildRoute(): Route {
  return { screen: 'addChild' }
}

/** Home's per-child card, tapped -> that child's account list/feed. */
export function childDetailRoute(childPubkey: string): Route {
  return { screen: 'childDetail', childPubkey }
}

/** ChildDetail's "Settings" entry point. */
export function childSettingsRoute(childPubkey: string): Route {
  return { screen: 'childSettings', childPubkey }
}

/** ChildSettings' "Pair a device" entry point (Task 6). ChildDetail's own
 *  "Pair their phone" (v0.3) opens the same route; `goBack` below always
 *  returns to ChildSettings regardless of which of the two opened it — a
 *  guardian arriving via ChildDetail lands one tap further out than they
 *  came in from, not back on the empty route they started on. */
export function pairDeviceRoute(childPubkey: string): Route {
  return { screen: 'pairDevice', childPubkey }
}

/** Home's "Approvals" entry point. */
export function approvalsRoute(): Route {
  return { screen: 'approvals' }
}

/** Each screen's own "back"/"done"/"cancel" affordance — always returns to
 *  whichever screen would naturally have opened it: ChildDetail -> Home;
 *  ChildSettings -> that same child's ChildDetail; PairDevice -> that same
 *  child's ChildSettings (see `pairDeviceRoute`'s own doc comment on the two
 *  screens that can open it); Approvals -> Home. `home` has no
 *  predecessor of its own — a no-op, a defensive total function for a step
 *  nothing should be able to call it from. */
export function goBack(route: Route): Route {
  switch (route.screen) {
    case 'home':
      return route
    case 'childDetail':
      return homeRoute()
    case 'childSettings':
      return childDetailRoute(route.childPubkey)
    case 'pairDevice':
      return childSettingsRoute(route.childPubkey)
    case 'approvals':
      return homeRoute()
    case 'addChild':
      return homeRoute()
  }
}
