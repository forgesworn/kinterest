import { describe, expect, it } from 'vitest'
import { STORAGE_ERROR_COPY, storageWarning } from './storageBanner'

describe('storageWarning', () => {
  it('shows nothing while saving works', () => {
    expect(storageWarning(false)).toBeNull()
  })

  it('shows the free-up-space copy when a save has failed', () => {
    expect(storageWarning(true)).toBe(STORAGE_ERROR_COPY)
    expect(STORAGE_ERROR_COPY).toContain('free up some space')
    expect(STORAGE_ERROR_COPY.toLowerCase()).not.toContain('kinterest')
  })
})
