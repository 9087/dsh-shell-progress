import { describe, expect, it } from 'vitest'
import type { Step } from '../src/split.ts'
import { StepTracker } from '../src/tracker.ts'

const STEPS: readonly Step[] = [
  { line: 1, text: 'Write-Output "one"' },
  { line: 4, text: 'Write-Output "two"' },
  { line: 7, text: 'if ($true) {' },
]

/** A tracker on a hand-cranked clock, so timings are exact in assertions. */
function trackerOnClock(steps: readonly Step[] = STEPS, maxStepOutputChars?: number): {
  readonly tracker: StepTracker
  readonly advance: (ms: number) => void
} {
  let now = 0
  return {
    tracker: new StepTracker(steps, {
      now: () => now,
      ...maxStepOutputChars === undefined ? {} : { maxStepOutputChars },
    }),
    advance: (ms) => { now += ms },
  }
}

describe('StepTracker attribution', () => {
  it('attributes lines to the most recent marker, and earlier ones to the preamble', () => {
    const { tracker } = trackerOnClock()
    tracker.observe({ kind: 'text', text: 'before' })
    tracker.observe({ kind: 'marker', line: 1 })
    tracker.observe({ kind: 'text', text: 'one output' })
    tracker.observe({ kind: 'marker', line: 4 })
    tracker.observe({ kind: 'text', text: 'two output' })
    tracker.settle()
    expect(tracker.preamble()).toBe('before')
    expect(tracker.steps().map((step) => step.output)).toEqual(['one output', 'two output', ''])
  })

  it('ignores a marker for a line it never instrumented', () => {
    const { tracker } = trackerOnClock()
    tracker.observe({ kind: 'marker', line: 99 })
    expect(tracker.current()).toBeNull()
  })

  it('does not restart a step when its marker repeats', () => {
    const { tracker, advance } = trackerOnClock()
    tracker.observe({ kind: 'marker', line: 1 })
    advance(50)
    tracker.observe({ kind: 'marker', line: 1 })
    expect(tracker.steps()[0]?.startedAt).toBe(0)
  })

  it('reports the current step by its original line number', () => {
    const { tracker } = trackerOnClock()
    expect(tracker.current()).toBeNull()
    tracker.observe({ kind: 'marker', line: 4 })
    expect(tracker.current()).toBe(4)
  })
})

describe('StepTracker timing', () => {
  it('closes the previous step exactly when the next one starts', () => {
    const { tracker, advance } = trackerOnClock()
    tracker.observe({ kind: 'marker', line: 1 })
    advance(120)
    tracker.observe({ kind: 'marker', line: 4 })
    advance(30)
    tracker.observe({ kind: 'marker', line: 7 })
    advance(5)
    tracker.settle()
    const steps = tracker.steps()
    expect(steps[0]?.startedAt).toBe(0)
    expect(steps[0]?.endedAt).toBe(120)
    expect(steps[1]?.startedAt).toBe(120)
    expect(steps[1]?.endedAt).toBe(150)
    expect(steps[2]?.startedAt).toBe(150)
    expect(steps[2]?.endedAt).toBe(155)
  })

  it('leaves steps the command never reached untouched', () => {
    const { tracker, advance } = trackerOnClock()
    tracker.observe({ kind: 'marker', line: 1 })
    advance(10)
    tracker.settle()
    const steps = tracker.steps()
    expect(steps[1]?.startedAt).toBeNull()
    expect(steps[1]?.endedAt).toBeNull()
  })

  it('reports the running step\'s elapsed time', () => {
    const { tracker, advance } = trackerOnClock()
    tracker.observe({ kind: 'marker', line: 1 })
    advance(4_200)
    expect(tracker.elapsed(4_200)).toBe(4_200)
    tracker.settle()
    expect(tracker.elapsed(9_999)).toBe(4_200)
  })

  it('is idempotent when settling twice', () => {
    const { tracker, advance } = trackerOnClock()
    tracker.observe({ kind: 'marker', line: 1 })
    advance(10)
    tracker.settle()
    const first = tracker.steps()[0]?.endedAt
    tracker.settle()
    expect(tracker.steps()[0]?.endedAt).toBe(first)
  })

  it('reports no elapsed time before the first marker', () => {
    const { tracker } = trackerOnClock()
    expect(tracker.elapsed(500)).toBe(0)
  })
})

describe('StepTracker sole step', () => {
  /** The one step of a run that was NOT instrumented — a single-line command. */
  const SOLE: readonly Step[] = [{ line: 1, text: "Write-Output 'one'" }]

  it('gives the only step of an uninstrumented run a start and an end', () => {
    // Without this the step has no timestamps at all: the card's single segment could
    // only ever read "pending" and its counter `0/1`, even on a finished command.
    const { tracker, advance } = trackerOnClock(SOLE)
    tracker.beginSoleStep()
    expect(tracker.current()).toBe(1)
    advance(1_500)
    expect(tracker.elapsed(1_500)).toBe(1_500)
    tracker.settle()
    const steps = tracker.steps()
    expect(steps[0]?.startedAt).toBe(0)
    expect(steps[0]?.endedAt).toBe(1_500)
  })

  it('is a no-op when the run has more than one step', () => {
    // With several steps the MARKERS say which is running; stamping the first would be
    // a guess, and a wrong one for every step after it.
    const { tracker } = trackerOnClock()
    tracker.beginSoleStep()
    expect(tracker.current()).toBeNull()
    expect(tracker.steps().every((step) => step.startedAt === null)).toBe(true)
  })
})

describe('StepTracker output budget', () => {
  it('drops output past the per-step budget and says so', () => {
    const { tracker } = trackerOnClock(STEPS, 10)
    tracker.observe({ kind: 'marker', line: 1 })
    tracker.observe({ kind: 'text', text: '1234567890' })
    tracker.observe({ kind: 'text', text: 'dropped' })
    expect(tracker.steps()[0]?.output).toBe('1234567890')
    expect(tracker.droppedOutput()).toBe(true)
  })

  it('counts the characters the budget dropped, not just that it dropped some', () => {
    // "Something was dropped" cannot be written on the card: the reader needs the
    // amount. Each dropped line is charged `length + 1`, exactly as a kept one is, so
    // kept + dropped is the step's real output size.
    const { tracker } = trackerOnClock(STEPS, 10)
    tracker.observe({ kind: 'marker', line: 1 })
    tracker.observe({ kind: 'text', text: '1234567890' }) // kept: chars becomes 11
    tracker.observe({ kind: 'text', text: 'dropped' }) // 7 + 1
    tracker.observe({ kind: 'text', text: 'ab' }) // 2 + 1
    const kept = tracker.steps()
    expect(kept[0]?.output).toBe('1234567890')
    expect(kept[0]?.droppedChars).toBe(11)
    // A step that stayed inside its budget reports nothing missing.
    expect(kept[1]?.droppedChars).toBe(0)
    expect(kept[2]?.droppedChars).toBe(0)
  })

  it('does not flag a run inside its budget', () => {
    const { tracker } = trackerOnClock(STEPS, 100)
    tracker.observe({ kind: 'marker', line: 1 })
    tracker.observe({ kind: 'text', text: 'short' })
    expect(tracker.droppedOutput()).toBe(false)
  })
})
