import { expect, it } from 'vitest'
import { nativeSignetHandoffUrl } from './signetHandoff'
it('opens the exact NIP-46 invitation in the trusted My Signet carrier', () => {
  const uri = `nostrconnect://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=fixture&name=Kinterest`
  const handoff = new URL(nativeSignetHandoffUrl({ type: 'uri-created', uri })!)
  expect(handoff.origin).toBe('https://mysignet.app')
  expect(handoff.searchParams.get('nostrconnect')).toBe(uri)
  expect(nativeSignetHandoffUrl({ type: 'uri-created', uri: 'https://attacker.example' })).toBeNull()
})
it('brings signing consent to the foreground without opening machine-only requests', () => {
  expect(nativeSignetHandoffUrl({ type: 'request-sent', method: 'sign_event' })).toBe('https://mysignet.app/')
  expect(nativeSignetHandoffUrl({ type: 'request-sent', method: 'get_public_key' })).toBeNull()
  expect(nativeSignetHandoffUrl({ type: 'response-received', method: 'sign_event' })).toBeNull()
})
