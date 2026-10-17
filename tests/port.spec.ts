/**
 * One narrow question about the wire: the refusal flag.
 *
 * A refused command's step list is EMPTY, so the flag is the only thing on the live
 * snapshot that can tell a refused call from one that simply had nothing to show.
 * It has to survive the defensive narrowing — and nothing that is not an explicit
 * `true` may be read as a refusal, because the notice it drives claims the command
 * ran unmodified.
 */

import { describe, expect, it } from 'vitest'
import { emptySnapshot, snapshotOf } from '../src/client/port.ts'

/** A well-formed live record for a refused call: no steps, and the flag. */
const REFUSED = {
  found: true,
  running: false,
  instrumented: false,
  refused: true,
  refusedReason: 'syntax-error',
  partial: false,
  current: null,
  total: 0,
  elapsedMs: 0,
  preamble: '',
  steps: [],
}

describe('snapshotOf', () => {
  it('carries the refusal of a zero-step record through', () => {
    const snapshot = snapshotOf(REFUSED)
    expect(snapshot?.refused).toBe(true)
    expect(snapshot?.refusedReason).toBe('syntax-error')
    expect(snapshot?.instrumented).toBe(false)
    expect(snapshot?.steps).toEqual([])
    expect(snapshot?.total).toBe(0)
  })

  it('drops a refusal reason this client has no wording for', () => {
    // A newer host may add a code; guessing one would put a wrong sentence in the tooltip,
    // and the generic sentence is what an absent code already covers.
    expect(snapshotOf({ ...REFUSED, refusedReason: 'quantum-entanglement' })?.refusedReason).toBeNull()
    expect(snapshotOf({ ...REFUSED, refusedReason: undefined })?.refusedReason).toBeNull()
    expect(snapshotOf({ ...REFUSED, refusedReason: 3 })?.refusedReason).toBeNull()
  })

  it('reads anything but an explicit true as not refused', () => {
    expect(snapshotOf({ ...REFUSED, refused: 'yes' })?.refused).toBe(false)
    expect(snapshotOf({ ...REFUSED, refused: 1 })?.refused).toBe(false)
    expect(snapshotOf({ ...REFUSED, refused: undefined })?.refused).toBe(false)
  })

  it('leaves the refusal off an answer that is not about this call', () => {
    // "I hold no record of this call" is usable information, but it says nothing
    // about a refusal — the card must not claim one from silence.
    expect(snapshotOf({ found: false })?.refused).toBe(false)
    expect(emptySnapshot().refused).toBe(false)
  })
})

/**
 * The LIVE half of the model note.
 *
 * A note is attached to the host's tracker while the command is still RUNNING, so the only
 * way it can reach the card before the command settles is this wire. It was dropped here
 * once, which is why a note appeared only after the run was over — and nothing else in the
 * suite could see it, because the settled card reads its notes from the persisted meta
 * rather than from this snapshot.
 */
describe('a live step row', () => {
  /**
   * One live record with a single step.
   * @param note - the note to attach, or omitted for a step that has none.
   * @returns the wire value.
   */
  const row = (note?: unknown) => ({
    found: true,
    running: true,
    instrumented: true,
    refused: false,
    partial: false,
    current: 1,
    total: 1,
    elapsedMs: 10,
    preamble: '',
    steps: [
      {
        line: 1,
        text: 'pnpm run build',
        output: '',
        startedAt: 0,
        endedAt: null,
        ...note === undefined ? {} : { note },
      },
    ],
  })

  it('carries the model note through to the live snapshot', () => {
    expect(snapshotOf(row('构建产物'))?.steps[0]?.note).toBe('构建产物')
  })

  it('drops a note that is not a non-empty string', () => {
    expect(snapshotOf(row(42))?.steps[0]?.note).toBeUndefined()
    expect(snapshotOf(row(''))?.steps[0]?.note).toBeUndefined()
    expect(snapshotOf(row())?.steps[0]?.note).toBeUndefined()
  })
})
