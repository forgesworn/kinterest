import { useEffect, useState } from 'react'
import type { ChildProfile } from '../state/types'
import { fetchChildAvatar } from '../identity/childAvatar'

export function ChildAvatar({ child }: { child: ChildProfile }) {
  const [url, setUrl] = useState<string | null>(null)
  const avatar = child.signet?.avatar
  useEffect(() => {
    setUrl(null)
    if (!avatar) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(),20_000)
    let objectUrl: string | null = null
    void fetchChildAvatar(avatar,controller.signal).then(blob => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => {})
    return () => { clearTimeout(timer); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [avatar?.url, avatar?.hash, avatar?.key])
  const style = { width:40,height:40,borderRadius:'50%',objectFit:'cover' as const,display:'inline-flex',alignItems:'center',justifyContent:'center',background:'var(--surface)',flexShrink:0 }
  return url ? <img src={url} alt="" style={style} /> : <span aria-hidden="true" style={style}>{child.name.slice(0,1).toUpperCase()}</span>
}
