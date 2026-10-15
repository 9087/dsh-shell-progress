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
    expect(snapshot?.instrumented).toBe(false)
    expect(snapshot?.steps).toEqual([])
    expect(snapshot?.total).toBe(0)
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
