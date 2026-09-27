import { describe, expect, it } from 'vitest'
import {
  addChildRoute,
  approvalsRoute,
  childDetailRoute,
  childSettingsRoute,
  goBack,
  homeRoute,
  pairDeviceRoute,
  type Route,
} from './routes'

const CHILD = 'sam'

describe('route constructors', () => {
  it('build the expected route shapes', () => {
    expect(homeRoute()).toEqual({ screen: 'home' })
    expect(childDetailRoute(CHILD)).toEqual({ screen: 'childDetail', childPubkey: CHILD })
    expect(childSettingsRoute(CHILD)).toEqual({ screen: 'childSettings', childPubkey: CHILD })
    expect(pairDeviceRoute(CHILD)).toEqual({ screen: 'pairDevice', childPubkey: CHILD })
    expect(approvalsRoute()).toEqual({ screen: 'approvals' })
    expect(addChildRoute()).toEqual({ screen: 'addChild' })
  })
})

describe('goBack', () => {
  it('home -> home (no-op, no predecessor)', () => {
    const route = homeRoute()
    expect(goBack(route)).toBe(route)
  })

  it('childDetail -> home', () => {
    expect(goBack(childDetailRoute(CHILD))).toEqual({ screen: 'home' })
  })

  it('childSettings -> that same child\'s childDetail', () => {
    expect(goBack(childSettingsRoute(CHILD))).toEqual({ screen: 'childDetail', childPubkey: CHILD })
  })

  it('pairDevice -> that same child\'s childSettings', () => {
    expect(goBack(pairDeviceRoute(CHILD))).toEqual({ screen: 'childSettings', childPubkey: CHILD })
  })

  it('approvals -> home', () => {
    expect(goBack(approvalsRoute())).toEqual({ screen: 'home' })
  })

  it('addChild -> home', () => {
    expect(goBack(addChildRoute())).toEqual({ screen: 'home' })
  })

  it('preserves the childPubkey through a childSettings -> childDetail -> home chain', () => {
    const settings = childSettingsRoute(CHILD)
    const detail = goBack(settings)
    expect(detail).toEqual({ screen: 'childDetail', childPubkey: CHILD })
    expect(goBack(detail)).toEqual({ screen: 'home' })
  })

  it('is total: every Route variant is handled', () => {
    const routes: Route[] = [
      homeRoute(),
      childDetailRoute(CHILD),
      childSettingsRoute(CHILD),
      pairDeviceRoute(CHILD),
      approvalsRoute(),
      addChildRoute(),
    ]
    for (const route of routes) {
      expect(() => goBack(route)).not.toThrow()
    }
  })
})
