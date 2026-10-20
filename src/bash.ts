/**
 * The bash dialect.
 *
 * ## The marker, and why it is shaped this way
 *
 * Measured against Git-for-Windows bash, the way the PowerShell side was measured
 * against its shell:
 *
 * ```
 * false; printf 'MARK'; echo "after=$?"                                  -> 0   (masked!)
 * false; __ok=$?; printf 'MARK'; [ "$__ok" = 0 ] || false; echo $?       -> 1   (kept)
 * true;  __ok=$?; printf 'MARK'; [ "$__ok" = 0 ] || false; echo $?       -> 0   (no false alarm)
 * ```
 *
 * The first line is the whole point: `printf` SUCCEEDS, so it overwrites `$?` and
 * silently turns a failed command into a successful-looking one. So the marker is
 * three inlined statements, in this order:
 *
 * 1. `__ok=$?` FIRST, before any new command can overwrite `$?`.
 * 2. `printf '%s\n' '<marker>'` — writes and moves on. Bash flushes its stdout
 *    before it forks an external command, which is what lets the host see the step
 *    switch while the command still runs.
 * 3. `[ "$__ok" = 0 ] || false` restores the failure WITHOUT printing anything:
 *    when the previous command failed this compound command exits non-zero, and
 *    when it succeeded the `||` short-circuits and the status stays 0.
 *
 * Like the PowerShell marker, it is INLINED onto the step's own line and never
 * becomes a function: a function call is itself a command, and running it would
 * overwrite the `$?` the marker was asked to preserve.
 *
 * ## Why the splitter refuses so much
 *
 * Bash's block syntax is keyword-delimited (`if`/`then`/`fi`, `for`/`do`/`done`,
 * `case`/`esac`), which cannot be tracked by brace depth the way PowerShell's
 * can. Rather than guess where such a block ends, this splitter REFUSES the whole
 * command. That refusal is no longer the end of the story: `./bashtree.ts`
 * supplies an authoritative parser (tree-sitter's bash grammar, compiled to
 * wasm), and a refused command is planned from it. Only when that planner has no
 * answer either does the command run exactly as written, with the card saying so.
 * A coarser bar is a nuisance; a wrong step boundary mis-attributes output and is
 * a defect.
 *
 * @module dsh-shell-progress/bash
 */

import type { ShellDialect } from './dialect.ts'
import { planBashSteps } from './bashtree.ts'
import { MARKER_PREFIX, createNonce, looksInstrumented, markerText } from './instrument.ts'
import type { LineScan, SplitResult, Step } from './split.ts'

/** The variable this dialect's marker borrows. */
export const RESERVED_VARIABLE_BASH = '__ok'

/** First words that open or close a keyword-delimited block this splitter cannot track. */
const BLOCK_KEYWORDS = [
  'if', 'then', 'elif', 'else', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function',
  '{', '}',
]

/** Constructs that make a line's extents undecidable without a real parser. */
function undecidableBash(line: string): string | undefined {
  const trimmed = line.trim()
  if (trimmed.endsWith('\\')) return 'line continuation'
  // A heredoc's body is data, not statements, and finding its end needs the
  // delimiter — refusing is cheaper than mis-reading the body as steps.
  if (/(^|[^<])<<-?\s*['"]?\w/.test(trimmed)) return 'heredoc'
  const first = trimmed.split(/[\s;]+/, 1)[0] ?? ''
  if (BLOCK_KEYWORDS.includes(first)) return `the ${first} block syntax`
  return undefined
}

/**
 * Scan one bash line for its brace/paren delta, skipping quoted text and `#`
 * comments.
 *
 * Parentheses are counted too, and any imbalance rejects the line: a `$( )` that
 * opens on one line and closes on another would otherwise be reported as two
 * steps.
 * @param line - one source line, without its terminator.
 * @returns the line's brace delta and whether it was decidable.
 */
export function scanBashLine(line: string): LineScan {
  let braces = 0
  let parens = 0
  let index = 0
  while (index < line.length) {
    const character = line[index]
    // `#` opens a comment at the start of a WORD, not mid-token (`a#b` is a word).
    const previous = index === 0 ? ' ' : line[index - 1] ?? ' '
    if (character === '#' && (previous === ' ' || previous === '\t' || previous === ';')) break
    if (character === '\\') {
      index += 2 // an escape makes the next character literal, quote or not
      continue
    }
    if (character === "'") {
      index += 1
      while (index < line.length && line[index] !== "'") index += 1
      if (index >= line.length) return { braces, safe: false, reason: 'unterminated single-quoted string' }
    } else if (character === '"') {
      index += 1
      let closed = false
      while (index < line.length) {
        if (line[index] === '\\') {
          index += 2
          continue
        }
        if (line[index] === '"') {
          closed = true
          break
        }
        index += 1
      }
      if (!closed) return { braces, safe: false, reason: 'unterminated double-quoted string' }
    } else if (character === '{') {
      braces += 1
    } else if (character === '}') {
      braces -= 1
    } else if (character === '(') {
      parens += 1
    } else if (character === ')') {
      parens -= 1
    }
    index += 1
  }
  if (parens !== 0) return { braces, safe: false, reason: 'unbalanced parentheses on one line' }
  return { braces, safe: true }
}

/**
 * Split a bash command into its top-level steps.
 *
 * One step per top-level line, exactly like the PowerShell splitter: a step must
 * be a non-empty line that starts at column 0 and sits at brace depth 0. A `;`
 * chain on one line is ONE step, which is coarser but never wrong.
 * @param source - the command text, any line ending.
 * @returns the steps found and whether instrumentation may proceed.
 */
export function splitBash(source: string): SplitResult {
  const lines = source.split(/\r\n|\n|\r/)
  const steps: Step[] = []
  let depth = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const refusal = undecidableBash(line)
    if (refusal !== undefined) return { steps, safe: false, reason: refusal }
    const atColumnZero = line[0] !== ' ' && line[0] !== '\t'
    const isCloser = trimmed.startsWith('}')
    if (atColumnZero && !isCloser && depth === 0) steps.push({ line: index + 1, text: line })
    const scan = scanBashLine(line)
    if (!scan.safe) return { steps, safe: false, reason: scan.reason ?? 'undecidable line' }
    depth += scan.braces
    if (depth < 0) return { steps, safe: false, reason: 'a closing brace has no opening brace' }
  }
  if (depth !== 0) return { steps, safe: false, reason: 'a block is never closed' }
  return { steps, safe: true }
}

/**
 * The inlined marker for one step, WITHOUT its trailing separator.
 * @param nonce - this call's nonce.
 * @param line - the step's original 1-based line number.
 * @returns the marker statements.
 */
export function inlineMarkerBash(nonce: string, line: number): string {
  return `__ok=$?; printf '%s\\n' '${markerText(nonce, line)}'; [ "$__ok" = 0 ] || false`
}

/**
 * Rewrite a bash command so each top-level step announces itself before it runs.
 *
 * Only the steps' own lines change; every other line is copied verbatim, and the
 * line count is unchanged.
 * @param source - the original command text.
 * @param steps - the steps to mark, from {@link splitBash}.
 * @param nonce - this call's nonce.
 * @returns the instrumented command text.
 */
export function instrumentBash(source: string, steps: readonly Step[], nonce: string): string {
  const terminator = source.includes('\r\n') ? '\r\n' : '\n'
  const marked = new Map<number, string>()
  for (const step of steps) {
    marked.set(step.line, `${inlineMarkerBash(nonce, step.line)}; ${step.text}`)
  }
  return source
    .split(/\r\n|\n|\r/)
    .map((line, index) => marked.get(index + 1) ?? line)
    .join(terminator)
}

/**
 * Whether a command already uses the marker's borrowed variable.
 * @param source - the command text.
 * @returns whether `__ok` appears.
 */
export function usesBashReservedVariable(source: string): boolean {
  return source.includes(RESERVED_VARIABLE_BASH)
}

/** The bash dialect. */
export const bashDialect: ShellDialect = {
  id: 'bash',
  toolName: 'shell_progress_bash',
  description: 'Execute a bash command and return its stdout/stderr. It IS the `bash` tool underneath: the same executor, the same sandbox mode and the same sandbox rules apply, and the model-visible stdout and exit status are byte-identical — nothing about the command, its environment or its result changes (the one measured stderr difference is the echoed source line of a command the shell itself rejects). The one difference is what the USER sees: this tool normally renders the call as a numbered step list — a progress bar while it runs, per-step duration and collapsible per-step output — where `bash` shows one opaque block. Prefer this tool for every command for that reason, exploration included: listings, greps, file reads and one-liners alike. Use `bash` in only one case: something OTHER than you consumes the raw stdout byte-exactly — a protocol, a binary or a checksummed payload — because each step writes one short marker line to the process\'s stdout, stripped from the text you receive but genuinely written. A long command is NOT a reason to leave: pass `run_in_background: true` and this tool starts a real background job (collect with `job_output`, stop with `job_kill`, no timeout applies), running the command unmodified so its output is exact — the card then shows the command\'s statements without per-step data, because the command outlives the call that started it. Step boundaries come from tree-sitter\'s bash grammar: a command it cannot plan still runs unmodified, and the card says so. Pass `workdir` instead of using `cd`.',
  commandParamDescription: 'The bash command to execute. Top-level statements become progress segments.',
  guidance: 'Bash: DEFAULT to `shell_progress_bash` for your commands, exploration included — listings, greps, file reads and one-liners all belong here. It is the same tool with a better user experience: underneath it is the same executor as `bash`, the same sandbox mode and the same sandbox rules, and the stdout and exit status you receive are byte-identical (stderr too, apart from the echoed source line of a command the shell itself rejects). The difference is what the user sees — a numbered step list, a progress bar while it runs, per-step duration and per-step output — where `bash` shows one opaque block. Use `bash` in only one case, and for no other reason: something OTHER than you consumes the raw stdout byte-exactly — a protocol, a binary or a checksummed payload — since each step writes one short marker line to the process\'s stdout, stripped from the text you receive but genuinely written. For a long command use `run_in_background: true` here instead of leaving: it starts a real job (collect with `job_output`, stop with `job_kill`), runs the command unmodified so its output is exact, and the card then shows its statements without per-step data. Step boundaries come from tree-sitter\'s bash grammar, so a command it cannot plan runs unmodified rather than failing. Redirection inside a step (`foo > out.txt`), pipes and stdin are unaffected: the marker is a separate statement, not part of your pipeline. PREFER ONE STATEMENT PER LINE: steps are line-based, so a `;` chain written on a single line renders as ONE step, and one progress segment.',
  reservedVariable: RESERVED_VARIABLE_BASH,
  split: splitBash,
  // The authoritative half: tree-sitter's bash grammar answers "where does each
  // top-level statement start?", so the keyword-delimited blocks this splitter
  // refuses are planned from a real parse instead of being abandoned. Undefined
  // leaves `split` in charge (and, for a dialect WITH a planner, is a refusal
  // rather than a fallback — see `resolveSplit` in `./index.ts`).
  plan: planBashSteps,
  instrument: instrumentBash,
}

// Re-exported so the shared marker helpers are reachable from the dialect that
// uses them, exactly as `./pwsh.ts` does.
export { MARKER_PREFIX, createNonce, looksInstrumented }
