package org.forgesworn.kinjar.web

import android.webkit.JavascriptInterface

/**
 * `window.KinjarShell` — what the web app sees. See
 * app/src/platform/shell.ts (`isShell()`, `shellInfo()`): that module reads
 * `window.KinjarShell` defensively (its absence just means "not the shell"),
 * and parses this bridge's [version] as `{"versionName":…,"versionCode":…}`.
 *
 * Exposure is safe ONLY because [UrlGate] keeps every foreign origin out of
 * this WebView — an `addJavascriptInterface` bridge is reachable by ANY page
 * the WebView loads, not just the one it was meant for.
 */
class KinjarShellBridge(
    /** THIS shell's own version — read from the installed package in
     *  MainActivity, not a compile-time constant, so it can only ever report
     *  what is actually on the phone (mirrors charter's own CarrierBridge). */
    private val versionName: String,
    private val versionCode: Long,
    /** Delegates to `RelayService.start(activity)` / `.stop(activity)` /
     *  `Notifier.notify(activity, ...)` — supplied by MainActivity rather
     *  than called directly here, so this bridge stays a thin, testable
     *  seam over whatever the Activity wires up. */
    private val onStartRelayService: () -> Unit,
    private val onStopRelayService: () -> Unit,
    private val onNotify: (title: String, body: String, tag: String) -> Unit,
) {
    @JavascriptInterface
    fun version(): String =
        """{"versionName":"$versionName","versionCode":$versionCode}"""

    @JavascriptInterface
    fun startRelayService() {
        runCatching { onStartRelayService() }
    }

    @JavascriptInterface
    fun stopRelayService() {
        runCatching { onStopRelayService() }
    }

    @JavascriptInterface
    fun notify(title: String, body: String, tag: String) {
        runCatching { onNotify(title, body, tag) }
    }

    companion object { const val JS_NAME = "KinjarShell" }
}
