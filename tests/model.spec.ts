import { describe, expect, it } from 'vitest'
import {
  argsOf,
  barShape,
  durationTone,
  isErrorBlock,
  isSettledBlock,
  metaOf,
  viewFromLive,
  viewFromSettled,
} from '../src/client/model.ts'
import type { LiveSnapshot, ShellProgressMeta } from '../src/types.ts'

const COMMAND = ['$a = 1', 'if ($true) {', '  Write-Output "x"', '}', 'Write-Output $a'].join('\n')

describe('barShape', () => {
  it('draws nothing for a single step', () => {
    expect(barShape(0)).toBe('none')
    expect(barShape(1)).toBe('none')
  })

  it('segments a normal command', () => {
    expect(barShape(2)).toBe('segments')
    expect(barShape(40)).toBe('segments')
  })

  it('degrades past the segment cap', () => {
    expect(barShape(41)).toBe('solid')
  })
})

describe('durationTone', () => {
  it('has three discrete bands', () => {
    expect(durationTone(0)).toBe('normal')
    expect(durationTone(4_999)).toBe('normal')
    expect(durationTone(5_000)).toBe('slow')
    expect(durationTone(29_999)).toBe('slow')
    expect(durationTone(30_000)).toBe('overdue')
  })
})

describe('viewFromLive', () => {
  // `current` is the running step's ORIGINAL LINE NUMBER, as the host reports
  // it — not an index. The card resolves it to a position.
  const snapshot = (overrides: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
    found: true,
    running: true,
    instrumented: true,
    partial: false,
    current: 5,
    total: 2,
    elapsedMs: 3_000,
    preamble: '',
    steps: [
      { line: 1, text: '$a = 1', output: 'one', startedAt: 0, endedAt: 100 },
      { line: 5, text: 'Write-Output $a', output: '', startedAt: 100, endedAt: null },
    ],
    ...overrides,
  })

  it('marks the running step and the finished ones', () => {
    const view = viewFromLive(snapshot(), COMMAND)
    expect(view.running).toBe(true)
    expect(view.currentIndex).toBe(1)
    expect(view.done).toBe(1)
    expect(view.steps.map((step) => step.phase)).toEqual(['done', 'running'])
  })

  it('reports the running step\'s elapsed time as its duration', () => {
    const view = viewFromLive(snapshot(), COMMAND)
    expect(view.currentElapsedMs).toBe(3_000)
    expect(view.steps[1]?.durationMs).toBe(3_000)
    expect(view.steps[1]?.tone).toBe('normal')
  })

  it('draws the planned structure when the host has no record yet', () => {
    const view = viewFromLive(undefined, COMMAND)
    expect(view.instrumented).toBe(false)
    expect(view.currentIndex).toBe(-1)
    expect(view.steps.map((step) => step.line)).toEqual([1, 2, 5])
    expect(view.steps.every((step) => step.phase === 'pending')).toBe(true)
  })

  it('ignores a current line that is not one of the steps', () => {
    const view = viewFromLive(snapshot({ current: 99 }), COMMAND)
    expect(view.currentIndex).toBe(-1)
  })

  it('carries the partial flag through', () => {
    expect(viewFromLive(snapshot({ partial: true }), COMMAND).partial).toBe(true)
  })
})

describe('viewFromSettled', () => {
  const meta: ShellProgressMeta = {
    v: 1,
    instrumented: true,
    partial: false,
    preamble: 'lead-in',
    steps: [
      { line: 1, text: '$a = 1', output: 'one', startedAt: 0, endedAt: 120 },
      { line: 5, text: 'Write-Output $a', output: 'two', startedAt: 120, endedAt: 900 },
    ],
  }

  it('derives durations from the persisted timings, with no live source', () => {
    const view = viewFromSettled(meta, COMMAND, false)
    expect(view.running).toBe(false)
    expect(view.steps.map((step) => step.durationMs)).toEqual([120, 780])
    expect(view.steps.map((step) => step.phase)).toEqual(['done', 'done'])
    expect(view.done).toBe(2)
    expect(view.preamble).toBe('lead-in')
  })

  it('bands a slow step', () => {
    const view = viewFromSettled({
      ...meta,
      steps: [{ line: 1, text: '$a = 1', output: '', startedAt: 0, endedAt: 6_000 }],
    }, COMMAND, false)
    expect(view.steps[0]?.tone).toBe('slow')
  })

  it('falls back to the command text when no metadata was persisted', () => {
    const view = viewFromSettled(undefined, COMMAND, false)
    expect(view.instrumented).toBe(false)
    expect(view.steps.map((step) => step.line)).toEqual([1, 2, 5])
  })

  it('marks the last started step when the call failed', () => {
    const view = viewFromSettled(meta, COMMAND, true)
    expect(view.steps[1]?.phase).toBe('failed')
  })

  it('leaves a step the command never reached as pending', () => {
    const view = viewFromSettled({
      ...meta,
      steps: [
        { line: 1, text: '$a = 1', output: '', startedAt: 0, endedAt: 5 },
        { line: 5, text: 'Write-Output $a', output: '', startedAt: null, endedAt: null },
      ],
    }, COMMAND, false)
    expect(view.steps[1]?.phase).toBe('pending')
  })
})

describe('block narrowing', () => {
  it('tells the running arm from the settled one', () => {
    expect(isSettledBlock({ kind: 'tool-result' })).toBe(true)
    expect(isSettledBlock({ name: 'shell_progress_pwsh', argsRaw: '{}' })).toBe(false)
    // The arm that matters: a RUNNING call carries a kind of its own. A predicate
    // that only asked whether `kind` EXISTS called this settled, which stopped the
    // poll on its first tick and froze the bar.
    expect(isSettledBlock({ kind: 'tool-call', name: 'shell_progress_pwsh', argsRaw: '{}' })).toBe(false)
    expect(isSettledBlock(null)).toBe(false)
  })

  it('reads failure off the settled arm only', () => {
    expect(isErrorBlock({ kind: 'tool-result', isError: true })).toBe(true)
    expect(isErrorBlock({ kind: 'tool-result', isError: false })).toBe(false)
  })

  it('reads arguments from the running arm', () => {
    const args = argsOf({ name: 'shell_progress', argsRaw: '{"command":"a\\nb","description":"d"}' })
    expect(args.command).toBe('a\nb')
    expect(args.description).toBe('d')
  })

  it('reads arguments from the settled arm, where the call head carries them', () => {
    const args = argsOf({ kind: 'tool-result', call: { name: 'shell_progress', argsRaw: '{"command":"x"}' } })
    expect(args.command).toBe('x')
  })

  it('survives a truncated argsRaw prefix', () => {
    expect(argsOf({ argsRaw: '{"command":"untermin' }).command).toBe('')
  })

  it('survives a settled arm whose call head was windowed out', () => {
    expect(argsOf({ kind: 'tool-result', call: null }).command).toBe('')
  })

  it('narrows persisted metadata and rejects anything else', () => {
    const meta = metaOf({ kind: 'tool-result', meta: { v: 1, steps: [{ line: 1, text: 'x', output: 'y', startedAt: 0, endedAt: 1 }] } })
    expect(meta?.steps[0]?.line).toBe(1)
    expect(metaOf({ kind: 'tool-result' })).toBeUndefined()
    expect(metaOf({ kind: 'tool-result', meta: { steps: [] } })).toBeUndefined()
    expect(metaOf({ kind: 'tool-result', meta: 'nonsense' })).toBeUndefined()
  })

  it('drops a malformed step row instead of the whole metadata', () => {
    const meta = metaOf({
      kind: 'tool-result',
      meta: { steps: [{ line: 1, text: 'x', output: 'y' }, { line: 'bad' }] },
    })
    expect(meta?.steps).toHaveLength(1)
  })
})
