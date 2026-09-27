import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { makeFakeRelay } from './fakeRelay'

const AT = 1_700_000_000

function makeEvent(overrides: Partial<{ kind: number; createdAt: number; pTag: string }> = {}): NostrEvent {
  const sk = generateSecretKey()
  return finalizeEvent(
    {
      kind: overrides.kind ?? 31120,
      created_at: overrides.createdAt ?? AT,
      tags: overrides.pTag ? [['p', overrides.pTag]] : [],
      content: 'x',
    },
    sk,
  )
}

describe('makeFakeRelay: publish', () => {
  it('accepts a publish while online and stores the event', async () => {
    const relay = makeFakeRelay()
    const ev = makeEvent()
    await expect(relay.publish(ev)).resolves.toBe('accepted')
    expect(relay.events).toEqual([ev])
  })

  it('rejects a publish while offline and does not store the event', async () => {
    const relay = makeFakeRelay()
    relay.goOffline()
    const ev = makeEvent()
    await expect(relay.publish(ev)).resolves.toBe('rejected')
    expect(relay.events).toEqual([])
  })

  it('accepts again once back online', async () => {
    const relay = makeFakeRelay()
    relay.goOffline()
    const offlineEv = makeEvent()
    await relay.publish(offlineEv)
    relay.goOnline()
    const onlineEv = makeEvent()
    await expect(relay.publish(onlineEv)).resolves.toBe('accepted')
    expect(relay.events).toEqual([onlineEv])
  })
})

describe('makeFakeRelay: late subscriber replay', () => {
  it('delivers already-stored matching events synchronously to a subscriber that joins late', async () => {
    const relay = makeFakeRelay()
    const ev1 = makeEvent()
    const ev2 = makeEvent()
    await relay.publish(ev1)
    await relay.publish(ev2)

    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31120] }, (e) => received.push(e))

    expect(received).toEqual([ev1, ev2])
  })

  it('does not replay events of a kind the late subscriber did not ask for', async () => {
    const relay = makeFakeRelay()
    const entry = makeEvent({ kind: 31120 })
    const ack = makeEvent({ kind: 31123 })
    await relay.publish(entry)
    await relay.publish(ack)

    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31123] }, (e) => received.push(e))

    expect(received).toEqual([ack])
  })

  it('filters replay by #p tag', async () => {
    const relay = makeFakeRelay()
    const forAlice = makeEvent({ pTag: 'alice-pk' })
    const forBob = makeEvent({ pTag: 'bob-pk' })
    await relay.publish(forAlice)
    await relay.publish(forBob)

    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31120], '#p': ['alice-pk'] }, (e) => received.push(e))

    expect(received).toEqual([forAlice])
  })

  it('filters replay by since', async () => {
    const relay = makeFakeRelay()
    const old = makeEvent({ createdAt: AT - 1000 })
    const recent = makeEvent({ createdAt: AT + 1000 })
    await relay.publish(old)
    await relay.publish(recent)

    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31120], since: AT }, (e) => received.push(e))

    expect(received).toEqual([recent])
  })
})

describe('makeFakeRelay: deliverAll (live delivery to already-subscribed listeners)', () => {
  it('does not push new publishes to subscribers until deliverAll() is called', async () => {
    const relay = makeFakeRelay()
    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31120] }, (e) => received.push(e))

    const ev = makeEvent()
    await relay.publish(ev)
    expect(received).toEqual([])

    relay.deliverAll()
    expect(received).toEqual([ev])
  })

  it('does not re-deliver events a late subscriber already received via replay', async () => {
    const relay = makeFakeRelay()
    const ev1 = makeEvent()
    await relay.publish(ev1)

    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31120] }, (e) => received.push(e)) // replays ev1 once
    expect(received).toEqual([ev1])

    relay.deliverAll()
    expect(received).toEqual([ev1]) // not delivered a second time
  })

  it('delivers events published across multiple deliverAll() calls exactly once each', async () => {
    const relay = makeFakeRelay()
    const received: NostrEvent[] = []
    relay.subscribe({ kinds: [31120] }, (e) => received.push(e))

    const ev1 = makeEvent()
    await relay.publish(ev1)
    relay.deliverAll()

    const ev2 = makeEvent()
    await relay.publish(ev2)
    relay.deliverAll()

    expect(received).toEqual([ev1, ev2])
  })

  it('stops delivering after the subscriber unsubscribes', async () => {
    const relay = makeFakeRelay()
    const received: NostrEvent[] = []
    const unsubscribe = relay.subscribe({ kinds: [31120] }, (e) => received.push(e))
    unsubscribe()

    await relay.publish(makeEvent())
    relay.deliverAll()

    expect(received).toEqual([])
  })
})
