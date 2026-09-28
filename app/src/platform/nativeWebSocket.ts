/** Native socket transport in the Android shell. Only encrypted relay frames
 * cross this bridge; signature checks and decryption remain in the sync layer.
 * Browsers and older shells keep their ordinary WebSocket implementation. */
export interface NativeSocketBridge {
  relayOpen(id: string, url: string): void
  relaySend(id: string, text: string): boolean
  relayClose(id: string): void
}

export const NATIVE_SOCKET_EVENT = 'kinjar-relay-socket'
let serial = 0

export function nativeWebSocketImplementation(
  bridge: NativeSocketBridge,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
): typeof WebSocket {
  const pageId = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')
  class NativeSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readonly url: string
    readonly id = `relay-${pageId}-${++serial}`
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null

    constructor(url: string | URL) {
      super()
      this.url = String(url)
      target.addEventListener(NATIVE_SOCKET_EVENT, this.receive)
      try { bridge.relayOpen(this.id, this.url) } catch {
        target.removeEventListener(NATIVE_SOCKET_EVENT, this.receive)
        this.readyState = 3
        throw new Error('Native relay connection failed')
      }
    }

    private receive = (event: Event): void => {
      const message = (event as CustomEvent).detail
      if (message?.id !== this.id || this.readyState === 3) return
      if (message.type === 'open') {
        if (this.readyState !== 0) return
        this.readyState = 1
        const event = new Event('open')
        this.onopen?.(event); this.dispatchEvent(event)
      } else if (message.type === 'message' && this.readyState === 1 && typeof message.text === 'string') {
        const event = new MessageEvent('message', { data: message.text })
        this.onmessage?.(event); this.dispatchEvent(event)
      } else if (message.type === 'error') {
        const event = new Event('error')
        this.onerror?.(event); this.dispatchEvent(event)
      } else if (message.type === 'close') {
        this.finish()
      }
    }

    private finish(): void {
      if (this.readyState === 3) return
      this.readyState = 3
      target.removeEventListener(NATIVE_SOCKET_EVENT, this.receive)
      // CloseEvent is absent in some test/runtime contexts; consumers only
      // require the close event, never a relay-controlled reason string.
      const event = new Event('close') as CloseEvent
      this.onclose?.(event); this.dispatchEvent(event)
    }

    send(text: string): void {
      if (this.readyState !== 1 || !bridge.relaySend(this.id, text)) throw new Error('Relay socket is not open')
    }
    close(): void {
      if (this.readyState >= 2) return
      this.readyState = 2
      try { bridge.relayClose(this.id) } finally { this.finish() }
    }
  }
  // nostr-tools needs the text-frame subset above, rather than binary frames.
  return NativeSocket as unknown as typeof WebSocket
}

export function shellWebSocket(): typeof WebSocket | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = window.KinjarShell
  if (!bridge || typeof bridge.relayOpen !== 'function' || typeof bridge.relaySend !== 'function' || typeof bridge.relayClose !== 'function') return undefined
  return nativeWebSocketImplementation(bridge as NativeSocketBridge, window)
}
