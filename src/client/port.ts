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
import type { LiveSnapshot, StepProgress } from '../types.ts'

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
}

/** The empty answer, used for every malformed or absent wire value. */
export function emptySnapshot(): LiveSnapshot {
  return {
    found: false,
    running: false,
    instrumented: false,
    partial: false,
    current: null,
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
  const { line, text, output, startedAt, endedAt } = record
  if (typeof line !== 'number' || !Number.isFinite(line)) return undefined
  if (typeof text !== 'string' || typeof output !== 'string') return undefined
  return {
    line,
    text,
    output,
    startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null,
    endedAt: typeof endedAt === 'number' && Number.isFinite(endedAt) ? endedAt : null,
  }
}

/** Narrow the snapshot value; a value that is not a snapshot at all is `undefined`. */
export function snapshotOf(value: unknown): LiveSnapshot | undefined {
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
  const elapsed = record.elapsedMs
  const total = record.total
  return {
    found: true,
    running: record.running === true,
    instrumented: record.instrumented === true,
    partial: record.partial === true,
    current: typeof current === 'number' && Number.isFinite(current) ? current : null,
    total: typeof total === 'number' && Number.isFinite(total) ? total : steps.length,
    elapsedMs: typeof elapsed === 'number' && Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
    preamble: typeof record.preamble === 'string' ? record.preamble : '',
    steps,
  }
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
  }
}
