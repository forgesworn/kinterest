// A small, self-contained control asking the browser for local-notification
// permission from a genuine user tap — `Notification.requestPermission()`
// is ignored (or auto-denied) without one, see
// `platform/shell.ts#requestNotificationPermission`'s own doc comment for
// why that function must only ever be called from a click handler like the
// one below.
//
// Web-build only: inside the Android WebView shell, notifications are
// native and permission is the OS's own concern (the shell's own
// `MainActivity` asks for `POST_NOTIFICATIONS`) — `isShell()` is the one
// gate every shell-only/non-shell-only affordance in this app already uses
// (see platform/shell.ts's own doc comment), so this renders nothing there.
// It also renders nothing where the browser has no `Notification` API at
// all (some in-app browsers, or a WebView not running as the shell).

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Card } from './ui'
import { isShell, requestNotificationPermission } from '../platform/shell'

type Status = NotificationPermission | 'unsupported'

function initialStatus(): Status {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/** `null` whenever there is nothing sensible to show — see this module's
 *  header. Otherwise a one-line card: a plain status line once a decision
 *  has been made (granted/denied), or a "Turn on" button while undecided. */
export function NotificationOptIn(): ReactElement | null {
  const [status, setStatus] = useState<Status>(initialStatus)

  if (isShell() || status === 'unsupported') return null

  async function handleTap(): Promise<void> {
    setStatus(await requestNotificationPermission())
  }

  return (
    <Card>
      <div className="settings-item-top">
        <span>Notifications on this device</span>
        {status === 'granted' && <span className="empty-sub">Turned on</span>}
        {status === 'denied' && <span className="empty-sub">Blocked — check your browser&rsquo;s site settings</span>}
        {status === 'default' && (
          <Button variant="quiet" onClick={() => void handleTap()}>
            Turn on
          </Button>
        )}
      </div>
    </Card>
  )
}
