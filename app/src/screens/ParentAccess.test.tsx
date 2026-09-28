// @vitest-environment jsdom
import { createContext } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyState } from '../state/state'
import type { AppContextValue } from '../store/store'

const mocks = vi.hoisted(() => ({ current: null as unknown, saved: new Map<string, string>() }))
vi.mock('../store/store', () => ({
  AppContext: createContext(null),
  useApp: () => mocks.current,
}))
vi.mock('../platform/dataStorage', () => ({
  dataStorage: () => ({
    getItem: (key: string) => mocks.saved.get(key) ?? null,
    setItem: (key: string, value: string) => mocks.saved.set(key, value),
    removeItem: (key: string) => mocks.saved.delete(key),
  }),
  flushDataStorage: async () => true,
}))
vi.mock('../identity/vault', () => ({ vaultLoad: async () => null }))
vi.mock('./ParentLock', () => ({ ParentLock: ({ onUnlocked }: { onUnlocked: () => void }) => <button onClick={onUnlocked}>Complete parent PIN check</button> }))
import ParentAccess, { useParentMode } from './ParentAccess'

const child = 'a'.repeat(64)
function GuardianRoute({ route = 'Home' }: { route?: string }) {
  const mode = useParentMode()
  return <><p>Parent {route}</p><button onClick={() => mode?.actAs(child)}>Act as child</button></>
}
beforeEach(() => {
  mocks.saved.clear()
  const app = { ...emptyState(), children: [{ pubkey: child, name: 'Test child', index: 0, signet: { identityPk: child } }] }
  mocks.current = { state: { app }, dispatch: vi.fn() } as unknown as AppContextValue
})
afterEach(cleanup)

describe('parent route boundary', () => {
  it('locks again after reload and backgrounding', () => {
    const view = render(<ParentAccess><GuardianRoute /></ParentAccess>)
    expect(screen.queryByRole('button', { name: 'Act as child' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Complete parent PIN check' }))
    expect(screen.getByRole('button', { name: 'Act as child' })).toBeTruthy()
    fireEvent(window, new Event('blur'))
    expect(screen.queryByRole('button', { name: 'Act as child' })).toBeNull()
    view.unmount()
    render(<ParentAccess><GuardianRoute /></ParentAccess>)
    expect(screen.queryByRole('button', { name: 'Act as child' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Complete parent PIN check' })).toBeTruthy()
  })

  it('keeps child mode across notification routing, reload and cancelled parent return', async () => {
    const view = render(<ParentAccess><GuardianRoute /></ParentAccess>)
    fireEvent.click(screen.getByRole('button', { name: 'Complete parent PIN check' }))
    fireEvent.click(screen.getByRole('button', { name: 'Act as child' }))
    expect(mocks.saved.get('kinjar.parent-view.v1')).toBe(child)
    await screen.findByText(/A parent needs to reconnect/)
    view.rerender(<ParentAccess><GuardianRoute route="Approvals" /></ParentAccess>)
    expect(screen.queryByText('Parent Approvals')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Return to parent mode' }))
    expect(screen.queryByText('Parent Approvals')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to child view' }))
    expect(mocks.saved.get('kinjar.parent-view.v1')).toBe(child)
    view.unmount()
    render(<ParentAccess><GuardianRoute route="Approvals" /></ParentAccess>)
    expect(screen.queryByText('Parent Approvals')).toBeNull()
    expect(screen.getByRole('button', { name: 'Return to parent mode' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Return to parent mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Complete parent PIN check' }))
    expect(screen.getByText('Parent Approvals')).toBeTruthy()
    expect(mocks.saved.has('kinjar.parent-view.v1')).toBe(false)
  })
})
