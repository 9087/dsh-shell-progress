/**
 * Pure derivation from either data source to one view model.
 *
 * The card has two sources of the same truth: the persisted
 * `presentationMeta` of a settled call (which is what makes a reloaded session
 * rebuild the card) and the host's live snapshot of a running one. Both are
 * normalized here, so the components never branch on where the numbers came
 * from — and both are narrowed defensively, because a card must degrade, not
 * crash, when a wire value or a logged value is not the shape this version
 * expects.
 *
 * ## The card never guesses at the steps
 *
 * The browser cannot run a parser: the grammar is a wasm artifact the HOST
 * loads, and the client bundle is browser-pure by invariant. So there is no
 * authoritative statement list on this side, and the heuristic splitter that
 * used to fill the gap — `splitSteps` from `../split.ts` — is deliberately NOT
 * called here any more. It was a second, independent answer to "where does a
 * top-level statement begin?", drawn before the host had said anything, and a
 * wrong boundary is exactly the defect the host-side planners exist to avoid.
 *
 * What the card shows before the host answers is therefore NOTHING beyond its
 * own header: no bar, no rows. Both appear with the first host answer — the live
 * snapshot while the command runs, the persisted metadata once it has settled.
 * A settled record that carries no step metadata (an old persisted record, or a
 * command whose metadata was dropped) keeps its header and its notice and shows
 * no steps, which is the honest reading: the host recorded no steps for it.
 *
 * @module dsh-shell-progress/client/model
 */

import type { LiveSnapshot, ShellProgressMeta, StepProgress } from '../types.ts'

/** The tool arguments this plugin reads back off a call block. */
export interface ToolArgs {
  readonly command: string
  readonly description: string | undefined
  readonly workdir: string | undefined
}

/** Above this many steps the bar stops drawing one segment per step. */
export const MAX_SEGMENTS = 40

/** How the bar renders a command of this size. */
export type BarShape = 'segments' | 'solid' | 'none'

/**
 * Choose the bar's form from the step count.
 *
 * Width is split EQUALLY, never by duration: unexecuted steps have no duration
 * yet, so a duration-proportional layout would jump around and degenerate into
 * a flame chart. Past {@link MAX_SEGMENTS} a segment is too thin to read (or
 * to hover), so the bar degrades to a single fill meaning "how far along".
 * @param total - number of top-level steps.
 * @returns the bar's shape.
 */
export function barShape(total: number): BarShape {
  if (total <= 1) return 'none'
  if (total > MAX_SEGMENTS) return 'solid'
  return 'segments'
}

/**
 * The discrete duration band of a step. Three levels, because the design
 * system exposes discrete semantic states and a continuous green→red ramp
 * would need new shared tokens.
 */
export type DurationTone = 'normal' | 'slow' | 'overdue'

/** A step that ran this long is "slow". */
const SLOW_MS = 5_000
/** A step that ran this long is "overdue" — the case the bar exists for. */
const OVERDUE_MS = 30_000

/**
 * Classify a duration into one of three bands.
 * @param milliseconds - how long the step ran, or has been running.
 * @returns the band.
 */
export function durationTone(milliseconds: number): DurationTone {
  if (milliseconds >= OVERDUE_MS) return 'overdue'
  if (milliseconds >= SLOW_MS) return 'slow'
  return 'normal'
}

/** What a step is doing now. */
export type StepPhase = 'pending' | 'running' | 'done' | 'failed'

/** One rendered step. */
export interface StepRow {
  /** 1-based index among the steps (not the source line). */
  readonly index: number
  /** Original 1-based line number in the command. */
  readonly line: number
  /** The source line. */
  readonly text: string
  /** Output attributed to this step. */
  readonly output: string
  /** What the step is doing now. */
  readonly phase: StepPhase
  /** Milliseconds it took, or has been running for. */
  readonly durationMs: number
  /** The duration band, for the discrete colour level. */
  readonly tone: DurationTone
}

/** Everything one card renders. */
export interface ProgressView {
  readonly steps: readonly StepRow[]
  readonly preamble: string
  /** False when the command ran unmodified (a refusal, or a single-line command). */
  readonly instrumented: boolean
  /**
   * True when instrumentation was REFUSED, as opposed to a command that had
   * nothing to instrument. This is what the card's "ran unmodified" notice is
   * driven by: a refused command's step list is empty, so a count cannot say it.
   */
  readonly refused: boolean
  /** True when some output could not be attributed. */
  readonly partial: boolean
  /** True while the command is still running. */
  readonly running: boolean
  /** Index of the running step, or -1. */
  readonly currentIndex: number
  /** How many steps are finished. */
  readonly done: number
  readonly total: number
  /** Milliseconds the running step has been running; 0 when nothing is running. */
  readonly currentElapsedMs: number
  readonly bar: BarShape
}

/** One normalized step before phases are assigned. */
interface Row {
  readonly line: number
  readonly text: string
  readonly output: string
  readonly startedAt: number | null
  readonly endedAt: number | null
}

/**
 * Assemble the view from normalized rows and the run's liveness.
 * @param rows - the steps, in source order.
 * @param state - liveness, the current index, and the elapsed reading.
 * @returns the renderable view.
 */
function assembleRows(
  rows: readonly Row[],
  state: {
    readonly running: boolean
    readonly currentIndex: number
    readonly elapsedMs: number
    readonly instrumented: boolean
    readonly refused: boolean
    readonly partial: boolean
    readonly preamble: string
    readonly failedIndex: number
  },
): ProgressView {
  let done = 0
  const steps: StepRow[] = rows.map((row, index) => {
    const isCurrent = state.running && index === state.currentIndex
    const finished = row.endedAt !== null
    if (finished) done += 1
    const durationMs = isCurrent
      ? state.elapsedMs
      : row.startedAt === null
        ? 0
        : Math.max(0, (row.endedAt ?? row.startedAt) - row.startedAt)
    const phase: StepPhase = isCurrent
      ? 'running'
      : finished
        ? (index === state.failedIndex ? 'failed' : 'done')
        : row.startedAt !== null
          ? 'running'
          : 'pending'
    return {
      index: index + 1,
      line: row.line,
      text: row.text,
      output: row.output,
      phase,
      durationMs,
      tone: durationTone(durationMs),
    }
  })
  return {
    steps,
    preamble: state.preamble,
    instrumented: state.instrumented,
    refused: state.refused,
    partial: state.partial,
    running: state.running,
    currentIndex: state.currentIndex,
    done,
    total: rows.length,
    currentElapsedMs: state.running ? state.elapsedMs : 0,
    bar: barShape(rows.length),
  }
}

/**
 * Build the view for a settled call out of its persisted metadata.
 *
 * A settled call whose metadata is ABSENT (an old persisted record, or a host
 * that persisted nothing) yields a view with NO steps: the card shows its own
 * header and the result the shell renders beside it, and invents no rows. A
 * REFUSED call's metadata is present and carries zero steps, which is a
 * different fact — the refusal flag comes with it and drives the notice.
 * @param meta - the narrowed `presentationMeta`, when the call carried one.
 * @param isError - whether the call itself failed, so the last started step can be marked.
 * @returns the renderable view.
 */
export function viewFromSettled(
  meta: ShellProgressMeta | undefined,
  isError: boolean,
): ProgressView {
  const rows: Row[] = (meta?.steps ?? []).map((step) => ({
    line: step.line,
    text: step.text,
    output: step.output,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
  }))
  // The failing step is not recorded per step, so the last step that started
  // carries the mark; an untouched tail stays "not started", which is the
  // honest reading.
  let lastStarted = -1
  rows.forEach((row, index) => {
    if (row.startedAt !== null) lastStarted = index
  })
  return assembleRows(rows, {
    running: false,
    currentIndex: -1,
    elapsedMs: 0,
    instrumented: meta?.instrumented ?? false,
    refused: meta?.refused ?? false,
    partial: meta?.partial ?? false,
    preamble: meta?.preamble ?? '',
    failedIndex: isError ? lastStarted : -1,
  })
}

/**
 * Build the view for a running call out of the host's live snapshot.
 *
 * With NO snapshot (the host has no record yet, or gave no usable answer) the
 * view holds NO steps: `running` is still true — the call IS in flight, which is
 * what the header's own state shows — while the bar and the rows wait for the
 * first host answer instead of being guessed from the command text. See the
 * module header for why the browser must not guess.
 * @param live - the snapshot, when the host answered for this call.
 * @returns the renderable view.
 */
export function viewFromLive(live: LiveSnapshot | undefined): ProgressView {
  if (live === undefined || !live.found) {
    return assembleRows([], {
      running: true,
      currentIndex: -1,
      elapsedMs: 0,
      instrumented: false,
      // The host has not spoken about this call yet, so no refusal is claimed.
      refused: false,
      partial: false,
      preamble: '',
      failedIndex: -1,
    })
  }
  const rows: Row[] = live.steps.map((step) => ({
    line: step.line,
    text: step.text,
    output: step.output,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
  }))
  const currentLine = live.current
  let currentIndex = -1
  if (currentLine !== null) {
    const found = rows.findIndex((row) => row.line === currentLine)
    if (found >= 0) currentIndex = found
  }
  return assembleRows(rows, {
    running: live.running,
    currentIndex,
    elapsedMs: live.elapsedMs,
    instrumented: live.instrumented,
    refused: live.refused,
    partial: live.partial,
    preamble: live.preamble,
    failedIndex: -1,
  })
}

/**
 * Whether a tool call block is the settled arm.
 *
 * NOT `'kind' in block`. A RUNNING call carries `kind` too, so that test called
 * every live call settled: the row's effect returned early, `watchCall` was never
 * invoked, no poll ever ran, and the bar could not move while the probe line —
 * gated on a running view — never even rendered. The fixture's fabricated call had
 * no `kind`, which is why the e2e stayed green over it.
 *
 * What actually separates the two arms is the RESULT: a settled call carries the
 * tool message payload (`content`, and the persisted `meta` beside it), and a
 * running one carries only its raw arguments.
 * @param block - the call block to classify.
 * @returns true when the call has produced a result.
 */
export function isSettledBlock(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false
  const record = block as Record<string, unknown>
  // `kind: 'tool-result'` is the shell's own settled tag.
  //
  // NOT `'kind' in block`, which is what this once was: a RUNNING call carries a
  // kind of its own (`tool-call`), so a mere PRESENCE test called every live call
  // settled — the row's effect returned early, `watchCall` was never invoked, no
  // poll ever ran, and the probe line (gated on a running view) never rendered
  // either.
  if (record.kind === 'tool-result') return true
  // A block carrying the tool message payload is settled even without the tag.
  return 'content' in record || 'result' in record
}

/** Whether a settled block reports failure. */
export function isErrorBlock(block: unknown): boolean {
  return typeof block === 'object' && block !== null && (block as { isError?: unknown }).isError === true
}

/** Parse one `argsRaw` string, tolerating the truncation a live call can carry. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * Read this tool's arguments off a call block, whichever arm it is.
 *
 * `argsRaw` can be a truncated prefix while a call streams, and the settled
 * arm's `call` is null when the window dropped the call head — hence the
 * tolerant parse and the empty fallback.
 * @param block - the running or settled block.
 * @returns the arguments this card uses.
 */
export function argsOf(block: unknown): ToolArgs {
  if (typeof block !== 'object' || block === null) {
    return { command: '', description: undefined, workdir: undefined }
  }
  const record = block as Record<string, unknown>
  const call = typeof record.call === 'object' && record.call !== null
    ? record.call as Record<string, unknown>
    : undefined
  const parsed = parseArgs(record.argsRaw ?? call?.argsRaw)
  return {
    command: typeof parsed.command === 'string' ? parsed.command : '',
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    workdir: typeof parsed.workdir === 'string' ? parsed.workdir : undefined,
  }
}

/**
 * Narrow a call block's `presentationMeta` into this plugin's progress shape.
 * @param block - the settled block.
 * @returns the progress metadata, or undefined when it is absent or foreign.
 */
export function metaOf(block: unknown): ShellProgressMeta | undefined {
  const meta = (block as { meta?: unknown } | null)?.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  if (!Array.isArray(record.steps)) return undefined
  const steps: StepProgress[] = []
  for (const row of record.steps) {
    if (typeof row !== 'object' || row === null) continue
    const step = row as Record<string, unknown>
    if (typeof step.line !== 'number' || typeof step.text !== 'string' || typeof step.output !== 'string') continue
    steps.push({
      line: step.line,
      text: step.text,
      output: step.output,
      startedAt: typeof step.startedAt === 'number' ? step.startedAt : null,
      endedAt: typeof step.endedAt === 'number' ? step.endedAt : null,
    })
  }
  if (steps.length === 0) {
    // A REFUSED command's metadata carries ZERO steps, and that emptiness IS the
    // answer: the refusal planned nothing rather than guessing. Dropping the
    // metadata here would send the card back to the command's own shape and lose
    // the refusal, so the flag is what keeps an empty meta alive.
    if (record.refused !== true) return undefined
  }
  return {
    v: typeof record.v === 'number' ? record.v : 0,
    instrumented: record.instrumented === true,
    refused: record.refused === true,
    partial: record.partial === true,
    preamble: typeof record.preamble === 'string' ? record.preamble : '',
    steps,
  }
}
