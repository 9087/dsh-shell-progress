/**
 * Vocabulary shared by this plugin's two halves. Deliberately free of any
 * Node or DOM import: the host half persists these values, the browser half
 * reads them back out of the session log, and both must agree byte for byte.
 *
 * @module dsh-shell-progress/types
 */

/** The wire name of the PowerShell tool. Also the client slot key. */
export const TOOL_NAME_PWSH = 'shell_progress_pwsh'

/** The wire name of the bash tool. Also the client slot key. */
export const TOOL_NAME_BASH = 'shell_progress_bash'

/**
 * Every wire name this plugin registers.
 *
 * The client must key a toolview on EACH one: a call whose name has no view falls
 * back to the generic tool card, so a name added here without a matching entry
 * there renders as a plain tool row with no progress bar at all.
 */
export const TOOL_NAMES: readonly string[] = [TOOL_NAME_PWSH, TOOL_NAME_BASH]

/**
 * The logical RPC channel the host half serves and the browser half polls.
 *
 * A standalone plugin cannot receive host events: the shell's forwarded-event
 * allowlist is a static array inside the DSH build, with no plugin-facing
 * registration point. Request/response on an authenticated channel is the
 * supported path, and it is what `dsh-diff-approval` does too.
 */
export const PROGRESS_CHANNEL = '/shell-progress'

/** Version of {@link ShellProgressMeta} — bumped when its shape changes. */
export const META_VERSION = 1

/** One top-level step of a command, as split from the source text. */
export interface StepLine {
  /** 1-based line number in the ORIGINAL command text. */
  readonly line: number
  /** The line's text, without its terminator. */
  readonly text: string
}

/** One step plus everything observed about it while the command ran. */
export interface StepProgress extends StepLine {
  /**
   * Output attributed to this step: the lines that followed this step's marker
   * and preceded the next one's. Capped — see `maxStepOutputBytes`.
   */
  readonly output: string
  /**
   * One line of plain language describing what this step's command does, written by the
   * model (`src/llm-notes.ts`).
   *
   * ABSENT IS THE CONTRACT. There is no note when the host has no llm service, when the
   * call failed or timed out, and when the feature is switched off — and the card shows a
   * note or nothing, never a placeholder. Optional on the wire for the same reason
   * `droppedChars` is: a record persisted before this existed still validates.
   */
  readonly note?: string
  /**
   * The same text with DISPLAY-ONLY line breaks at its top-level `;` boundaries, or absent.
   *
   * The step is one line because the planner is line-based (see `src/plan.ts`), and an agent
   * that writes `build; echo; test; echo; report` as one line gets one enormous row. This
   * field carries the same characters with newlines inserted so the card can render it
   * readably; `text` stays byte-for-byte what ran and nothing here is ever executed.
   */
  readonly displayText?: string
  /**
   * Characters the per-step output budget DISCARDED, or absent/0 when nothing was.
   *
   * This is what lets the card state the cut at the cut: `output` alone cannot say
   * whether it is everything the step printed or the part that fit. Optional on the
   * wire so a record persisted before this existed still validates — the schema
   * declares it, and the client reads a missing value as "nothing was dropped".
   */
  readonly droppedChars?: number
  /**
   * Monotonic milliseconds since the run began, or null while the step has not
   * started. Wall-clock would break on a system-time jump, so it is never used.
   */
  readonly startedAt: number | null
  /**
   * Monotonic milliseconds since the run began; null means "not finished",
   * which covers both the running step and the steps never reached.
   * Semantically equal to the next step's `startedAt`.
   */
  readonly endedAt: number | null
}

/**
 * The durable, replay-safe progress of one call. Persisted verbatim as the
 * tool result's `presentationMeta`, so a session reload rebuilds the whole
 * card — step lines, per-step output and per-step durations — from the log
 * alone.
 */
/**
 * Why a command was not instrumented, as a CODE rather than a sentence.
 *
 * The card shows the reason in the `!` tooltip, and the tooltip is written in the reader's
 * language. A persisted sentence would come back in whichever language the writing host
 * happened to use, so the wire carries the fact and the CLIENT owns the wording.
 */
export type RefusalCode =
  | 'block-comment'
  | 'here-string'
  | 'line-continuation'
  | 'unterminated-quote'
  | 'unbalanced'
  | 'syntax-error'
  | 'no-answer'
  | 'unsplittable'
  | 'too-many-steps'
  | 'already-instrumented'
  | 'reserved-variable'
  | 'read-only'

/**
 * The provider/model pair behind one card's notes.
 *
 * A card's notes are normally written while the command runs, but a command that finishes
 * before the model answers has none persisted — the card then asks for them itself, later,
 * and needs to know which route wrote (or may write) them. Recorded here, once per card,
 * because the tool's own run context is long gone by the time that request is made.
 */
export interface NotesRoute {
  readonly provider: string
  readonly model: string
}

/**
 * How one card's note request ended.
 *
 * TEMPORARY DIAGNOSTIC. A note is silent by design, which makes "the model had nothing to
 * say" and "our request never came back" look identical from the card — and a host's log is
 * not something a reader can open. Recording the outcome in the persisted metadata makes the
 * next failure diagnosable from the session log alone. `'ok'` means notes were written; every
 * other value is the reason they were not.
 */
export type NotesState = 'ok' | 'aborted' | 'timeout' | 'threw' | 'empty'

export interface ShellProgressMeta {
  /** {@link META_VERSION} at the time of writing. */
  readonly v: number
  /** False when the command ran unmodified and only step attribution is missing. */
  readonly instrumented: boolean
  /**
   * True when instrumentation was REFUSED for a command that had boundaries to
   * decide — a dialect planner that could not deliver a parse, a structure the
   * splitter cannot decide, a command already carrying a marker or the reserved
   * variable, a read-only sandbox.
   *
   * This is the card's "ran unmodified" notice, and it has to be its OWN field:
   * a refused command's step list is legitimately EMPTY (a refusal is not a
   * guess, so no step is planned), which is why no step count can stand in for
   * it. An ordinary single-step command is uninstrumented with `refused: false`,
   * and its card stays quiet.
   */
  readonly refused: boolean
  /** Why it was refused, when it was — absent on a command that was instrumented. */
  readonly refusedReason?: RefusalCode
  /** The route a later request for this card's notes must use, when notes were offered. */
  readonly notesRoute?: NotesRoute
  /** How the note request ended, when one was made (see {@link NotesState}). */
  readonly notesState?: NotesState
  /** True when the consumed stream lost bytes, so attribution may be incomplete. */
  readonly partial: boolean
  /**
   * Wall-clock milliseconds the whole command took: the first step's start to the last
   * step's end, gaps included. Absent on a record written before this field existed, and on
   * a command whose steps never started.
   */
  readonly elapsedMs?: number
  /** Output produced before the first step's marker. Usually empty. */
  readonly preamble: string
  /**
   * The top-level steps, in source order. A plain array because this value is
   * validated against the tool's declared output schema, which declares one.
   */
  readonly steps: StepProgress[]
}

/**
 * The live view of one in-flight call, answered by the host's `snapshot`
 * endpoint. Only the CURRENT POSITION and the elapsed time change over the
 * life of a call; everything else is already known from the arguments.
 */
export interface LiveSnapshot {
  /** False when the host holds no record for this call (already evicted, or another host). */
  readonly found: boolean
  /** True until the command settles. */
  readonly running: boolean
  /** Whether the executed text carried step markers. */
  readonly instrumented: boolean
  /** Whether instrumentation was refused — see {@link ShellProgressMeta.refused}. */
  readonly refused: boolean
  /** Why it was refused, when it was — see {@link ShellProgressMeta.refusedReason}. */
  readonly refusedReason: RefusalCode | null
  /** Whether the consumed stream lost bytes. */
  readonly partial: boolean
  /** Line number of the step executing now, or null before the first marker. */
  readonly current: number | null
  /**
   * 1-based INDEX of the step executing now, or null before the first marker.
   *
   * The index is what the client needs: a rewritten `;` chain puts several steps on one
   * original line, so `current` alone cannot say which row is running. Optional for a host
   * that predates the field; the client then falls back to matching `current` against rows.
   */
  readonly currentStep?: number | null
  /** Number of top-level steps the command was split into. */
  readonly total: number
  /** Milliseconds the current step has been running; 0 when no step has started. */
  readonly elapsedMs: number
  /** Wall-clock milliseconds since the first step started; 0 before the first marker. */
  readonly totalElapsedMs?: number
  /** Output produced before the first step's marker. */
  readonly preamble: string
  /** Steps with everything observed so far. */
  readonly steps: readonly StepProgress[]
}
