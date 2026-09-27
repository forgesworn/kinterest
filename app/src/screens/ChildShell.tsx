// A paired child device: locked behind ChildLock until the session is both
// keyed and unlocked (see store/store.tsx's `childSessionReducer`, and
// platform/lockPolicy.ts for exactly when each of those is taken away), then
// the jar home with buttons onto Ask/Chores and the audit ceremony.
//
// Split out of App.tsx into its own module (default-exported, rather than a
// named function App.tsx declared inline as before) so App.tsx can
// `React.lazy()` it — see this file's sibling, GuardianShell.tsx, for the
// full reasoning (a child device should never need to download the
// guardian-only screens, and vice versa). Plan:
// internal plan 2026-08-11-android-apk, Task 1.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { useApp } from '../store/store'
import { StorageBanner } from '../components/StorageBanner'
import { NotificationOptIn } from '../components/NotificationOptIn'
import { ChildLock } from './ChildLock'
import { ChildHome } from './ChildHome'
import { Ask } from './Ask'
import { Chores } from './Chores'
import { Audit } from './Audit'

/** A plain local `useState`, not `screens/routes.ts`'s `Route`/reducer
 *  machinery — that module is the GUARDIAN shell's own navigation state
 *  (Home -> ChildDetail -> ChildSettings -> PairDevice, Home -> Approvals);
 *  the child stack is deliberately minimal (per the plan's "Child routing
 *  additions minimal") and has no back-stack depth beyond "home, or one
 *  screen opened from it", so a bare four-value toggle is the right size —
 *  mirrors GuardianShell's sibling `joiningFamily` toggle in App.tsx. */
export default function ChildShell(): ReactElement {
  const { childSk, locked } = useApp()
  const [route, setRoute] = useState<'home' | 'ask' | 'chores' | 'audit'>('home')
  // Two independent reasons to show the lock screen (v0.2 spec §2.6): no key
  // at all (a fresh launch, or the retention window expired), or a key we
  // still hold behind a locked screen (a briefly backgrounded shell session,
  // which keeps syncing meanwhile).
  let screen: ReactElement
  if (childSk === null || locked) screen = <ChildLock />
  else if (route === 'ask') screen = <Ask onBack={() => setRoute('home')} />
  else if (route === 'chores') screen = <Chores onBack={() => setRoute('home')} />
  else if (route === 'audit') screen = <Audit onBack={() => setRoute('home')} />
  else screen = <ChildHome onAsk={() => setRoute('ask')} onChores={() => setRoute('chores')} onAudit={() => setRoute('audit')} />
  // The notification opt-in only makes sense once the child is actually
  // past ChildLock — asking "turn on notifications?" on the lock screen
  // itself would be a strange first thing to show.
  const unlocked = childSk !== null && !locked
  return (
    <>
      <StorageBanner />
      {unlocked && <NotificationOptIn />}
      {screen}
    </>
  )
}
