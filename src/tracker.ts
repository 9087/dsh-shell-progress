/**
 * Step attribution: which step is running, what each step printed, and how
 * long each one took.
 *
 * Timing uses a MONOTONIC clock (milliseconds since the run began). A
 * wall-clock reading would let a system-time adjustment produce a negative
 * duration, and the bar's whole point is the duration.
 *
 * @module dsh-shell-progress/tracker
 */

import type { StreamEvent } from './parse.ts'
import type { Step } from './split.ts'
import type { StepProgress } from './types.ts'

/** One step's mutable bookkeeping. */
interface StepState {
  readonly line: number
  readonly text: string
  readonly lines: string[]
  chars: number
  /**
   * Characters the per-step budget DISCARDED, counted the way {@link chars} counts
   * them (each dropped line plus the newline it ended with). It is what the card
   * states at the cut, so a reader can tell a truncated step from a complete one.
   */
  droppedChars: number
  startedAt: number | null
  endedAt: number | null
}

/** Construction options for a {@link StepTracker}. */
export interface StepTrackerOptions {
  /** Monotonic clock, milliseconds. Defaults to `performance.now()`. */
  readonly now?: () => number
  /** Per-step output budget, in characters. Defaults to 8192. */
  readonly maxStepOutputChars?: number
}

const DEFAULT_MAX_STEP_OUTPUT_CHARS = 8192

/** The default monotonic clock: `performance.now()` is monotonic by definition. */
function defaultClock(): number {
  return performance.now()
}

/**
 * Folds a stream of step switches and output lines into per-step progress.
 *
 * Attribution rule: an output line belongs to the most recent step marker
 * seen before it, and lines that precede the first marker belong to the
 * preamble — they were produced before any step had announced itself.
 */
export class StepTracker {
  private readonly states: StepState[]
  private readonly now: () => number
  private readonly maxStepOutputChars: number
  private readonly preambleLines: string[] = []
  private cursor: number | null = null
  private overBudget = false

  constructor(steps: readonly Step[], options: StepTrackerOptions = {}) {
    this.now = options.now ?? defaultClock
    this.maxStepOutputChars = options.maxStepOutputChars ?? DEFAULT_MAX_STEP_OUTPUT_CHARS
    this.states = steps.map((step) => ({
      line: step.line,
      text: step.text,
      lines: [],
      chars: 0,
      droppedChars: 0,
      startedAt: null,
      endedAt: null,
    }))
  }

  /** Apply one parsed event. */
  observe(event: StreamEvent): void {
    if (event.kind === 'marker') {
      this.mark(event.line)
      return
    }
    this.append(event.text)
  }

  /**
   * Line number of the step running now, or null before the first marker.
   * @returns the current step's original line number.
   */
  current(): number | null {
    return this.cursor === null ? null : (this.states[this.cursor]?.line ?? null)
  }

  /**
   * Milliseconds the current step has been running.
   * @param at - a reading from the same monotonic clock.
   * @returns the elapsed time, frozen once the step has settled; 0 when no step has started.
   */
  elapsed(at: number): number {
    const state = this.cursor === null ? undefined : this.states[this.cursor]
    if (state === undefined || state.startedAt === null) return 0
    // A settled step keeps the duration it actually took: reading a growing
    // number off a finished step would make a still card look like it is
    // still moving.
    return Math.max(0, (state.endedAt ?? at) - state.startedAt)
  }

  /**
   * Close the step that is still running, so its duration is final. Idempotent.
   */
  settle(): void {
    const state = this.cursor === null ? undefined : this.states[this.cursor]
    if (state !== undefined && state.endedAt === null) state.endedAt = this.now()
  }

  /**
   * Begin the ONE step of a run that cannot announce itself.
   *
   * A single-line command is never instrumented — there is no order to keep, so no
   * marker is written — and that left its only step with no `startedAt` at all. The
   * card then had nothing to colour: its step could only ever read "pending", its
   * counter `0/1` even on a finished command, and the bar drew no segment to say
   * otherwise (`barShape` suppressed one step). This stamps the step the run begins
   * with, and {@link settle} closes it, so the one segment runs pending → running →
   * done like any other.
   *
   * A no-op unless the run has exactly one step: with more than one, the markers are
   * what say which is running, and guessing the first would be a lie.
   */
  beginSoleStep(): void {
    const only = this.states.length === 1 ? this.states[0] : undefined
    if (only !== undefined) this.mark(only.line)
  }

  /** Output produced before the first marker. */
  preamble(): string {
    return joinLines(this.preambleLines)
  }

  /** Whether any per-step output was dropped to stay inside the budget. */
  droppedOutput(): boolean {
    return this.overBudget
  }

  /**
   * The steps with everything observed so far, as plain JSON-ready data.
   * @returns a fresh array of fresh objects.
   */
  steps(): readonly StepProgress[] {
    return this.states.map((state) => ({
      line: state.line,
      text: state.text,
      output: joinLines(state.lines),
      droppedChars: state.droppedChars,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
    }))
  }

  /** Index of the step whose original line number is `line`, or -1. */
  private indexOf(line: number): number {
    return this.states.findIndex((state) => state.line === line)
  }

  /** Switch the cursor to `line` and stamp the transition. */
  private mark(line: number): void {
    const index = this.indexOf(line)
    // A marker for a line this run never instrumented is not ours to act on.
    if (index < 0) return
    // Instrumentation is top-level only, so one step can never announce
    // itself twice; ignoring a repeat keeps a loop from restarting a step.
    if (this.cursor === index) return
    const at = this.now()
    const previous = this.cursor === null ? undefined : this.states[this.cursor]
    if (previous !== undefined && previous.endedAt === null) previous.endedAt = at
    this.cursor = index
    const state = this.states[index]
    if (state === undefined) return
    if (state.startedAt === null) state.startedAt = at
    else state.endedAt = null
  }

  /** Attribute one output line to the current step, or to the preamble. */
  private append(line: string): void {
    if (this.cursor === null) {
      this.preambleLines.push(line)
      return
    }
    const state = this.states[this.cursor]
    if (state === undefined) return
    if (state.chars + line.length > this.maxStepOutputChars) {
      // DROPPED, and counted: the card says how much it is not showing. The count is
      // `line.length + 1` because that is exactly what the budget would have charged
      // this line (`chars` below), so "kept + dropped" is the run's real output size.
      this.overBudget = true
      state.droppedChars += line.length + 1
      return
    }
    state.lines.push(line)
    state.chars += line.length + 1
  }
}

/** Join buffered lines the way they arrived, as a text block with no trailing newline. */
function joinLines(lines: readonly string[]): string {
  return lines.join('\n')
}
