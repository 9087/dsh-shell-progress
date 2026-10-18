/**
 * The browser's one caller of this plugin's progress channel.
 *
 * A plugin installed outside the DSH tree cannot subscribe to host events (the
 * shell's forwarded-event allowlist is a static array inside the build), so
 * the live position is polled off this authenticated request/response channel
 * instead. Every field is narrowed on the way in: a malformed wire value must
 * degrade to "no live data", never to a crashed card.
 *
 * @module dsh-shell-progress/client/port
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { PROGRESS_CHANNEL } from '../types.ts'
import type { LiveSnapshot, RefusalCode, StepProgress } from '../types.ts'

/**
 * The refusal codes this client knows.
 *
 * A wire value outside this set is `null`: a NEWER host may add a reason this client has no
 * wording for, and guessing one would put a wrong sentence in the tooltip. The generic
 * sentence is what an unknown reason falls back to.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  'block-comment',
  'here-string',
  'line-continuation',
  'unterminated-quote',
  'unbalanced',
  'syntax-error',
  'no-answer',
  'unsplittable',
  'too-many-steps',
  'already-instrumented',
  'reserved-variable',
  'read-only',
])

/** Narrow one refusal code from the wire. Exported for the SETTLED record's own narrowing. */
export function refusalCodeOf(value: unknown): RefusalCode | null {
  return typeof value === 'string' && REFUSAL_CODES.has(value) ? value as RefusalCode : null
}

/** This plugin's business verbs over {@link PROGRESS_CHANNEL}. */
export interface ProgressPort {
  /**
   * Read one call's live progress.
   * @param callId - the tool call to read.
   * @returns the snapshot, or `undefined` when the host gave NO USABLE ANSWER —
   * a refusal, a transport failure, or a malformed value. That is deliberately
   * not the same as a snapshot saying the call is over: reading "no answer" as
   * "finished" is what stopped the poll and froze the bar at its starting shape.
   */
  snapshot(callId: string): Promise<LiveSnapshot | undefined>
  /**
   * Tell the host the step-note preference: whether to ask for notes at all, and which
   * language to write them in.
   *
   * Best effort by design. The host is the party that makes the model request, but the
   * GUI is the only party that knows the reader's language, so this is how the two agree;
   * a host too old to answer simply keeps its own default and nothing breaks.
   * @param options - the switch and the reader's language.
   */
  configure(options: { readonly enabled: boolean; readonly locale: string }): Promise<void>
  /**
   * Ask the host to write notes for one card's step lines.
   *
   * For a card whose notes never arrived: the command finished before the model answered, so
   * nothing was persisted. The request costs a model call, so the card makes it at most once,
   * and only for a card the reader actually looked at.
   * @param request - the step lines, and the route the card was written with.
   * @returns one note per line (`undefined` where there is none), or `undefined` when the
   *   host could not write them.
   */
  notes(request: {
    readonly lines: readonly string[]
    readonly locale: string
    readonly provider: string
    readonly model: string
  }): Promise<readonly (string | undefined)[] | undefined>
}

/** The empty answer, used for every malformed or absent wire value. */
export function emptySnapshot(): LiveSnapshot {
  return {
    found: false,
    running: false,
    instrumented: false,
    refused: false,
    refusedReason: null,
    partial: false,
    current: null,
    currentStep: null,
    total: 0,
    elapsedMs: 0,
    preamble: '',
    steps: [],
  }
}

/** Narrow one step row; anything malformed is dropped. */
function stepOf(value: unknown): StepProgress | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { line, text, output, startedAt, endedAt, droppedChars, note } = record
  if (typeof line !== 'number' || !Number.isFinite(line)) return undefined
  if (typeof text !== 'string' || typeof output !== 'string') return undefined
  return {
    line,
    text,
    output,
    // A record persisted before this field existed has none, which reads as "nothing
    // was dropped" — the same thing an explicit zero means.
    ...typeof droppedChars === 'number' && Number.isFinite(droppedChars) && droppedChars > 0
      ? { droppedChars }
      : {},
    // The model's line, narrowed like everything else on this wire. It HAS to survive here:
    // the note is attached to the host's tracker while the command is still running, and
    // this is the only path it can take to the card before the command settles. Dropping it
    // meant a note appeared only once the run was over — the exact bug a reader reported,
    // and one the settled card could not reveal, because that path reads the persisted meta
    // instead of this wire.
    ...typeof note === 'string' && note.length > 0 ? { note } : {},
    startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null,
    endedAt: typeof endedAt === 'number' && Number.isFinite(endedAt) ? endedAt : null,
  }
}

/** Narrow the snapshot value; a value that is not a snapshot at all is `undefined`. */export function snapshotOf(value: unknown): LiveSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  // A well-formed "I have no record of this call" is USABLE information, distinct
  // from a refusal: the caller keeps asking, because the host registers a call
  // shortly after its card appears.
  if (record.found !== true) return emptySnapshot()
  const rawSteps = Array.isArray(record.steps) ? record.steps : []
  const steps: StepProgress[] = []
  for (const row of rawSteps) {
    const step = stepOf(row)
    if (step !== undefined) steps.push(step)
  }
  const current = record.current
  const currentStep = record.currentStep
  const elapsed = record.elapsedMs
  const total = record.total
  return {
    found: true,
    running: record.running === true,
    instrumented: record.instrumented === true,
    refused: record.refused === true,
    refusedReason: refusalCodeOf(record.refusedReason),
    partial: record.partial === true,
    current: typeof current === 'number' && Number.isFinite(current) ? current : null,
    ...typeof currentStep === 'number' && Number.isFinite(currentStep)
      ? { currentStep }
      : {},
    total: typeof total === 'number' && Number.isFinite(total) ? total : steps.length,
    elapsedMs: typeof elapsed === 'number' && Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
    preamble: typeof record.preamble === 'string' ? record.preamble : '',
    steps,
  }
}

/**
 * Narrow a notes answer: `{ notes: (string | null)[] }` over the wire.
 * @param value - the raw channel value.
 * @returns one entry per line, `undefined` for a hole, or `undefined` when the answer holds
 *   no notes at all.
 */
export function notesOf(value: unknown): readonly (string | undefined)[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = (value as { readonly notes?: unknown }).notes
  if (!Array.isArray(raw)) return undefined
  const notes: (string | undefined)[] = raw.map((note) => (
    typeof note === 'string' && note.length > 0 ? note : undefined
  ))
  return notes.some((note) => note !== undefined) ? notes : undefined
}

/**
 * Build the port over the connection's generic channel caller.
 * @param rpc - the connection's channel caller.
 * @returns the typed port.
 */
export function createProgressPort(rpc: ClientConnectionRpc): ProgressPort {
  return {
    async snapshot(callId) {
      const result = await rpc.call(PROGRESS_CHANNEL, 'snapshot', { callId })
      // A refused call (older host, transport failure) is "no answer", NOT "the
      // call is over": the caller decides how long to keep asking. The settled
      // card renders from its own metadata regardless.
      if (!result.ok) return undefined
      return snapshotOf(result.value)
    },
    async configure(options) {
      // A refusal is not the caller's business: there is nothing a caller could do about a
      // host that does not know this endpoint, and the note is a convenience.
      try {
        await rpc.call(PROGRESS_CHANNEL, 'configure', { enabled: options.enabled, locale: options.locale })
      } catch {
        // Ignored on purpose — see above.
      }
    },
    async notes(request) {
      try {
        const result = await rpc.call(PROGRESS_CHANNEL, 'notes', request)
        // A host too old to know the endpoint answers `!ok`; the card stays without notes.
        if (!result.ok) return undefined
        return notesOf(result.value)
      } catch {
        return undefined
      }
    },
  }
}
