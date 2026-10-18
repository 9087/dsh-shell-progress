/**
 * The instrumenter: source text in, the same command with step markers in.
 *
 * ## The one rule that must never be "cleaned up"
 *
 * The marker is INLINED onto the step's own line. It is not a helper
 * function, and it must not become one.
 *
 * A PowerShell function call is itself a command, and running it overwrites
 * `$?`. A marker shaped as `Mark-Step 2 $?` therefore clobbers the very
 * automatic variable it was asked to preserve, and the command's next line
 * reads `True` where the uninstrumented command reads `False`. Measured, on
 * this host:
 *
 * ```
 * uninstrumented                  -> $? = False   (correct)
 * function-shaped marker          -> $? = True    (wrong)
 * Set-PSBreakpoint action         -> $? = True    (wrong)
 * inlined capture + restore       -> $? = False   (correct)
 * ```
 *
 * So the marker is three inlined statements, in this order:
 *
 * 1. `$__ok = $?` FIRST, before any new command can overwrite `$?`.
 * 2. `[Console]::Out.WriteLine(...)` rather than `Write-Output`: it writes and
 *    flushes immediately, which is what lets the host see the step switch
 *    WHILE the command still runs.
 * 3. `if (-not $__ok) { $null = Get-Item -LiteralPath '<absent>' -ErrorAction SilentlyContinue }`
 *    restores `$?` to `False` without emitting anything on stderr.
 *
 * The prefix is prepended to the step's own line, never inserted as a new
 * line: the script keeps its line count, original line numbers survive, and
 * the capture happens at the right moment.
 *
 * @module dsh-shell-progress/instrument
 */

import { randomBytes } from 'node:crypto'
import type { Step } from './split.ts'

/** Marker prefix, chosen so a command cannot plausibly print it by accident. */
export const MARKER_PREFIX = '__DSH_STEP_'

/**
 * The variable the inlined marker borrows. A command that already uses this
 * name is left alone — its value would otherwise be overwritten.
 */
export const RESERVED_VARIABLE = '$__ok'

/**
 * Mint the per-call nonce: 8 hex characters. A command that prints this exact
 * string by chance is not a realistic risk, so stripping is reliable and real
 * output is never damaged.
 * @returns 8 lowercase hex characters.
 */
export function createNonce(): string {
  return randomBytes(4).toString('hex')
}

/**
 * The exact text the marker writes to stdout.
 * @param nonce - this call's nonce.
 * @param line - the original 1-based line number of the step.
 * @returns the marker line's content, without a terminator.
 */
export function markerText(nonce: string, line: number): string {
  return `${MARKER_PREFIX}${nonce}_${line}__`
}

/**
 * The matcher for this call's markers. Anchored to a whole line, so a
 * substring inside real output can never be mistaken for a step switch.
 * @param nonce - this call's nonce.
 * @returns the anchored regular expression.
 */
export function markerPattern(nonce: string): RegExp {
  return new RegExp(`^${MARKER_PREFIX}${nonce}_(\\d+)__$`)
}

/**
 * Whether text already carries anything shaped like this plugin's marker.
 * Instrumenting such a command could confuse the reader with a foreign
 * marker, so it is left alone.
 * @param source - the command text.
 * @returns whether the marker prefix appears.
 */
export function looksInstrumented(source: string): boolean {
  return source.includes(MARKER_PREFIX)
}

/**
 * Whether the command already uses the inlined marker's variable.
 * @param source - the command text.
 * @returns whether `$__ok` appears.
 */
export function usesReservedVariable(source: string): boolean {
  return source.includes(RESERVED_VARIABLE)
}

/**
 * The inlined marker for one step, WITHOUT its trailing separator.
 * @param nonce - this call's nonce.
 * @param line - the step's original 1-based line number.
 * @param sentinel - an absolute path that is guaranteed not to exist.
 * @returns the marker statements.
 */
export function inlineMarker(nonce: string, line: number, sentinel: string): string {
  return `$__ok = $?; [Console]::Out.WriteLine('${markerText(nonce, line)}');`
    + ` if (-not $__ok) { $null = Get-Item -LiteralPath '${sentinel}' -ErrorAction SilentlyContinue }`
}

/**
 * Put one line back together with its original ending, so a rewrite never
 * silently converts CRLF to LF (or the reverse).
 * @param source - the command text.
 * @returns the line terminator this text uses.
 */
function terminatorOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Rewrite a command so each top-level step announces itself before it runs.
 *
 * Only the steps' own lines change; every other line is copied verbatim, and
 * the line count is unchanged.
 * @param source - the original command text.
 * @param steps - the steps to mark, from {@link import('./split.ts').splitSteps}.
 * @param nonce - this call's nonce.
 * @returns the instrumented command text.
 */
export function instrument(source: string, steps: readonly Step[], nonce: string): string {
  const terminator = terminatorOf(source)
  const sentinel = `__dsh_shell_progress_absent_${nonce}__`
  const marked = new Map<number, string>()
  for (const step of steps) {
    // The MARKER lives on the executed line; the card's line stays whatever `step.line` says.
    // They differ only when a `;` chain was rewritten one statement per line first.
    const anchor = step.anchor ?? step.line
    marked.set(anchor, `${inlineMarker(nonce, anchor, sentinel)}; ${step.text}`)
  }
  return source
    .split(/\r\n|\n|\r/)
    .map((line, index) => marked.get(index + 1) ?? line)
    .join(terminator)
}

/**
 * Remove this call's marker lines from captured output.
 *
 * The tool renders the model-visible text itself, so the model never sees a
 * marker. The full captured stream is stripped rather than the delta the host
 * consumed, because `result()` reads the stream from offset 0 independently
 * of the consuming cursor.
 * @param text - the captured stdout.
 * @param nonce - this call's nonce.
 * @returns the text with every marker line removed.
 */
export function stripMarkers(text: string, nonce: string): string {
  if (!text.includes(MARKER_PREFIX)) return text
  const pattern = markerPattern(nonce)
  return text
    .split('\n')
    .filter((line) => !pattern.test(line.endsWith('\r') ? line.slice(0, -1) : line))
    .join('\n')
}
