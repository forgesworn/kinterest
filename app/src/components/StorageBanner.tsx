// Non-fatal banner shown above either shell while the latest save to this
// device's storage has failed. Clears itself on the next good save (the
// store lowers `storageError` then).

import type { ReactElement } from 'react'
import { useApp } from '../store/store'
import { Banner } from './ui'
import { storageWarning } from './storageBanner'

export function StorageBanner(): ReactElement | null {
  const { storageError } = useApp()
  const copy = storageWarning(storageError)
  return copy === null ? null : <Banner tone="bad">{copy}</Banner>
}
