// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ unlock:vi.fn(),set:vi.fn(),confirm:vi.fn() }))
vi.mock('../identity/parentPin', () => ({parentPinIsSet:async()=>true,setParentPin:mocks.set,unlockParent:mocks.unlock}))
vi.mock('../identity/signetLogin', () => ({confirmParentPresence:mocks.confirm}))
vi.mock('../store/store', () => ({useApp:()=>({state:{app:{guardianPubkey:'a'.repeat(64),root:{kind:'signet',pubkey:'b'.repeat(64)},relays:[]}}})}))
import { ParentLock } from './ParentLock'
beforeEach(()=>{vi.clearAllMocks();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})})
afterEach(cleanup)
function digits() { for (const n of ['1','2','3','4']) fireEvent.click(screen.getByRole('button',{name:`Digit ${n}`})) }
describe('parent unlock visibility boundary',()=>{
  it('keeps parent mode locked when a pending correct PIN resolves after hiding',async()=>{
    let resolve!:(r:{unlocked:boolean;lockedUntilSec:number})=>void
    mocks.unlock.mockReturnValue(new Promise(r=>{resolve=r}))
    const opened = vi.fn();render(<ParentLock onUnlocked={opened} />)
    await screen.findByRole('button',{name:'Unlock parent mode'});digits()
    fireEvent.click(screen.getByRole('button',{name:'Unlock parent mode'}))
    await waitFor(()=>expect(mocks.unlock).toHaveBeenCalledOnce())
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});fireEvent(document,new Event('visibilitychange'))
    await act(async()=>resolve({unlocked:true,lockedUntilSec:0}))
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});fireEvent(document,new Event('visibilitychange'))
    expect(opened).not.toHaveBeenCalled()
  })
  it('does not leave PIN-reset authority on a hidden page',async()=>{
    let resolve!:(result:boolean)=>void;mocks.confirm.mockReturnValue(new Promise(r=>{resolve=r}))
    render(<ParentLock onUnlocked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button',{name:'Forgot parent PIN? Reset with My Signet'}))
    await waitFor(()=>expect(mocks.confirm).toHaveBeenCalledOnce())
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});fireEvent(document,new Event('visibilitychange'))
    await act(async()=>resolve(true))
    expect(screen.queryByText('Choose your parent PIN')).toBeNull()
    expect(mocks.set).not.toHaveBeenCalled()
  })
})
