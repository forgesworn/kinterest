package org.forgesworn.kinjar.web

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/** Keeps relay sockets on native threads while the Activity is backgrounded.
 * Frames remain encrypted; the web sync layer still authenticates every event.
 * The foreground service owns whether background transport is allowed. */
class NativeRelaySockets(
    private val allowed: () -> Boolean,
    private val deliver: (String) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private class Link { @Volatile var socket: WebSocket? = null }
    private val links = ConcurrentHashMap<String, Link>()
    @Volatile private var destroyed = false

    private fun event(id: String, type: String, text: String? = null) {
        if (destroyed) return
        val detail = JSONObject().put("id", id).put("type", type)
        if (text != null) detail.put("text", text)
        deliver(detail.toString())
    }

    @Synchronized fun open(id: String, url: String) {
        if (destroyed) return
        val request = runCatching {
            require(id.matches(Regex("relay-[0-9a-f]{24}-[0-9]+")))
            require(allowed() && links.size < 16 && !links.containsKey(id))
            require(url.startsWith("wss://"))
            Request.Builder().url(url).build().also {
                require(it.url.username.isEmpty() && it.url.password.isEmpty())
            }
        }.getOrNull()
        if (request == null) { event(id, "error"); event(id, "close"); return }
        val link = Link()
        links[id] = link
        link.socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (links[id] !== link) { webSocket.cancel(); return }
                event(id, "open")
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (links[id] !== link) return
                if (text.length > MAX_FRAME_CHARS) { close(id); return }
                event(id, "message", text)
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (links.remove(id, link)) event(id, "close")
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (links.remove(id, link)) { event(id, "error"); event(id, "close") }
            }
        })
    }

    fun send(id: String, text: String): Boolean =
        text.length <= MAX_FRAME_CHARS && links[id]?.socket?.send(text) == true

    fun close(id: String) {
        val link = links.remove(id) ?: return
        link.socket?.cancel()
        event(id, "close")
    }
    fun stop() { for (id in links.keys) close(id) }
    fun destroy() {
        destroyed = true
        stop()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }
    companion object { private const val MAX_FRAME_CHARS = 8 * 1024 * 1024 }
}
