import { isShell } from './shell'

/** Keep the NIP-46 session in this WebView while opening My Signet natively. */
export function nativeSignetHandoffUrl(status: { type: string; uri?: string; method?: string }): string | null {
  if (status.type === 'request-sent' && status.method === 'sign_event') return 'https://mysignet.app/'
  if (status.type !== 'uri-created' || !status.uri) return null
  try {
    const uri = new URL(status.uri)
    if (uri.protocol !== 'nostrconnect:' || !/^[0-9a-f]{64}$/.test(uri.hostname)) return null
    return `https://mysignet.app/?nostrconnect=${encodeURIComponent(status.uri)}`
  } catch { return null }
}
export function openNativeSignet(status: Parameters<typeof nativeSignetHandoffUrl>[0]): void {
  if (!isShell()) return
  const url = nativeSignetHandoffUrl(status)
  if (url) window.location.assign(url)
}
