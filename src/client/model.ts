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

import type { LiveSnapshot, NotesRoute, RefusalCode, ShellProgressMeta, StepProgress } from '../types.ts'
import { refusalCodeOf } from './port.ts'

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
 *
 * ONE step is one SEGMENT, not "no bar". A single-line command has exactly one
 * step, and the one segment still answers what the card is for: it is pending,
 * then running with the command's clock beside it, then done — and its hover card
 * carries that command and its output like any other segment's. Only ZERO steps
 * draws nothing, because there is nothing to draw: that is the moment before the
 * host has answered, and a bar then would be a guess.
 * @param total - number of top-level steps.
 * @returns the bar's shape.
 */
export function barShape(total: number): BarShape {
  if (total < 1) return 'none'
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
  /**
   * The same characters with display-only line breaks at top-level `;` boundaries, when the
   * host sent one (see the host's `src/wrap.ts`). Rendering prefers it; `text` stays exact.
   */
  readonly displayText?: string
  /** Output attributed to this step. */
  readonly output: string
  /**
   * Characters the host's per-step budget dropped from that output; 0 when the step's
   * output is complete. The row states this at the cut, so a truncated step cannot be
   * mistaken for a step that printed little.
   */
  readonly droppedChars: number
  /**
   * The model's one line about what this command does, or absent when there is none
   * (see the host's `src/llm-notes.ts`). ABSENT IS THE CONTRACT: the card draws a
   * comment line for a note and nothing at all without one.
   */
  readonly note?: string
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
  /** Why it was refused, as a code the row translates; absent unless something was refused. */
  readonly refusedReason?: RefusalCode
  /**
   * The route a LAZY notes request must use for this card, when the host recorded one.
   *
   * Absent means the card has no way to ask for notes later (no route was available when the
   * command ran, or the record predates this field), so it simply shows none.
   */
  readonly notesRoute?: NotesRoute
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
  /**
   * Wall-clock milliseconds the whole command has taken so far (or took), gaps between
   * steps included; 0 when nothing is known. The header states it beside the description.
   */
  readonly totalElapsedMs: number
  readonly bar: BarShape
}

/** One normalized step before phases are assigned. */
interface Row {
  readonly line: number
  readonly text: string
  /** Display-only line breaks, when the host judged the one line worth reformatting. */
  readonly displayText?: string
  readonly output: string
  readonly droppedChars: number
  /** Carried through unchanged: how to SHOW a note is the render's business, not this layer's. */
  readonly note?: string
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
    /** Wall-clock total so far; 0 when the host has not said. */
    readonly totalElapsedMs: number
    readonly instrumented: boolean
    readonly refused: boolean
    readonly refusedReason?: RefusalCode
    readonly notesRoute?: NotesRoute
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
      ...row.displayText === undefined ? {} : { displayText: row.displayText },
      output: row.output,
      droppedChars: row.droppedChars,
      ...row.note === undefined ? {} : { note: row.note },
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
    ...state.refusedReason === undefined ? {} : { refusedReason: state.refusedReason },
    ...state.notesRoute === undefined ? {} : { notesRoute: state.notesRoute },
    partial: state.partial,
    running: state.running,
    currentIndex: state.currentIndex,
    done,
    total: rows.length,
    currentElapsedMs: state.running ? state.elapsedMs : 0,
    totalElapsedMs: state.totalElapsedMs,
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
    ...step.displayText === undefined ? {} : { displayText: step.displayText },
    output: step.output,
    droppedChars: step.droppedChars ?? 0,
    ...step.note === undefined ? {} : { note: step.note },
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
    ...meta?.refusedReason === undefined ? {} : { refusedReason: meta.refusedReason },
    ...meta?.notesRoute === undefined ? {} : { notesRoute: meta.notesRoute },
    partial: meta?.partial ?? false,
    preamble: meta?.preamble ?? '',
    failedIndex: isError ? lastStarted : -1,
    totalElapsedMs: meta?.elapsedMs ?? 0,
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
      totalElapsedMs: 0,
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
    ...step.displayText === undefined ? {} : { displayText: step.displayText },
    output: step.output,
    droppedChars: step.droppedChars ?? 0,
    ...step.note === undefined ? {} : { note: step.note },
    startedAt: step.startedAt,
    endedAt: step.endedAt,
  }))
  const currentLine = live.current
  let currentIndex = -1
  // The step INDEX is authoritative: a rewritten `;` chain puts several steps on one
  // original line, so matching by line would light the wrong row. Line matching stays as
  // the fallback for a host that predates the index.
  const currentStep = live.currentStep
  if (typeof currentStep === 'number' && currentStep >= 1 && currentStep <= rows.length) {
    currentIndex = currentStep - 1
  } else if (currentLine !== null) {
    const found = rows.findIndex((row) => row.line === currentLine)
    if (found >= 0) currentIndex = found
  }
  return assembleRows(rows, {
    running: live.running,
    currentIndex,
    elapsedMs: live.elapsedMs,
    totalElapsedMs: live.totalElapsedMs ?? 0,
    instrumented: live.instrumented,
    refused: live.refused,
    ...live.refusedReason === null ? {} : { refusedReason: live.refusedReason },
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
 * Narrow the persisted notes route. Anything malformed is dropped: a card with a bad route
 * simply never asks, which is better than asking with a wrong provider or model name.
 * @param value - the raw `notesRoute` field.
 * @returns the route, or `undefined`.
 */
function notesRouteOf(value: unknown): NotesRoute | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.provider !== 'string' || record.provider.length === 0) return undefined
  if (typeof record.model !== 'string' || record.model.length === 0) return undefined
  return { provider: record.provider, model: record.model }
}

/**
 * The view with the notes a card asked for itself filled in.
 *
 * A LATE note answers for lines that had none; a line that already carries one keeps it — the
 * persisted note came from the same model and the same instruction, and overwriting a note the
 * reader has already seen with a re-rolled one would be a flicker with no gain.
 * @param view - the view as built from the record.
 * @param notes - the lazy answer, one entry per line.
 * @returns a view with the missing notes filled in (the same object when nothing changed).
 */
export function withNotes(view: ProgressView, notes: readonly (string | undefined)[]): ProgressView {
  let changed = false
  const steps = view.steps.map((row, index) => {
    if (row.note !== undefined) return row
    const note = notes[index]
    if (note === undefined) return row
    changed = true
    return { ...row, note }
  })
  return changed ? { ...view, steps } : view
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
      // Narrowed like everything else here, but NOT dropped: the card states this at the
      // cut, and a narrowing that quietly discarded it would leave every reloaded session
      // claiming a truncated step was complete.
      ...typeof step.droppedChars === 'number' && Number.isFinite(step.droppedChars) && step.droppedChars > 0
        ? { droppedChars: step.droppedChars }
        : {},
      // Narrowed the same way, and for the same reason: a reloaded session must keep the
      // notes it was written with, and a value that is not a non-empty string is not one.
      ...typeof step.note === 'string' && step.note.length > 0 ? { note: step.note } : {},
      // Narrowed like the note: a reloaded session must keep the line breaks its card was
      // written with, and anything that is not a non-empty string is not a reformatting.
      ...typeof step.displayText === 'string' && step.displayText.length > 0
        ? { displayText: step.displayText }
        : {},
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
  // Narrowed, NOT dropped: a reloaded session must still say WHY the command was refused,
  // and the code is what the card translates. A newer host's unknown code reads as no
  // reason, which leaves the generic sentence in place.
  const refusedReason = refusalCodeOf(record.refusedReason)
  const notesRoute = notesRouteOf(record.notesRoute)
  return {
    v: typeof record.v === 'number' ? record.v : 0,
    instrumented: record.instrumented === true,
    refused: record.refused === true,
    ...refusedReason === null ? {} : { refusedReason },
    ...notesRoute === undefined ? {} : { notesRoute },
    partial: record.partial === true,
    // Narrowed like the note: a reloaded session keeps the total its card was written with.
    ...typeof record.elapsedMs === 'number' && Number.isFinite(record.elapsedMs) && record.elapsedMs > 0
      ? { elapsedMs: record.elapsedMs }
      : {},
    preamble: typeof record.preamble === 'string' ? record.preamble : '',
    steps,
  }
}

/**
 * Wall-clock milliseconds as the card's own timer reads: whole seconds, and minutes once a
 * command is long enough that seconds alone stop being readable. The units match
 * `formatSeconds` (the step clocks), so the header total and the list read as one family.
 * @param milliseconds - the total, from the host's monotonic clock.
 * @returns e.g. `12s`, `0s`, `1m 05s`.
 */
export function formatTotal(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`
}
