import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import type { ChildConsent } from './familyAuthority'

export function avatarUrl(base: string, hash: string): string {
  const u = new URL(base)
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  // Avatars use public HTTPS Blossom hosts. Reject IP literals and local names.
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid avatar host')
  return `${u.href.replace(/\/+$/, '')}/${hash}`
}
export async function fetchChildAvatar(avatar: NonNullable<ChildConsent['avatar']>, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(avatarUrl(avatar.url, avatar.hash), { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 2 * 1024 * 1024 || !response.body) throw new Error('Could not load avatar')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > 2 * 1024 * 1024) throw new Error('Avatar too large'); chunks.push(value) }
  } finally { await reader.cancel().catch(() => {}) }
  if (total < 29) throw new Error('Invalid avatar')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of chunks) { bytes.set(part,offset); offset += part.length }
  const hash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.buffer)))
  if (hash !== avatar.hash) throw new Error('Avatar integrity check failed')
  const keyBytes = Uint8Array.from(hexToBytes(avatar.key))
  try {
    const key = await crypto.subtle.importKey('raw',keyBytes.buffer,'AES-GCM',false,['decrypt'])
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM',iv:bytes.slice(0,12) },key,bytes.slice(12))
    return new Blob([plain], { type:'image/jpeg' })
  } finally { keyBytes.fill(0) }
}
