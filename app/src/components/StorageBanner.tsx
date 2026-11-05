// Non-fatal banners shown above either shell: a failed save (clears itself
// on the next good save — the store lowers `storageError` then), rows set
// aside on load, and a saved state that could not be read at all.

import type { ReactElement } from 'react'
import { useApp } from '../store/store'
import { quarantinedEntries, unreadableStateBlob } from '../state/persist'
import { Banner } from './ui'
import { storageWarnings } from './storageBanner'

export function StorageBanner(): ReactElement | null {
  const { storageError } = useApp()
  // Both reads are synchronous against the storage mirror and cheap; they
  // only change on load, so a read per render is fine.
  const lines = storageWarnings({
    storageError,
    quarantined: quarantinedEntries().length,
    unreadable: unreadableStateBlob() !== null,
  })
  if (lines.length === 0) return null
  return (
    <>
      {lines.map((copy) => (
        <Banner key={copy} tone="bad">{copy}</Banner>
      ))}
    </>
  )
}
