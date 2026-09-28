package org.forgesworn.kinjar.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.annotation.RequiresApi
import java.util.concurrent.TimeUnit

/**
 * Foreground service that keeps the process alive so the web app's relay
 * sync can keep running with the Activity backgrounded.
 *
 * Ported in shape (not verbatim) from
 * charter/android/carrier/src/main/kotlin/.../service/CarrierService.kt.
 * Three deliberate departures from charter, each for a reason:
 *  - `foregroundServiceType`: `dataSync`, not `specialUse` — this service
 *    exists to keep a relay sync alive; `dataSync` is the honest declared
 *    type and needs no special-use justification at review.
 *  - A `PARTIAL_WAKE_LOCK` is held for the service's lifetime, timed at
 *    [FGS_CAP_MS] rather than acquired indefinitely — see [onTimeout].
 *  - `startForeground` uses the 3-arg overload with
 *    `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` (targetSdk 36; minSdk is
 *    29, so no version branch is needed).
 *
 * Two Android-enforced limits this class exists to respect (fix round 1):
 *  - A `dataSync` FGS is time-boxed on Android 15+ (6h continuous / 24h in a
 *    rolling window); the system calls [onTimeout] and then kills the app
 *    with `ForegroundServiceDidNotStopInTimeException` if the service has not
 *    stopped within seconds of that callback. [onTimeout] releases the wake
 *    lock and stops. The wake lock itself is acquired with a [FGS_CAP_MS]
 *    timeout (not indefinitely) so it can never outlive that window even if
 *    [onTimeout]/`onDestroy` are somehow skipped.
 *  - Starting a **new** foreground service while the app is backgrounded
 *    throws `ForegroundServiceStartNotAllowedException` on the main looper —
 *    outside any `runCatching` in the JS bridge, i.e. an uncaught crash.
 *    [stop] therefore never calls `startService`/`startForegroundService`
 *    when the service is not already known to be running (`running`, set
 *    only after a successful `startForeground`), since `startService` on a
 *    not-running service would *create* one, whose `onStartCommand` would
 *    then try to enter foreground from the background. `onStartCommand`
 *    itself also wraps `startForeground` in `runCatching` and stops cleanly
 *    on failure rather than leaving a non-foregrounded service running past
 *    its grace window.
 *
 * Honest limitation, recorded in scripts/dev-note.md: this keeps the
 * *process* foregrounded; it does not itself hold the relay socket. A
 * WebView in a stopped Activity still has its JS timers throttled by
 * Android, so background delivery is best-effort and must be checked
 * on-device before it is claimed to work.
 */
class RelayService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kinjar:relay")
            .apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Never (re-)enter foreground on the way out — this branch must
            // stay reachable even for an instance the system just created
            // solely to deliver this Intent (see [stop]'s kdoc).
            stopSelf()
            return START_NOT_STICKY
        }
        val started = runCatching {
            startForeground(
                Notifier.SERVICE_NOTIF_ID,
                Notifier.serviceNotification(this),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        }.isSuccess
        if (!started) {
            running = false
            stopSelf()
            return START_NOT_STICKY
        }
        // Timed, not indefinite — see the class kdoc's onTimeout note. Safe
        // to call again on a repeated start: setReferenceCounted(false)
        // makes a re-acquire just reset the timeout rather than stack.
        wakeLock?.acquire(FGS_CAP_MS)
        running = true
        // NOT sticky: a sticky restart after a process kill
        // brings the service back with no Activity and no WebView, so no JS
        // to keep in touch — just a wake lock and a misleading row.
        return START_NOT_STICKY
    }

    /**
     * Android 15+'s dataSync FGS time-box has been hit. The system now
     * expects this service stopped within seconds — see the class kdoc.
     */
    // VANILLA_ICE_CREAM (API 35), not UPSIDE_DOWN_CAKE (34): the two-argument
    // `onTimeout(startId, fgsType)` is the Android 15 overload — API 34 has
    // only the one-argument `onTimeout(startId)`. Annotating it 34 claims an
    // availability that does not exist and silences lint on the wrong
    // boundary (fix round 2, item M2).
    @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
    override fun onTimeout(startId: Int, fgsType: Int) {
        runCatching { wakeLock?.release() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Swiped from recents: the Activity and its WebView
     *  are gone and React's cleanup never ran, so nothing would ever stop
     *  this. Stop here and forget the web side's request — a relaunch
     *  loads the page afresh and it asks again once a role is set. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        wanted = false
        runCatching { wakeLock?.release() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        running = false
        runCatching { wakeLock?.release() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_STOP = "org.forgesworn.kinjar.STOP"

        /** The Android 15+ dataSync FGS cap the system enforces (6h
         *  continuous) — both the wake lock's own acquire timeout and the
         *  budget [onTimeout] is racing against. */
        private val FGS_CAP_MS = TimeUnit.HOURS.toMillis(6)

        /** Set true only after a successful `startForeground`, false again
         *  in `onDestroy` — see the class kdoc's second bullet. Volatile:
         *  [stop] may be called from any thread via the JS bridge. */
        @Volatile private var running = false

        /** Whether the web side currently wants the service: set by [start], cleared by [stop]. Unlike [running] it
         *  survives Android 15's dataSync [onTimeout], so
         *  [restartIfWanted] can bring the service back when the Activity
         *  returns to the foreground. */
        @Volatile private var wanted = false

        fun start(ctx: Context) {
            wanted = true
            ctx.startForegroundService(Intent(ctx, RelayService::class.java))
        }

        /** Called from MainActivity.onResume: re-issues the start after an
         *  onTimeout stop (or any other stop the web side didn't ask for).
         *  Idempotent — onStartCommand is safe to repeat — and allowed on
         *  Android 15 because the app is in the foreground, which also
         *  resets the dataSync time budget. */
        fun restartIfWanted(ctx: Context) {
            if (wanted && !running) runCatching { start(ctx) }
        }

        /**
         * No-op unless the service is actually running. `startService` on a
         * service that isn't running would *create* one to deliver
         * `ACTION_STOP`, and that fresh instance's `onCreate`/`onStartCommand`
         * would have to reach foreground state (Android requires an FGS
         * `startForeground` shortly after `startForegroundService`, and even
         * a plain `startService` delivering ACTION_STOP still spins up a
         * component within a backgrounded app) — exactly the crash scenario
         * this class exists to avoid. If the service was never running there
         * is nothing to stop.
         */
        fun stop(ctx: Context) {
            wanted = false
            if (!running) return
            ctx.startService(Intent(ctx, RelayService::class.java).setAction(ACTION_STOP))
        }
    }
}
