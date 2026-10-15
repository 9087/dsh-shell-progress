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
  /** True when the consumed stream lost bytes, so attribution may be incomplete. */
  readonly partial: boolean
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
  /** Whether the consumed stream lost bytes. */
  readonly partial: boolean
  /** Line number of the step executing now, or null before the first marker. */
  readonly current: number | null
  /** Number of top-level steps the command was split into. */
  readonly total: number
  /** Milliseconds the current step has been running; 0 when no step has started. */
  readonly elapsedMs: number
  /** Output produced before the first step's marker. */
  readonly preamble: string
  /** Steps with everything observed so far. */
  readonly steps: readonly StepProgress[]
}
