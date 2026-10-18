/**
 * The parse-based step planner: ask PowerShell itself where its top-level
 * statements begin.
 *
 * `./split.ts` decides step boundaries by counting braces, which is why a
 * clause that continues a statement (`else {`, `catch {`, a `do` block's
 * trailing `while (...)`) looks like a new top-level step to it. The fix is to
 * stop guessing for PowerShell: `[Parser]::ParseInput` returns a real AST, and
 * `$ast.EndBlock.Statements` is the authoritative list of top-level
 * statements. Each one's `Extent.StartLineNumber` is a step boundary that
 * cannot be wrong.
 *
 * ## The trap
 *
 * A script with a SYNTAX ERROR still parses into a populated, best-effort
 * tree: `if ($true) {` unclosed reports one error AND still lists an
 * `IfStatementAst`. So the probe reports the error count, and
 * {@link parseProbeOutput} refuses the whole plan whenever that count is
 * non-zero — the statement list is never trusted on its own.
 *
 * ## Why a subprocess, and how it is kept safe
 *
 * The parser only exists inside PowerShell, and the shell this plugin drives
 * is `@deepseek-ai/dsh-pwsh-local`'s (the seam carries no dialect tag), so the
 * probe spawns the shell through the same candidate order
 * (`./pwsh-path.ts`). The source travels as BASE64 so quoting, escaping and
 * CRLF can never corrupt it, and the probe script itself holds no `"`, no
 * backslash and no newline, so no layer of command-line quoting can mangle it.
 * The probe writes one machine-readable verdict on stdout, has a timeout, and
 * kills nothing but the process it started.
 *
 * A probe that cannot run, times out, or prints something unparseable returns
 * `undefined`, which means "no authoritative plan" — never a failure. The
 * caller falls back to `./split.ts`, so this file can only ever improve a
 * split, never break one.
 *
 * @module dsh-shell-progress/pwshtree
 */

import { execFile } from 'node:child_process'
import { resolvePowershell } from './pwsh-path.ts'
import { stepsAtLines } from './plan.ts'
import { splitSteps } from './split.ts'
import type { SplitResult, Step } from './split.ts'

/**
 * The verdict line the probe writes with the PARSER'S ERROR COUNT. It is
 * printed on every successful probe, errors or not, because the count is what
 * decides whether the statement list may be trusted.
 */
export const PROBE_ERRORS = 'ERRORS'

/**
 * The verdict line the probe writes with the top-level statements' EXTENTS.
 *
 * Each statement is `startLine:startColumn:endLine:endColumn`, statements are comma
 * separated. The extents are what make a one-line `a; b; c` splittable: two statements can
 * share a line, so a line number alone cannot say where a boundary is.
 */
export const PROBE_STATEMENTS = 'STATEMENTS'

/** How long the probe may run before it is abandoned, in milliseconds. */
export const PROBE_TIMEOUT_MS = 5_000

/**
 * The longest probe script that may be handed to a shell on the command line.
 * Windows caps a process's command line near 32k characters; past this the
 * spawn fails outright, so an oversized command simply gets no plan and the
 * heuristic handles it.
 */
export const MAX_PROBE_CHARS = 24_000

/** One top-level statement's span, as PowerShell's own parser reports it. */
export interface StatementExtent {
  /** 1-based line the statement starts on. */
  readonly startLine: number
  /** 1-based column the statement starts at. */
  readonly startColumn: number
  /** 1-based line the statement ends on. */
  readonly endLine: number
  /** 1-based column just past the statement's last character. */
  readonly endColumn: number
}

/**
 * One probe's decoded verdict.
 *
 * `errors` is the refusal: PowerShell found syntax it could not parse, so the statement
 * extents (which the probe may well have printed) are ignored.
 */
export type ProbeAnswer =
  | { readonly kind: 'statements'; readonly statements: readonly StatementExtent[] }
  | { readonly kind: 'errors'; readonly count: number }

/**
 * Build the probe script for one command.
 *
 * The script is deliberately tiny and quote-safe: single quotes only, no
 * newline, no double quote, and no backslash — the only variable text is the
 * base64 payload, whose alphabet (`A-Za-z0-9+/=`) needs no escaping in any
 * quoting layer it passes through.
 * @param command - the command text, exactly as it will be executed.
 * @returns the probe script to run with `-Command`.
 */
export function buildProbeSource(command: string): string {
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  return `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`
    + '$t=$null;$e=$null;'
    + '$a=[System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);'
    + `'${PROBE_ERRORS} '+@($e).Count;`
    + `'${PROBE_STATEMENTS} '+(($a.EndBlock.Statements|ForEach-Object{''+$_.Extent.StartLineNumber+':'+$_.Extent.StartColumnNumber+':'+$_.Extent.EndLineNumber+':'+$_.Extent.EndColumnNumber}) -join ',')`
}

/**
 * Turn one probe's stdout into a verdict, or undefined when it said nothing
 * trustworthy.
 *
 * Every number is validated, and a missing `ERRORS` line is a refusal to
 * answer: without the error count there is no way to know whether the
 * statement list came from a script that parsed.
 * @param stdout - the probe's captured stdout.
 * @returns the verdict, or undefined for output this parser will not trust.
 */
export function parseProbeOutput(stdout: string): ProbeAnswer | undefined {
  const text = stdout.replace(/^\uFEFF/, '')
  let errors: number | undefined
  let statements: readonly StatementExtent[] | undefined
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim()
    // `ERRORS` without a count is malformed on purpose-checked: an absent count
    // must never be read as zero, which would trust a broken tree.
    if (line.startsWith(`${PROBE_ERRORS} `)) {
      const count = Number(line.slice(PROBE_ERRORS.length).trim())
      if (!Number.isInteger(count) || count < 0) return undefined
      errors = count
      continue
    }
    if (line === PROBE_STATEMENTS || line.startsWith(`${PROBE_STATEMENTS} `)) {
      const parsed = parseStatementExtents(line.slice(PROBE_STATEMENTS.length).trim())
      if (parsed === undefined) return undefined
      statements = parsed
    }
  }
  if (errors === undefined) return undefined
  // THE TRAP: a broken script still yields a populated statement list, so the
  // count decides. `STATEMENTS` is present and deliberately not looked at.
  if (errors > 0) return { kind: 'errors', count: errors }
  return statements === undefined ? undefined : { kind: 'statements', statements }
}

/**
 * Parse the comma-separated `line:column:line:column` extent list.
 * An empty list is legal: a script can have no statements.
 * @param text - the text after the `STATEMENTS` prefix.
 * @returns the extents, or undefined when a token is malformed.
 */
function parseStatementExtents(text: string): readonly StatementExtent[] | undefined {
  if (text.length === 0) return []
  const statements: StatementExtent[] = []
  for (const token of text.split(',')) {
    const parts = token.trim().split(':')
    if (parts.length !== 4) return undefined
    const numbers = parts.map((part) => Number(part))
    if (numbers.some((value) => !Number.isInteger(value) || value < 1)) return undefined
    const [startLine, startColumn, endLine, endColumn] = numbers as [number, number, number, number]
    statements.push({ startLine, startColumn, endLine, endColumn })
  }
  return statements
}

/**
 * Collapse statement start lines into steps, taking each step's text from the
 * source line it names.
 *
 * The implementation moved to `./plan.ts`, where the bash planner shares it:
 * both parsers answer with line numbers, and neither dialect owns the
 * line-set-to-steps rule. Re-exported here because this module's own callers
 * and tests have always imported it from here.
 * @param source - the command text.
 * @param lineNumbers - statement start lines, as the probe reported them.
 * @returns the steps, in source order.
 */
export { stepsAtLines }

/**
 * Turn the parser's statement extents into this plugin's steps.
 *
 * TWO RULES, both from the parser and neither guessed:
 *
 * - A boundary is a STEP only when the text between two statements is a separator a marker
 *   may be inserted at: a `;` (optionally followed by a newline) or bare whitespace/newlines.
 *   Anything else — `&&`/`||`, or whatever else the parser produced — MERGES the two
 *   statements into one step, so they run under one marker.
 * - A step's text is sliced from its OWN extent, so every character inside a step is the
 *   user's. Extents arrive as 1-based line/column and are converted to offsets here.
 * @param source - the command text, exactly as it will be executed.
 * @param statements - the parser's top-level statements, in source order.
 * @returns the steps, each with its text, line and character span.
 */
export function stepsFromStatements(source: string, statements: readonly StatementExtent[]): readonly Step[] {
  const lineStarts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1)
  }
  const offsetOf = (line: number, column: number): number | undefined => {
    const base = lineStarts[line - 1]
    return base === undefined ? undefined : base + (column - 1)
  }
  const steps: Step[] = []
  for (const statement of statements) {
    const start = offsetOf(statement.startLine, statement.startColumn)
    const end = offsetOf(statement.endLine, statement.endColumn)
    if (start === undefined || end === undefined || end <= start) continue
    const previous = steps.at(-1)
    if (previous === undefined) {
      steps.push({ line: statement.startLine, text: source.slice(start, end), start, end })
      continue
    }
    if (splitsAt(source.slice(previous.end ?? 0, start))) {
      steps.push({ line: statement.startLine, text: source.slice(start, end), start, end })
    } else if (previous.start !== undefined) {
      // No marker can be inserted there without changing the chain, so the pair is one step.
      steps[steps.length - 1] = {
        line: previous.line,
        text: source.slice(previous.start, end),
        start: previous.start,
        end,
      }
    }
  }
  // The marker id: a step INDEX, because two statements can share one line.
  return steps.map((step, index) => ({ ...step, anchor: index + 1 }))
}

/**
 * Whether the text between two statements is a boundary a marker may be inserted at.
 * @param gap - the source text between the previous statement's end and this one's start.
 * @returns whether the two statements are separate steps.
 */
function splitsAt(gap: string): boolean {
  const trimmed = gap.trim()
  // Whitespace and newlines only: PowerShell accepts a newline wherever a `;` is legal.
  if (trimmed === '') return true
  // The one separator a marker can follow without changing the chain's meaning.
  return trimmed === ';'
}

/** Options for {@link planPwshSteps}, all of them test seams. */
export interface PlanOptions {
  /** Environment to resolve the shell from; defaults to the process environment. */
  readonly env?: NodeJS.ProcessEnv
  /** The shell to probe, bypassing resolution. */
  readonly executable?: string
  /** How long the probe may run, ms. Defaults to {@link PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /**
   * The platform whose candidate list resolution walks; defaults to this process's.
   *
   * A seam like the others, and the one that makes "there is no PowerShell at all"
   * expressible on a host that has one: the POSIX candidate list ends in a bare `pwsh`,
   * which has no path to test and is handed to the SPAWN — so on POSIX the unresolvable
   * case is a failed spawn, and the empty-resolver answer is Windows-only.
   */
  readonly platform?: NodeJS.Platform
}

/**
 * Run the probe and capture its stdout.
 *
 * `execFile`'s own timeout terminates the child this call created and nothing
 * else — no signal is ever sent to a process this module did not start.
 * @param executable - the shell to run.
 * @param source - the probe script.
 * @param timeoutMs - how long it may run.
 * @returns the captured stdout, or undefined when the probe failed or timed out.
 */
async function runProbe(executable: string, source: string, timeoutMs: number): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1_048_576 },
      (error, stdout) => {
        // A failed or timed-out probe is not an error: it just has no answer.
        resolve(error === null ? stdout : undefined)
      },
    )
  })
}

/**
 * The authoritative, parse-based plan for one PowerShell command.
 *
 * The parser is asked about the ORIGINAL text, and its statement extents are the only
 * source of boundaries — including a one-line `a; b; c`, whose statements share a line and
 * which no line-based rule could split. The probe is skipped when it cannot change the
 * answer (a command with no `;` and no newline is one statement by definition) and returns
 * undefined whenever the shell cannot be resolved, the probe cannot run, or its output
 * cannot be trusted; the caller then refuses to instrument rather than guessing.
 * @param command - the command text, exactly as it will be executed.
 * @param options - test seams; production passes nothing.
 * @returns the plan, or undefined when there is no authoritative answer.
 */
export async function planPwshSteps(command: string, options: PlanOptions = {}): Promise<SplitResult | undefined> {
  // Nothing to decide: one line with no statement separator is one statement.
  if (!/[;\r\n]/.test(command)) return undefined
  const executable = options.executable ?? resolvePowershell(options.env ?? process.env, options.platform ?? process.platform)
  if (executable === undefined) return undefined
  const probe = buildProbeSource(command)
  if (probe.length > MAX_PROBE_CHARS) return undefined
  const stdout = await runProbe(executable, probe, options.timeoutMs ?? PROBE_TIMEOUT_MS)
  if (stdout === undefined) return undefined
  const answer = parseProbeOutput(stdout)
  if (answer === undefined) return undefined
  if (answer.kind === 'errors') {
    return {
      // The heuristic's steps are kept for the CARD: it draws a degraded,
      // uninstrumented step list, and a zero-step list would read as a
      // single-line command instead of a refused one.
      steps: splitSteps(command).steps,
      safe: false,
      reason: `PowerShell reported ${answer.count} syntax error${answer.count === 1 ? '' : 's'} in this command`,
    }
  }
  const steps = stepsFromStatements(command, answer.statements)
  if (steps.length === 0) return undefined
  return { steps, safe: true }
}
