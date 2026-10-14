/**
 * The model-visible result text.
 *
 * This reproduces `dsh-tool-pwsh`'s renderer call for call — stdout, a marked
 * stderr section, sandbox notices, truncation notices with spill paths, then
 * the exit-status markers — because acceptance requires the model to see
 * exactly what the `pwsh` tool would have shown for the same command. This
 * tool adds step progress to the CARD, never to the text the model reads.
 *
 * @module dsh-shell-progress/render
 */

import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** One captured stream, as the executor reports it. */
export interface CapturedStream {
  readonly text: string
  readonly truncated: boolean
  readonly spillPath?: string | undefined
}

/** Sandbox facts for one run. */
export interface CanonicalSandbox {
  readonly mode: SandboxMode
  readonly denied: boolean
  readonly enforcement?: string | undefined
  readonly runnerFailed?: boolean | undefined
}

/** A settled foreground run, detached from the executor's readonly types. */
export interface CanonicalRunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly timeoutMs: number
  readonly stdout: CapturedStream
  readonly stderr: CapturedStream
  readonly sandbox?: CanonicalSandbox
}

/** Append the truncation notice, with the full-output spill path, to one stream's text. */
function streamText(output: CapturedStream): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into the text the model sees.
 * @param result - the completed foreground run.
 * @param escalationModes - the escalation targets this composition advertises;
 *   a non-empty list adds the same-turn escalation hint after a denial marker.
 * @returns the model-facing text: the output body, then any marker lines.
 */
export function renderShellResult(
  result: CanonicalRunResult,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (result.sandbox?.denied === true) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    if (escalationModes.length > 0) markers.push(escalationHintMarker('command'))
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}
