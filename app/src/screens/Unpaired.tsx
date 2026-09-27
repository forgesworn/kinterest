// Where a child device lands once its guardian has removed it (v0.2 spec
// §4.5). By the time this renders, the store's `revoked` effect handler has
// already wiped the in-memory key and cleared everything identity/pinLock.ts
// owns on disk — so there is nothing left to sync, sign or unlock, and no
// screen behind this one worth offering a way back to.
//
// Reached by state, not by navigation: App.tsx gates on
// `state/state.ts#selfRevokedAt`, which reads the persisted accounts doc, so
// a removed device lands here again on every subsequent launch rather than
// only in the session the revocation arrived in.
//
// The tone is deliberate. Being removed from the family app is not a thing a
// child did wrong, and the copy must not read as a punishment or an error:
// nothing of theirs is lost, the ledger is still the family's, and setting
// the device up again is a normal thing a parent can do.

import type { ReactElement } from 'react'
import { Button, Card, Screen } from '../components/ui'
import { clearState } from '../state/persist'
import { emptyState } from '../state/state'
import { clearOutbox } from '../wire/outbox'
import { useApp } from '../store/store'

export function Unpaired(): ReactElement {
  const { dispatch } = useApp()

  // Three things, and all three are needed.
  //
  //  - `clearOutbox` — the outbox lives under its OWN storage key and holds
  //    fully SEALED wraps. Left behind, the next engine start would republish
  //    days of them to a family that removed this device (fix round 1).
  //  - `clearState` — the durable state blob: the removal, the roster, the
  //    ledger, this device's own pairing.
  //  - the `emptyState()` dispatch — resets the live reducer, so the very
  //    next render is the role-choice screen a brand new install sees
  //    (App.tsx's `role === 'unset'` branch). Without it the store's own
  //    save-on-change effect would simply write the old state back out.
  //
  // There is deliberately no Signet logout here: `signet-login` is reached
  // only from Onboarding.tsx and ChildSettings.tsx, both GUARDIAN screens, so
  // a child device never holds a Signet session to clear. The key material
  // this device DID hold is already gone by the time this screen renders —
  // store.tsx's `revoked` handler wipes it from memory and calls
  // `identity/pinLock.ts#clearPin` for the disk half.
  function startAgain(): void {
    clearOutbox()
    clearState()
    dispatch({ type: 'updateApp', update: () => emptyState() })
  }

  return (
    <Screen title="Signed out">
      <Card>
        <p>Your parent removed this device from the family. Nothing you did is lost — ask them to set it up again.</p>
        <Button variant="primary" block onClick={startAgain}>
          Start again
        </Button>
      </Card>
    </Screen>
  )
}
