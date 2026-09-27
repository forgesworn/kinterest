package org.forgesworn.kinjar.web

import java.net.URI

/**
 * Navigation policy for the console WebView. The `KinjarShell` JS bridge is
 * exposed to every page the WebView loads, so ONLY the console's own origin
 * may load in-app. The Signet picker (My Signet, `nostrconnect://` /
 * `bunker://` remote-signer links) hands off to whatever app or browser tab
 * the phone has for it — that hand-off happens outside this WebView, so the
 * bridge is never exposed to it. Everything else — including any other
 * https host — is blocked outright. Exact-host, https-only for the in-app
 * and web-external cases — no suffix matching.
 */
object UrlGate {
    const val CONSOLE_ORIGIN = "https://app.kinjar.local"

    enum class Verdict { IN_APP, EXTERNAL, BLOCK }

    fun decide(url: String): Verdict {
        val uri = try { URI(url) } catch (_: Exception) { return Verdict.BLOCK }
        val scheme = uri.scheme?.lowercase()
        if (scheme in setOf("nostrconnect", "bunker", "signet", "intent")) return Verdict.EXTERNAL
        if (scheme != "https") return Verdict.BLOCK
        // Hosts are case-insensitive (RFC 3986) — without lowercasing,
        // https://MySignet.app would BLOCK rather than hand off.
        return when (uri.host?.lowercase()) {
            "app.kinjar.local" -> Verdict.IN_APP
            "mysignet.app", "lite.mysignet.app" -> Verdict.EXTERNAL
            else -> Verdict.BLOCK
        }
    }
}
