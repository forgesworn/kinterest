import { describe, expect, it } from 'vitest'
import { STORAGE_ERROR_COPY, UNREADABLE_STATE_COPY, quarantinedCopy, storageWarning, storageWarnings } from './storageBanner'

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

describe('storageWarnings', () => {
  it('shows nothing when everything is fine', () => {
    expect(storageWarnings({ storageError: false, quarantined: 0, unreadable: false })).toEqual([])
  })

  it('lists each problem once, save failure first', () => {
    expect(storageWarnings({ storageError: true, quarantined: 2, unreadable: true })).toEqual([
      STORAGE_ERROR_COPY,
      UNREADABLE_STATE_COPY,
      quarantinedCopy(2),
    ])
    expect(quarantinedCopy(1)).toContain('1 saved money entry ')
    expect(quarantinedCopy(2)).toContain('2 saved money entries ')
  })
})
