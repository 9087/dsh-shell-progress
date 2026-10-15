import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressStore } from '../src/client/store.ts'
import { emptySnapshot } from '../src/client/port.ts'
import type { ProgressPort } from '../src/client/port.ts'
import type { LiveSnapshot } from '../src/types.ts'

/** A snapshot answering the same shape the host sends. */
function snapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    found: true,
    running: true,
    instrumented: true,
    refused: false,
    partial: false,
    current: 1,
    total: 2,
    elapsedMs: 10,
    preamble: '',
    steps: [],
    ...overrides,
  }
}

/** A port whose answers a test can change between ticks. */
function scriptedPort(answers: readonly (LiveSnapshot | undefined)[]): {
  readonly port: ProgressPort
  readonly calls: string[]
} {
  const calls: string[] = []
  let index = 0
  return {
    calls,
    port: {
      snapshot: async (callId) => {
        calls.push(callId)
        // An `undefined` entry is a REFUSED poll and must survive as one: it is
        // not the same answer as a snapshot.
        const answer: LiveSnapshot | undefined = index < answers.length ? answers[index] : snapshot()
        index += 1
        return answer
      },
    },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createProgressStore', () => {
  it('starts empty and publishes nothing on its own', () => {
    const store = createProgressStore(scriptedPort([snapshot()]).port)
    expect(store.getSnapshot().calls).toEqual({})
  })

  it('polls a watched call and publishes its snapshot', async () => {
    const { port, calls } = scriptedPort([snapshot({ current: 7 })])
    const store = createProgressStore(port)
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(['call-1'])
    expect(store.getSnapshot().calls['call-1']?.current).toBe(7)
    unwatch()
  })

  it('keeps the snapshot reference stable while nothing changes', async () => {
    const { port } = scriptedPort([snapshot()])
    const store = createProgressStore(port)
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    const first = store.getSnapshot()
    await vi.advanceTimersByTimeAsync(1_000)
    // The data changed between these reads only by elapsed time, so the object
    // is new — but two reads with no tick in between must be identical.
    const second = store.getSnapshot()
    const third = store.getSnapshot()
    expect(second).toBe(third)
    expect(first).not.toBe(second)
    unwatch()
  })

  it('stops polling once the host reports the call settled', async () => {
    const { port, calls } = scriptedPort([snapshot({ running: false })])
    const store = createProgressStore(port)
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(1)
    expect(store.getSnapshot().calls['call-1']?.running).toBe(false)
    unwatch()
  })

  // The three tests below are the regression for a bar that only ever moved at
  // the start and at the end of a command: every one of these answers used to be
  // folded into a snapshot with `running: false`, so the first tick stopped the
  // poll and the card sat frozen until `tool/result` re-rendered it.

  it('keeps polling while the host has no record of the call yet', async () => {
    // This is the NORMAL first tick, not an error: the card is rendered from
    // `tool/call` while the host registers its record inside `execute`.
    const { port, calls } = scriptedPort([emptySnapshot(), emptySnapshot(), snapshot({ current: 4 })])
    const store = createProgressStore(port)
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().calls['call-1']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(600)
    // EXACT, not "at least": the two extra ticks are the point, and a run of
    // three ticks also proves one timer was armed rather than several.
    expect(calls).toHaveLength(3)
    expect(store.getSnapshot().calls['call-1']?.current).toBe(4)
    unwatch()
  })

  it('keeps polling when the host refuses to answer', async () => {
    const { port, calls } = scriptedPort([undefined, snapshot({ current: 9 })])
    const store = createProgressStore(port)
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().calls['call-1']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toHaveLength(2)
    expect(store.getSnapshot().calls['call-1']?.current).toBe(9)
    unwatch()
  })

  it('keeps asking for a long while before giving up on an unusable host', async () => {
    const { port, calls } = scriptedPort([emptySnapshot()])
    const store = createProgressStore(port)
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    // A call may take minutes; giving up after a tick or two is what froze the bar.
    // The bound also fails a leaking timer, which would poll about twice as often.
    expect(calls.length).toBeGreaterThanOrEqual(40)
    expect(calls.length).toBeLessThanOrEqual(42)
    unwatch()
  })

  it('notifies subscribers only when something changed', async () => {
    const { port } = scriptedPort([snapshot({ running: false })])
    const store = createProgressStore(port)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(listener).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    unwatch()
  })

  it('refcounts watchers, so two cards on one call share a single poll', async () => {
    const { port, calls } = scriptedPort([snapshot()])
    const store = createProgressStore(port)
    const first = store.watch('call-1')
    const second = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    first()
    await vi.advanceTimersByTimeAsync(500)
    // The second watcher keeps it alive.
    expect(calls.length).toBeGreaterThan(1)
    second()
    const settled = calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toHaveLength(settled)
  })

  it('keeps the last snapshot when a poll fails', async () => {
    let fail = false
    const store = createProgressStore({
      snapshot: async () => {
        if (fail) throw new Error('transport down')
        return snapshot({ current: 3 })
      },
    })
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().calls['call-1']?.current).toBe(3)
    fail = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getSnapshot().calls['call-1']?.current).toBe(3)
    unwatch()
  })

  it('drops every call on reset, so a new transport never reads stale numbers', async () => {
    const { port } = scriptedPort([snapshot({ running: false })])
    const store = createProgressStore(port)
    const unwatch = store.watch('call-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().calls['call-1']).toBeDefined()
    store.reset()
    expect(store.getSnapshot().calls).toEqual({})
    unwatch()
  })
})
