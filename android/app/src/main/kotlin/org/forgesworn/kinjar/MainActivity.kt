package org.forgesworn.kinjar

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.content.pm.PackageInfoCompat
import org.forgesworn.kinjar.service.Notifier
import org.forgesworn.kinjar.service.RelayService
import org.forgesworn.kinjar.web.BundledConsole
import org.forgesworn.kinjar.web.KinjarShellBridge
import org.forgesworn.kinjar.web.UrlGate

/**
 * The Kinjar shell: the web app in a single WebView. All decisions and state
 * live in the web app (its localStorage/IndexedDB at [UrlGate.CONSOLE_ORIGIN]
 * is the same guardian/child identity the browser PWA would hold); this
 * Activity only adds what a browser tab cannot: bundled offline assets, a
 * camera permission bridge for QR pairing, the native lock backstop (see
 * [onStop]), and — via [KinjarShellBridge] — the foreground relay service and
 * family notifications ([RelayService], [Notifier]).
 *
 * Ported from charter/android/carrier/src/main/kotlin/.../MainActivity.kt —
 * this shell still carries no boot receiver; the relay service is started
 * and stopped from the web app's own policy via the bridge, not on boot.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var pendingCameraRequest: PermissionRequest? = null
    private var notificationsPermissionRequested = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // FLAG_SECURE: the recents snapshot is taken at
        // pause/stop, before the web lock screen has painted, so without it
        // the app switcher shows the last unlocked screen (balance, jar,
        // guardian dashboard) to anyone who opens recents. Also blocks
        // screenshots, which is the accepted cost.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        webView = WebView(this)
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        // The identity keys + app state live in localStorage/IndexedDB — required.
        webView.settings.domStorageEnabled = true
        // This WebView never needs file:// content — the console is served
        // entirely from assets via shouldInterceptRequest below, not from a
        // file:// load. Pinned explicitly rather than relying on whatever the
        // platform default happens to be (it has changed across API levels),
        // since file access from a page this app treats as trusted would be a
        // sandbox escape route straight to the device's filesystem.
        webView.settings.allowFileAccess = false
        // https-only origin (UrlGate), and nothing this app serves should ever
        // need to pull in an insecure sub-resource — pinned explicitly rather
        // than trusting the platform default.
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

        // Both channels must exist before anything can post to either —
        // RelayService.onCreate also ensures them, but the bridge's notify()
        // can be called before the service has ever started.
        Notifier.ensureChannels(this)

        // Read the version from the INSTALLED package rather than a build
        // constant: shell.ts's whole reason for asking is "is the shell around
        // this page out of date", so the honest answer is what is actually on
        // the phone. Fails soft — an unreadable package reports empty/0, which
        // shell.ts's shellInfo() already treats the same as a missing
        // version() method entirely.
        val pkg = runCatching { packageManager.getPackageInfo(packageName, 0) }.getOrNull()
        webView.addJavascriptInterface(
            KinjarShellBridge(
                versionName = pkg?.versionName ?: "",
                versionCode = pkg?.let { PackageInfoCompat.getLongVersionCode(it) } ?: 0L,
                onStartRelayService = { RelayService.start(this) },
                onStopRelayService = { RelayService.stop(this) },
                onNotify = { title, body, tag -> Notifier.notify(this, title, body, tag) },
            ),
            KinjarShellBridge.JS_NAME,
        )

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = when (UrlGate.decide(request.url.toString())) {
                // Let the WebView navigate in-app requests itself.
                UrlGate.Verdict.IN_APP -> false
                // The Signet picker: hand off to My Signet or a remote-signer
                // app/browser tab. Only for the main-frame navigation — a
                // sub-frame should never get to pop an external app open.
                // runCatching so a phone with no handler installed for the
                // link doesn't crash — the navigation is still consumed
                // either way. `intent:` URIs are deliberately passed straight
                // through as a plain ACTION_VIEW Uri, NOT parsed with
                // Intent.parseUri — that would hand a page-controlled string
                // a route to launching an arbitrary component; a bare
                // ACTION_VIEW on an unrecognised `intent:` URI just no-ops.
                UrlGate.Verdict.EXTERNAL -> {
                    if (request.isForMainFrame) {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    }
                    true
                }
                // No in-WebView navigation to anything else — block by
                // consuming the navigation and doing nothing with it.
                UrlGate.Verdict.BLOCK -> true
            }

            // Answer console-origin requests from the APK's bundled assets
            // (staged by the `stageConsoleAssets` Gradle task). Same origin, so
            // localStorage/IndexedDB are exactly where they were; only where the
            // bytes come from changes.
            //
            // Fails CLOSED for the console origin: `app.kinjar.local` is a
            // `.local` pseudo-TLD with no real DNS entry for it, so returning
            // null (as BundledConsole.serve does for "not in the bundle") would
            // let the WebView fall through to mDNS resolution for a request
            // this interceptor was supposed to be the only answer to —
            // spoofable on a hostile LAN, and would silently paper over any gap
            // in what `stageConsoleAssets` staged rather than failing loudly.
            // An explicit 404 keeps every in-app request answered from THIS
            // interceptor and nowhere else. Requests outside the console
            // origin are untouched (return null -> normal network handling),
            // same as before.
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? =
                if (UrlGate.decide(request.url.toString()) == UrlGate.Verdict.IN_APP) {
                    BundledConsole.serve(this@MainActivity, request.url.path ?: "")
                        ?: WebResourceResponse(
                            "text/plain",
                            "utf-8",
                            404,
                            "Not Found",
                            emptyMap(),
                            ByteArrayInputStream(ByteArray(0)),
                        )
                } else {
                    null
                }
        }

        // The pairing screen calls getUserMedia to scan a QR. A bare WebView
        // denies that silently (black camera). Bridge it: the page's request is
        // granted ONLY for video capture, ONLY from the console's own origin
        // (defence in depth — UrlGate already keeps every foreign page out of
        // this WebView, but a permission bridge is powerful enough to check
        // twice), and ONLY once Android's own CAMERA runtime permission is held.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsCamera =
                    request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                val fromConsoleOrigin = request.origin.toString().trimEnd('/') == UrlGate.CONSOLE_ORIGIN
                if (!wantsCamera || !fromConsoleOrigin) {
                    request.deny()
                    return
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    // Hold the web request while Android's dialog is answered.
                    pendingCameraRequest = request
                    requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back never leaves the app to the launcher/previous app's UI —
                // it backgrounds this task instead (Task 2: "back → history.back
                // else moveTaskToBack"), matching a normal Android app's back
                // behaviour rather than a browser tab's (which would finish()
                // and drop the Activity's WebView state entirely).
                if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
        })

        webView.loadUrl(UrlGate.CONSOLE_ORIGIN + "/")
    }

    override fun onResume() {
        super.onResume()
        maybeRequestNotificationsPermission()
        // Android 15 stops the dataSync service after 6 h
        // (RelayService.onTimeout); bring it back now that we're foreground,
        // if the web side had asked for it.
        RelayService.restartIfWanted(this)
    }

    /** The service exists only to keep this WebView's JS
     *  running, so it must not outlive it. With configChanges declared,
     *  onDestroy means the Activity is really going, not being recreated. */
    override fun onDestroy() {
        RelayService.stop(this)
        webView.destroy()
        super.onDestroy()
    }

    /**
     * Android 13+ gates notifications behind a runtime permission; without
     * it neither the service's persistent row nor a family update can show.
     * Requested from [onResume] rather than [onCreate], once
     * ([notificationsPermissionRequested]), and only when no camera
     * permission flow is already in flight ([pendingCameraRequest]): only
     * one system permission dialog can be up at a time, so firing this
     * alongside the QR scanner's camera request would silently drop
     * whichever `requestPermissions` call lost the race, leaving that
     * request's caller waiting forever (a black QR scanner, in the camera
     * case). [onRequestPermissionsResult]'s [REQ_NOTIFICATIONS] branch
     * covers the remaining race — a camera request arriving mid-dialog —
     * by replaying it once this one resolves. Fire-and-forget otherwise:
     * the result is not re-prompted (matching charter).
     */
    private fun maybeRequestNotificationsPermission() {
        if (notificationsPermissionRequested) return
        if (pendingCameraRequest != null) return
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        notificationsPermissionRequested = true
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_CAMERA -> {
                val req = pendingCameraRequest
                pendingCameraRequest = null
                val granted = grantResults.isNotEmpty() &&
                    grantResults[0] == PackageManager.PERMISSION_GRANTED
                if (granted) {
                    req?.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    req?.deny()
                }
            }
            REQ_NOTIFICATIONS -> {
                // A camera permission request that arrived while this
                // dialog was showing had its own requestPermissions call
                // dropped (see maybeRequestNotificationsPermission) —
                // pendingCameraRequest being non-null here means that flow
                // is still waiting, so replay it now that the coast is clear.
                if (pendingCameraRequest != null) {
                    requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
                }
            }
        }
    }

    /**
     * Native lock backstop — Task 2 MUST-CARRY (Plan 5 ledger). The web app's
     * own `platform/lockPolicy.ts` grants a WebView session up to 60s of
     * hidden-but-unlocked grace (visibilitychange-driven, covering brief
     * backgrounding: calls, notifications, app switcher; QR scanning via
     * getUserMedia stays in-app), but that grace has no upper bound purely
     * from the page's point of view: Android does not promise `visibilitychange`
     * fires again until the user actually returns, so a task left backgrounded
     * indefinitely (app switcher, swiped away without the process dying) could
     * sit unlocked forever from the page's own accounting.
     *
     * `onStop()` is Android's own stronger signal: it fires once the Activity
     * is no longer visible in ANY way — home button, task switch, screen off,
     * swiped from the recents list — which a bare WebView's `pagehide` does
     * not reliably fire at all. It currently locks immediately (ungraced).
     * Dispatching this event lets the SAME policy module the plain-browser
     * tab uses treat it as an immediate, ungraced lock (see lockPolicy.ts's
     * `NATIVE_STOP_EVENT`); the grace-vs-backstop interplay is to be tuned
     * on-device per the checks in scripts/dev-note.md.
     */
    override fun onStop() {
        super.onStop()
        webView.evaluateJavascript(
            "window.dispatchEvent(new Event('kinjar-native-stop'));",
            null,
        )
    }

    companion object {
        private const val REQ_NOTIFICATIONS = 1
        private const val REQ_CAMERA = 2
    }
}
