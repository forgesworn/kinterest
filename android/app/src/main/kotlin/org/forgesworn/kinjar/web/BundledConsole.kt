package org.forgesworn.kinjar.web

import android.content.Context
import android.webkit.WebResourceResponse
import java.io.IOException

/**
 * Serves the web app from APK assets *as* the console origin. The WebView
 * still navigates to [UrlGate.CONSOLE_ORIGIN] — that origin is where
 * localStorage/IndexedDB live, and the guardian/child keys live there, so the
 * origin must never change. Interception just answers those requests
 * locally, from the bundle the `stageConsoleAssets` Gradle task stages in
 * (see android/app/build.gradle.kts).
 *
 * Ported from charter/android/carrier/src/main/kotlin/.../web/BundledConsole.kt
 * (same shape; this shell has no update-feed exclusions to carry over yet —
 * Kinjar has no self-update manifest, per the plan's Self-review notes).
 */
object BundledConsole {
    /** assets/ subdirectory the gradle `stageConsoleAssets` task fills. */
    private const val ROOT = "console"

    /** "/x/y" -> "x/y"; "" and "/" -> the SPA entry — one page, screens are
     *  derived from app state rather than routed by URL. Path traversal guard:
     *  reject ".." segments (returns empty string → caller 404s). */
    fun assetPath(path: String): String? {
        val p = path.removePrefix("/")
        if (p.contains("..")) return null  // Reject path traversal attempts
        return if (p.isEmpty()) "index.html" else p
    }

    /**
     * Explicit table — URLConnection.guessContentTypeFromName misses js, svg
     * and webmanifest, and a wrong type here means a blank page, not an error.
     */
    fun mimeFor(assetPath: String): String = when (assetPath.substringAfterLast('.', "")) {
        "html" -> "text/html"
        "js", "mjs" -> "application/javascript"
        "css" -> "text/css"
        "svg" -> "image/svg+xml"
        "webmanifest" -> "application/manifest+json"
        "json" -> "application/json"
        "png" -> "image/png"
        "ico" -> "image/x-icon"
        "woff", "woff2" -> "font/woff2"
        "txt" -> "text/plain"
        else -> "application/octet-stream"
    }

    /** Text types get an explicit charset; binary must not claim one. */
    fun charsetFor(mime: String): String? =
        if (mime.startsWith("text/") || mime == "application/javascript" ||
            mime == "application/json" || mime == "application/manifest+json" ||
            mime == "image/svg+xml"
        ) {
            "utf-8"
        } else {
            null
        }

    /** null = asset not found in the bundle. Callers serving a real,
     *  network-reachable origin may treat that as "fall through to the
     *  network" — but MainActivity's `shouldInterceptRequest` does NOT: for
     *  the console origin specifically it turns a null here into an explicit
     *  404 rather than letting the request escape this interceptor, because
     *  `app.kinjar.local` is a `.local` pseudo-TLD with no real DNS entry —
     *  letting an unmatched path fall through would hand it to mDNS
     *  resolution, which is spoofable on a hostile LAN, and would silently
     *  paper over a `stageConsoleAssets` staging gap by fetching from
     *  wherever `.local` happened to resolve instead of failing loudly. */
    fun serve(context: Context, path: String): WebResourceResponse? {
        val asset = assetPath(path) ?: return null
        return try {
            val stream = context.assets.open("$ROOT/$asset")
            val mime = mimeFor(asset)
            WebResourceResponse(mime, charsetFor(mime), stream)
        } catch (_: IOException) {
            null
        }
    }
}
