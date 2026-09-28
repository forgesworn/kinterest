import { describe, expect, it, vi } from 'vitest'
import { nativeWebSocketImplementation, NATIVE_SOCKET_EVENT } from './nativeWebSocket'

function harness() {
  const target = new EventTarget()
  const bridge = { relayOpen: vi.fn(), relaySend: vi.fn(() => true), relayClose: vi.fn() }
  const Socket = nativeWebSocketImplementation(bridge, target)
  const socket = new Socket('wss://example.org')
  const id = bridge.relayOpen.mock.calls[0]![0]
  const emit = (type: string, text?: string, forId = id) => target.dispatchEvent(new CustomEvent(NATIVE_SOCKET_EVENT, { detail: { id: forId, type, text } }))
  return { socket, bridge, emit }
}

describe('native relay WebSocket adapter', () => {
  it('delivers only its own text frames after opening and sends through the native bridge', () => {
    const { socket, bridge, emit } = harness()
    const onMessage = vi.fn(); socket.onmessage = onMessage
    expect(() => socket.send('early')).toThrow()
    emit('message', 'before open'); emit('open', undefined, 'different socket')
    expect(socket.readyState).toBe(0)
    emit('open'); socket.send('["REQ"]'); emit('message', '["EVENT"]')
    expect(socket.readyState).toBe(1)
    expect(bridge.relaySend).toHaveBeenCalledWith(expect.any(String), '["REQ"]')
    expect(onMessage.mock.calls[0]![0].data).toBe('["EVENT"]')
    expect(onMessage).toHaveBeenCalledTimes(1)
  })
  it('closes once, ignores later frames and makes native queue rejection visible', () => {
    const { socket, bridge, emit } = harness()
    const onClose = vi.fn(); const onMessage = vi.fn()
    socket.onclose = onClose; socket.onmessage = onMessage
    emit('open'); bridge.relaySend.mockReturnValue(false)
    expect(() => socket.send('not queued')).toThrow()
    socket.close(); emit('close'); emit('message', 'late')
    expect(socket.readyState).toBe(3)
    expect(bridge.relayClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onMessage).not.toHaveBeenCalled()
  })
  it('reports a failed native handshake and releases its event listener', () => {
    const { socket, emit } = harness()
    const error = vi.fn(); const close = vi.fn()
    socket.onerror = error; socket.onclose = close
    emit('error'); emit('close'); emit('open')
    expect(error).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(socket.readyState).toBe(3)
  })
})
