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
  withNotes,
} from '../src/client/model.ts'
import type { LiveSnapshot, ShellProgressMeta } from '../src/types.ts'

// There is deliberately NO multi-line command fixture here any more: the client
// no longer derives anything from the command text (see `./model`'s header), so
// the only inputs these builders take are host data.

describe('barShape', () => {
  it('draws nothing only when nothing is known', () => {
    // Zero steps is the moment before the host has answered — nothing to draw yet.
    expect(barShape(0)).toBe('none')
  })

  it('gives a single-line command ONE segment', () => {
    // One step is a real command with a real segment: it shows pending → running →
    // done, with the command's clock beside it. This used to be 'none', which left a
    // single-line card with a counter and no bar at all.
    expect(barShape(1)).toBe('segments')
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
    refused: false,
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
    const view = viewFromLive(snapshot())
    expect(view.running).toBe(true)
    expect(view.currentIndex).toBe(1)
    expect(view.done).toBe(1)
    expect(view.steps.map((step) => step.phase)).toEqual(['done', 'running'])
  })

  it('reports the running step\'s elapsed time as its duration', () => {
    const view = viewFromLive(snapshot())
    expect(view.currentElapsedMs).toBe(3_000)
    expect(view.steps[1]?.durationMs).toBe(3_000)
    expect(view.steps[1]?.tone).toBe('normal')
  })

  it('draws NOTHING the command text could have suggested when the host has no record', () => {
    // The browser cannot run a parser, so any row drawn here would be a GUESS.
    // The card keeps its own header and says the call is live; the bar and the
    // rows wait for the first host answer.
    const view = viewFromLive(undefined)
    expect(view.steps).toEqual([])
    expect(view.total).toBe(0)
    expect(view.bar).toBe('none')
    // Live, though: the call IS in flight, and the header says so.
    expect(view.running).toBe(true)
    expect(view.instrumented).toBe(false)
    expect(view.refused).toBe(false)
    expect(view.currentIndex).toBe(-1)
  })

  it('draws the host\'s rows once it answers, and a bar to go with them', () => {
    // The pin for the whole change: NOTHING before metadata, the host's own rows
    // after — never a heuristic split in between.
    const before = viewFromLive(undefined)
    expect(before.steps).toHaveLength(0)
    expect(before.bar).toBe('none')

    const after = viewFromLive(snapshot())
    expect(after.bar).toBe('segments')
    expect(after.total).toBe(2)
    expect(after.steps.map((step) => step.line)).toEqual([1, 5])
    expect(after.steps.map((step) => step.text)).toEqual(['$a = 1', 'Write-Output $a'])
  })

  it('ignores a current line that is not one of the steps', () => {
    const view = viewFromLive(snapshot({ current: 99 }))
    expect(view.currentIndex).toBe(-1)
  })

  it('carries the partial flag through', () => {
    expect(viewFromLive(snapshot({ partial: true })).partial).toBe(true)
  })

  it('carries the refusal of a live record that planned no steps', () => {
    const view = viewFromLive(
      snapshot({ instrumented: false, refused: true, total: 0, steps: [], current: null }),
    )
    expect(view.refused).toBe(true)
    expect(view.instrumented).toBe(false)
    expect(view.steps).toEqual([])
    expect(view.total).toBe(0)
  })
})

describe('viewFromSettled', () => {
  const meta: ShellProgressMeta = {
    v: 1,
    instrumented: true,
    refused: false,
    partial: false,
    preamble: 'lead-in',
    steps: [
      { line: 1, text: '$a = 1', output: 'one', startedAt: 0, endedAt: 120 },
      { line: 5, text: 'Write-Output $a', output: 'two', startedAt: 120, endedAt: 900 },
    ],
  }

  it('derives durations from the persisted timings, with no live source', () => {
    const view = viewFromSettled(meta, false)
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
    }, false)
    expect(view.steps[0]?.tone).toBe('slow')
  })

  it('invents no rows when no metadata was persisted', () => {
    // An old persisted record, or a host that recorded nothing. The card shows
    // its header and the shell's own result output; it does NOT re-derive the
    // command's shape — that was the guess this change removed.
    const view = viewFromSettled(undefined, false)
    expect(view.instrumented).toBe(false)
    expect(view.refused).toBe(false)
    expect(view.steps).toEqual([])
    expect(view.total).toBe(0)
    expect(view.bar).toBe('none')
  })

  it('marks the last started step when the call failed', () => {
    const view = viewFromSettled(meta, true)
    expect(view.steps[1]?.phase).toBe('failed')
  })

  it('leaves a step the command never reached as pending', () => {
    const view = viewFromSettled({
      ...meta,
      steps: [
        { line: 1, text: '$a = 1', output: '', startedAt: 0, endedAt: 5 },
        { line: 5, text: 'Write-Output $a', output: '', startedAt: null, endedAt: null },
      ],
    }, false)
    expect(view.steps[1]?.phase).toBe('pending')
  })

  it('builds a zero-step view from a REFUSED record, so the refusal survives it', () => {
    // A refusal plans NO step, so this metadata's step list is empty — exactly the
    // case that used to collapse to an empty view, and (with the old `total > 1`
    // notice) to no notice at all.
    const view = viewFromSettled(
      { v: 1, instrumented: false, refused: true, partial: false, preamble: '', steps: [] },
      false,
    )
    expect(view.refused).toBe(true)
    expect(view.instrumented).toBe(false)
    expect(view.steps).toEqual([])
    expect(view.total).toBe(0)
    expect(view.bar).toBe('none')
  })

  it('keeps the refusal REASON through the settled record, so the tooltip can state it', () => {
    // Narrowing is field by field here, and a field left out of it is silently lost — which
    // is exactly what happened to the reason: the live card had it, the reloaded card did not.
    const meta = metaOf({
      meta: { v: 1, instrumented: false, refused: true, refusedReason: 'unbalanced', partial: false, preamble: '', steps: [] },
    })
    expect(meta?.refusedReason).toBe('unbalanced')
    // A code this client has no wording for is NOT passed on: the card would translate a
    // reason it does not know, and the generic sentence is the honest fallback.
    const unknown = metaOf({ meta: { v: 1, refused: true, refusedReason: 'quantum', steps: [] } })
    expect(unknown?.refusedReason).toBeUndefined()
  })

  it('does not call an ordinary single-step command refused', () => {
    const view = viewFromSettled({
      v: 1,
      instrumented: false,
      refused: false,
      partial: false,
      preamble: '',
      steps: [{ line: 1, text: "Write-Output 'one'", output: 'one', startedAt: 0, endedAt: 5 }],
    }, false)
    expect(view.refused).toBe(false)
    expect(view.instrumented).toBe(false)
    expect(view.total).toBe(1)
    // ...and it gets a bar with its one segment, finished: the counter reads 1/1 and
    // the segment is `done`, which is what a one-line command's card must show.
    expect(view.bar).toBe('segments')
    expect(view.steps.map((step) => step.phase)).toEqual(['done'])
    expect(view.done).toBe(1)
  })

  it('carries the count of what a truncated step lost, and reads an old record as complete', () => {
    const truncated = viewFromSettled({
      v: 1,
      instrumented: true,
      refused: false,
      partial: true,
      preamble: '',
      steps: [{ line: 1, text: 'chatty', output: 'kept', droppedChars: 1234, startedAt: 0, endedAt: 5 }],
    }, false)
    expect(truncated.steps[0]?.droppedChars).toBe(1234)
    // A record persisted BEFORE the field existed reads as a step that lost nothing,
    // which is what keeps an already-written session rendering exactly as it did.
    const older = viewFromSettled({
      v: 1,
      instrumented: true,
      refused: false,
      partial: false,
      preamble: '',
      steps: [{ line: 1, text: 'quiet', output: 'kept', startedAt: 0, endedAt: 5 }],
    }, false)
    expect(older.steps[0]?.droppedChars).toBe(0)
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

  it('keeps a REFUSED metadata whose step list is empty, and reads its flag', () => {
    // The only metadata with no steps: a refusal planned none, and that emptiness
    // IS the answer. Dropping it here would send the card back to the command's own
    // shape and lose the refusal.
    const refused = metaOf({
      kind: 'tool-result',
      meta: { v: 1, instrumented: false, refused: true, partial: false, preamble: '', steps: [] },
    })
    expect(refused?.refused).toBe(true)
    expect(refused?.instrumented).toBe(false)
    expect(refused?.steps).toEqual([])
  })

  it('drops a malformed step row instead of the whole metadata', () => {
    const meta = metaOf({
      kind: 'tool-result',
      meta: { steps: [{ line: 1, text: 'x', output: 'y' }, { line: 'bad' }] },
    })
    expect(meta?.steps).toHaveLength(1)
  })

  it('keeps the notes ROUTE, so a card can ask for notes it never got', () => {
    // Same trap as the refusal reason: a field left out of the field-by-field narrowing is
    // silently lost, and the card then has no way to request its own notes at all.
    const step = { line: 1, text: 'x', output: '', startedAt: 0, endedAt: 1 }
    const meta = metaOf({
      kind: 'tool-result',
      meta: { steps: [step], notesRoute: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    expect(meta?.notesRoute).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    // A route missing either half is not usable: asking with it would fail, quietly.
    expect(metaOf({ kind: 'tool-result', meta: { steps: [step], notesRoute: { provider: 'deepseek' } } })?.notesRoute).toBeUndefined()
    expect(metaOf({ kind: 'tool-result', meta: { steps: [step], notesRoute: { provider: '', model: 'x' } } })?.notesRoute).toBeUndefined()
    expect(metaOf({ kind: 'tool-result', meta: { steps: [step], notesRoute: 'nonsense' } })?.notesRoute).toBeUndefined()
  })
})

describe('withNotes', () => {
  /** A settled view whose steps carry no notes at all. */
  const bare = () => viewFromSettled({
    v: 1,
    instrumented: true,
    refused: false,
    partial: false,
    preamble: '',
    steps: [
      { line: 1, text: 'pnpm test', output: '', startedAt: 0, endedAt: 5 },
      { line: 2, text: 'pnpm build', output: '', startedAt: 5, endedAt: 9 },
    ],
  }, false)

  it('fills the lines that had no note', () => {
    const view = withNotes(bare(), ['跑测试', undefined])
    expect(view.steps.map((step) => step.note)).toEqual(['跑测试', undefined])
  })

  it('carries the host\'s display-only line breaks through to the row', () => {
    // The one-liner is still ONE step; only how it renders changes. `text` must stay exactly
    // what ran, so a copy of the command is never altered by the reformatting.
    const view = viewFromSettled({
      v: 1,
      instrumented: false,
      refused: false,
      partial: false,
      preamble: '',
      steps: [{
        line: 1,
        text: 'cd X; build; test',
        displayText: 'cd X; \nbuild; \ntest',
        output: '',
        startedAt: 0,
        endedAt: 5,
      }],
    }, false)
    expect(view.total).toBe(1)
    expect(view.steps[0]?.text).toBe('cd X; build; test')
    expect(view.steps[0]?.displayText).toBe('cd X; \nbuild; \ntest')
  })

  it('never overwrites a note the reader has already seen', () => {
    // The persisted note and the late one come from the same model and instruction; a
    // re-rolled sentence would flicker for nothing.
    const original = bare()
    const withNote = {
      ...original,
      steps: original.steps.map((step, index) => index === 0 ? { ...step, note: '已有' } : step),
    }
    expect(withNotes(withNote, ['迟到的', '构建']).steps.map((step) => step.note)).toEqual(['已有', '构建'])
  })

  it('returns the SAME object when the answer adds nothing', () => {
    const view = bare()
    expect(withNotes(view, [undefined, undefined])).toBe(view)
  })
})
