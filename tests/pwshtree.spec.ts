/**
 * The parse-based planner, and the tool path that uses it.
 *
 * Two things need proving, and they are different questions:
 *
 * 1. `./pwshtree.ts` must answer correctly — `ERRORS` decides, the `LINES` of a
 *    best-effort tree are never trusted, and stdout it does not recognise
 *    yields no plan at all. Those are pure tests, and they run everywhere.
 * 2. The tool must actually USE that answer. So the last suite drives the
 *    registered tool through `apply` with a fake context whose executor runs a
 *    REAL PowerShell, and asserts the plan's step lines and the marker's
 *    placement in the text the executor was handed — with the plain and
 *    instrumented commands compared byte for byte, the way the semantics suite
 *    compares them.
 *
 * Skipped when no PowerShell can be spawned (a sandbox boundary, or a non-
 * Windows host), because a false red would be worse than a skip.
 */

import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { bashDialect } from '../src/bash.ts'
import { apply } from '../src/index.ts'
import { createNonce, instrument, markerPattern, stripMarkers } from '../src/instrument.ts'
import { pwshDialect } from '../src/pwsh.ts'
import { resolvePowershell } from '../src/pwsh-path.ts'
import {
  buildProbeSource,
  MAX_PROBE_CHARS,
  parseProbeOutput,
  planPwshSteps,
  stepsAtLines,
  stepsFromStatements,
} from '../src/pwshtree.ts'
import type { StatementExtent } from '../src/pwshtree.ts'
import { splitSteps } from '../src/split.ts'
import type { Step } from '../src/split.ts'

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The executable the harness's own shell seam would pick on this host. */
const POWERSHELL = resolvePowershell() ?? 'pwsh'

/** Run one command in a fresh shell, exactly as the harness's tool does. */
async function shell(command: string): Promise<Run> {
  return await new Promise<Run>((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : 1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** Count this call's marker lines in a captured stream. */
function markerCount(text: string, nonce: string): number {
  const pattern = markerPattern(nonce)
  return text.split('\n').filter((line) => pattern.test(line.endsWith('\r') ? line.slice(0, -1) : line)).length
}

/** The command the brief's bug was measured on: the `else` sits at column 0. */
const IF_ELSE = [
  'cmd.exe /c exit 3',
  'if ($?) {',
  "  Write-Output 'ok=True'",
  '}',
  'else {',
  "  Write-Output 'ok=False'",
  '}',
  'Write-Output "done"',
].join('\n')

/** A `do` block whose `while` tail is a line of its own at column 0. */
const DO_WHILE = [
  '$i = 0',
  'do {',
  '  $i++',
  '}',
  'while ($i -lt 2)',
  'Write-Output "i=$i"',
].join('\n')

/** A `try`/`catch` spanning lines, with a step after it. */
const TRY_CATCH = [
  'try {',
  '  Write-Output "trying"',
  '} catch {',
  '  Write-Output "caught"',
  '}',
  'Write-Output "done"',
].join('\n')

/**
 * A script PowerShell cannot parse while the BRACE COUNTER is perfectly happy:
 * `[` is a parse error, and it changes no depth. This is the shape that proves
 * the error count is what refuses, because the heuristic would instrument it.
 */
const BROKEN_BUT_BALANCED = ['Write-Output "before"', '[', 'Write-Output "after"'].join('\n')

/** A script the brace counter refuses on its own: the block is never closed. */
const UNCLOSED_BRACE = ['if ($true) {', '  Write-Output 1'].join('\n')

/**
 * A command whose PROBE cannot be built at all: its base64 payload alone pushes
 * the probe script past what may be handed to a shell on one command line. The
 * brace counter is perfectly happy with it (twenty column-zero statements), so
 * this is the case that shows the tool does NOT quietly fall back to the guess
 * when the parser cannot answer.
 */
const OVERSIZED = Array.from(
  { length: 20 },
  (_, index) => `Write-Output '${index}-${'x'.repeat(980)}'`,
).join('\n')

/** One statement extent, for the fixtures below. */
function extent(startLine: number, startColumn: number, endLine: number, endColumn: number): StatementExtent {
  return { startLine, startColumn, endLine, endColumn }
}

describe('parseProbeOutput', () => {
  it('reads the top-level statement extents from a clean probe', () => {
    expect(parseProbeOutput('ERRORS 0\nSTATEMENTS 1:1:1:19,1:21:1:38,2:1:2:9\n')).toEqual({
      kind: 'statements',
      statements: [extent(1, 1, 1, 19), extent(1, 21, 1, 38), extent(2, 1, 2, 9)],
    })
  })

  it('reads an empty statement list', () => {
    expect(parseProbeOutput('ERRORS 0\nSTATEMENTS ')).toEqual({ kind: 'statements', statements: [] })
  })

  it('REFUSES a populated statement list when the parser reported errors', () => {
    // THE TRAP. A broken script still parses into a best-effort tree, so the
    // probe prints both lines; the error count is the only thing that may be
    // believed. If this ever returns a plan, instrumentation goes into a
    // command that is already broken.
    expect(parseProbeOutput('ERRORS 1\nSTATEMENTS 1:1:1:19\n')).toEqual({ kind: 'errors', count: 1 })
    expect(parseProbeOutput('ERRORS 3\nSTATEMENTS 1:1:1:9,2:1:2:9')).toEqual({ kind: 'errors', count: 3 })
  })

  it('refuses output with no error count at all', () => {
    // Without the count there is no way to know whether the statement list
    // came from a script that parsed, so there is no answer to give.
    expect(parseProbeOutput('STATEMENTS 1:1:1:9')).toBeUndefined()
    expect(parseProbeOutput('ERRORS')).toBeUndefined()
    expect(parseProbeOutput('')).toBeUndefined()
  })

  it('refuses malformed counts and extents', () => {
    expect(parseProbeOutput('ERRORS nope\nSTATEMENTS 1:1:1:9')).toBeUndefined()
    expect(parseProbeOutput('ERRORS -1\nSTATEMENTS 1:1:1:9')).toBeUndefined()
    // A zero line, a missing field, a non-number and an empty statement all fail: a
    // boundary this parser cannot place is never bracketed by a guess.
    expect(parseProbeOutput('ERRORS 0\nSTATEMENTS 0:1:1:9')).toBeUndefined()
    expect(parseProbeOutput('ERRORS 0\nSTATEMENTS 1:1:1')).toBeUndefined()
    expect(parseProbeOutput('ERRORS 0\nSTATEMENTS 1:1:1:x')).toBeUndefined()
    expect(parseProbeOutput('ERRORS 0\nSTATEMENTS ,')).toBeUndefined()
  })

  it('refuses output that is not a verdict, however shell-ish it looks', () => {
    expect(parseProbeOutput('At line:1 char:1\n+ ...\nMissingEndCurlyBrace')).toBeUndefined()
    expect(parseProbeOutput('ERRORS 0\nSTATEMENTS 1:1:1:9\nextra noise')).toEqual({
      kind: 'statements',
      statements: [extent(1, 1, 1, 9)],
    })
  })

  it('tolerates CRLF and a byte-order mark', () => {
    expect(parseProbeOutput('\uFEFFERRORS 0\r\nSTATEMENTS 1:1:1:9,2:1:2:9\r\n')).toEqual({
      kind: 'statements',
      statements: [extent(1, 1, 1, 9), extent(2, 1, 2, 9)],
    })
  })
})

describe('stepsFromStatements', () => {
  it('splits a one-line `;` chain into one step per statement, each with its own text', () => {
    const source = "Write-Output 'one'; Write-Output 'two'; Write-Output 'three'"
    const parts = ["Write-Output 'one'", "Write-Output 'two'", "Write-Output 'three'"]
    // Stand-ins for what the parser reports: each statement's own line/column span.
    const statements = parts.map((part) => {
      const start = source.indexOf(part)
      return extent(1, start + 1, 1, start + part.length + 1)
    })
    const steps = stepsFromStatements(source, statements)
    expect(steps.map((step) => step.text)).toEqual(parts)
    expect(steps.map((step) => step.line)).toEqual([1, 1, 1])
    // The marker id is the step INDEX: a line number would not identify one of these.
    expect(steps.map((step) => step.anchor)).toEqual([1, 2, 3])
    expect(steps.map((step) => step.start)).toEqual(parts.map((part) => source.indexOf(part)))
  })

  it('keeps a multi-line block as ONE step and texts it verbatim', () => {
    const source = ['if ($true) {', '  Write-Output 1', '}', 'Write-Output 2'].join('\n')
    const block = source.slice(0, source.indexOf('\nWrite-Output 2'))
    const steps = stepsFromStatements(source, [extent(1, 1, 3, 2), extent(4, 1, 4, 15)])
    expect(steps.map((step) => step.line)).toEqual([1, 4])
    expect(steps[0]?.text).toBe(block)
    expect(steps[1]?.text).toBe('Write-Output 2')
  })

  it('MERGES two statements the plugin cannot put a marker between', () => {
    // Only a `;` (or a newline) is a separator a marker may follow. Anything else keeps
    // the statements in one step, so no marker ever lands inside a chain.
    const source = 'Write-Output a && Write-Output b'
    const steps = stepsFromStatements(source, [extent(1, 1, 1, 16), extent(1, 20, 1, 35)])
    expect(steps).toHaveLength(1)
    expect(steps[0]?.text).toBe(source)
  })
})

describe('stepsAtLines', () => {
  it('collapses two statements that start on the same line', () => {
    const source = '$a = 1; $b = 2\nWrite-Output $b'
    expect(stepsAtLines(source, [1, 1, 2])).toEqual([
      { line: 1, text: '$a = 1; $b = 2' },
      { line: 2, text: 'Write-Output $b' },
    ])
  })

  it('sorts the lines and takes each step\'s text from its own source line', () => {
    const source = ['Write-Output "a"', '', 'Write-Output "c"'].join('\n')
    expect(stepsAtLines(source, [3, 1])).toEqual([
      { line: 1, text: 'Write-Output "a"' },
      { line: 3, text: 'Write-Output "c"' },
    ])
  })

  it('drops a line this source does not have', () => {
    expect(stepsAtLines('Write-Output 1', [1, 9])).toEqual([{ line: 1, text: 'Write-Output 1' }])
  })
})

describe('buildProbeSource', () => {
  it('carries the command as base64, so no quoting layer can corrupt it', () => {
    const command = `Write-Output "quote ' and \`backtick\`"\r\nWrite-Output 'ünïcøde'`
    const source = buildProbeSource(command)
    expect(source).toContain(Buffer.from(command, 'utf8').toString('base64'))
    // One line, no double quote, no backslash: nothing left to escape.
    expect(source).not.toContain('\n')
    expect(source).not.toContain('\r')
    expect(source).not.toContain('"')
    expect(source).not.toContain('\\')
  })
})

describe('planPwshSteps does not spawn when it cannot help', () => {
  it('skips a single-line command', async () => {
    expect(await planPwshSteps("Write-Output 'one'")).toBeUndefined()
  })

  it('gives no plan when no PowerShell can be resolved', async () => {
    // Two ways to have no shell, and neither may fall back to a guess.
    //
    // 1. The RESOLVER answers nothing. That answer exists only where the candidate list
    //    has no untestable entry: on Windows an environment whose candidates are all
    //    absent or non-existent, which is what this fixture is. (The list is built per
    //    platform, so the platform is part of the fixture; `tests/pwsh-path.spec.ts` pins
    //    both lists on either host, deterministically.)
    const env = { SystemRoot: 'C:\\__dsh_absent__', ProgramFiles: 'C:\\__dsh_absent__', PATH: '' }
    expect(await planPwshSteps(IF_ELSE, { env, platform: 'win32' })).toBeUndefined()
    // 2. The SPAWN fails, which is the shape this takes on POSIX: there the last candidate
    //    is a bare `pwsh` — no path to test, handed to the spawn to resolve — so a host
    //    that has no PowerShell fails here instead. An absolute path that cannot exist is
    //    the same case on every host, and this is the half that runs unconditionally.
    expect(await planPwshSteps(IF_ELSE, { executable: '/__dsh_absent__/pwsh' })).toBeUndefined()
  })
})

const probe = await shell("Write-Output 'ready'")
const available = probe.stdout.trim() === 'ready'

describe.skipIf(!available)('the planner, against a real PowerShell', () => {
  const cases: readonly {
    readonly name: string
    readonly command: string
    readonly lines: readonly number[]
    readonly texts: readonly string[]
  }[] = [
    {
      name: 'the full if/else is ONE statement',
      command: IF_ELSE,
      lines: [1, 2, 8],
      // The parser's own spans: the if/else is ONE statement however many lines it covers.
      texts: ['cmd.exe /c exit 3', IF_ELSE.split('\n').slice(1, 7).join('\n'), 'Write-Output "done"'],
    },
    {
      name: 'the full try/catch is ONE statement',
      command: TRY_CATCH,
      lines: [1, 6],
      texts: [TRY_CATCH.split('\n').slice(0, 5).join('\n'), 'Write-Output "done"'],
    },
    {
      name: 'the full do/while is ONE statement',
      command: DO_WHILE,
      lines: [1, 2, 6],
      texts: ['$i = 0', DO_WHILE.split('\n').slice(1, 5).join('\n'), 'Write-Output "i=$i"'],
    },
  ]

  for (const entry of cases) {
    it(`plans ${entry.name}`, async () => {
      const plan = await planPwshSteps(entry.command, { executable: POWERSHELL })
      expect(plan?.safe).toBe(true)
      expect(plan?.steps.map((step) => step.line)).toEqual(entry.lines)
      // Each step's text is its own STATEMENT, verbatim: a block keeps its body, and every
      // character in the step came from the user's command.
      expect(plan?.steps.map((step) => step.text)).toEqual(entry.texts)
    })
  }

  for (const entry of cases) {
    describe(entry.name, () => {
      it('produces byte-identical output and the same exit status, instrumented from the plan', async () => {
        const plan = await planPwshSteps(entry.command, { executable: POWERSHELL })
        expect(plan?.safe).toBe(true)
        const steps: readonly Step[] = plan?.steps ?? []
        const nonce = createNonce()
        const plain = await shell(entry.command)
        const marked = await shell(instrument(entry.command, steps, nonce))

        expect(markerCount(marked.stdout, nonce)).toBe(steps.length)
        expect(stripMarkers(marked.stdout, nonce)).toBe(plain.stdout)
        expect(marked.code).toBe(plain.code)
        expect(marked.stderr).toBe(plain.stderr)
      })
    })
  }

  it('refuses a command whose syntax the parser rejects, even when the braces balance', async () => {
    expect(splitSteps(BROKEN_BUT_BALANCED).safe).toBe(true)
    const plan = await planPwshSteps(BROKEN_BUT_BALANCED, { executable: POWERSHELL })
    expect(plan?.safe).toBe(false)
    // The heuristic's steps survive for the degraded card; nothing is instrumented.
    expect(plan?.steps.length).toBeGreaterThan(1)
    expect(plan?.reason).toMatch(/syntax error/)
  })

  it('asks the probe even when the heuristic refuses, and the probe refuses too', async () => {
    // The brace counter refuses this (an unclosed block), but the PARSER is the authority
    // now — and it reports errors, so the plan is a refusal either way.
    expect(splitSteps(UNCLOSED_BRACE).safe).toBe(false)
    const plan = await planPwshSteps(UNCLOSED_BRACE, { executable: POWERSHELL })
    expect(plan?.safe).toBe(false)
    expect(plan?.reason).toMatch(/syntax error/)
  })

  it('sees the trap on a real shell: errors AND a populated statement list', async () => {
    // The measured fact behind the gate, taken from the real probe rather than
    // asserted in prose. The parser answers with a best-effort tree — `LINES`
    // is populated — while reporting errors, and the verdict must be the
    // errors.
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        POWERSHELL,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildProbeSource(BROKEN_BUT_BALANCED)],
        { windowsHide: true, timeout: 30_000 },
        (error, out) => { error === null ? resolve(out) : reject(error) },
      )
    })
    expect(stdout).toMatch(/ERRORS [1-9]\d*/)
    expect(stdout).toMatch(/STATEMENTS 1:/)
    expect(parseProbeOutput(stdout)?.kind).toBe('errors')
  })

  it('is exposed by the pwsh dialect, and by bash', () => {
    expect(pwshDialect.plan).toBeTypeOf('function')
    // Stage 2 landed: bash has a planner too (tree-sitter, see
    // `./bashtree.spec.ts`). This assertion used to pin `bashDialect.plan` as
    // UNDEFINED, which was the honest Stage-1 state and is now the opposite of
    // the contract — with a planner present, a bash command the planner cannot
    // answer is REFUSED rather than split by the heuristic.
    expect(bashDialect.plan).toBeTypeOf('function')
  })
})

/** One tool result as this test reads it. */
interface ToolResult {
  readonly exitCode: number | null
  readonly stdout: { readonly text: string }
  readonly progress: {
    readonly instrumented: boolean
    readonly refused: boolean
    readonly steps: readonly { readonly line: number; readonly text: string }[]
  }
}

/** The registered tool definition, narrowed to what this suite calls. */
interface RegisteredTool {
  readonly name: string
  execute(args: { readonly command: string; readonly description: string }, exec: unknown): Promise<ToolResult>
}

/**
 * `apply` against a context whose executor runs the command for real.
 *
 * The executor is the one seam that must NOT be faked: whether the plan is
 * used is visible in the text handed to it, and whether the result is right is
 * visible in the bytes that come back.
 */
function toolWithRealExecutor(): { readonly tool: RegisteredTool; readonly handed: string[] } {
  const handed: string[] = []
  const registry: RegisteredTool[] = []
  const base: Record<string, unknown> = {
    tools: { register: (definition: RegisteredTool) => { registry.push(definition); return () => {} } },
    shell: {
      sandboxMode: undefined,
      resolve: (request: unknown) => request,
      execute: async (request: { readonly command: string }) => {
        handed.push(request.command)
        const run = await shell(request.command)
        let cursor = 0
        return {
          readOutput: () => {
            const delta = run.stdout.slice(cursor)
            cursor = run.stdout.length
            return { delta, lossy: false }
          },
          done: Promise.resolve(),
          result: async () => ({
            aborted: false,
            exitCode: run.code,
            signal: null,
            timedOut: false,
            timeoutMs: 60_000,
            stdout: { text: run.stdout, truncated: false },
            stderr: { text: run.stderr, truncated: false },
          }),
        }
      },
    },
    shellEnv: { collect: () => ({}) },
    systemPrompt: undefined,
    logger: { debug: () => {}, warn: () => {} },
    effect: (fn: () => unknown) => fn(),
    inject: (_deps: string[], callback: (ctx: unknown) => unknown) => callback(base),
    get: () => undefined,
  }
  // A tiny poll interval: the executor is already finished when it returns.
  apply(base as never, { pollIntervalMs: 1 })
  const tool = registry[0]
  if (tool === undefined) throw new Error('the plugin registered no tool')
  return { tool, handed }
}

/** Drive one command through the registered tool. */
async function throughTool(command: string): Promise<{ readonly result: ToolResult; readonly handed: string }> {
  const { tool, handed } = toolWithRealExecutor()
  const result = await tool.execute({ command, description: 'planner wiring' }, { callId: 'call-1' })
  const sent = handed[0]
  if (sent === undefined) throw new Error('the executor was never called')
  return { result, handed: sent }
}

describe.skipIf(!available)('the tool path instruments from the plan, not the brace counter', () => {
  it('uses the plan\'s step lines for the if/else command', async () => {
    const { result, handed } = await throughTool(IF_ELSE)
    const plain = await shell(IF_ELSE)

    // The plan's lines, not the heuristic's [1, 2, 5, 8].
    expect(result.progress.instrumented).toBe(true)
    expect(result.progress.steps.map((step) => step.line)).toEqual([1, 2, 8])
    // No marker before the `else`, which is what used to break the command.
    const sent = handed.split('\n')
    expect(sent[0]).toContain('__DSH_STEP_')
    expect(sent[1]).toContain('__DSH_STEP_')
    expect(sent[4]).toBe('else {')
    expect(sent[4]).not.toContain('__DSH_STEP_')
    expect(sent[7]).toContain('__DSH_STEP_')
    // And the model still sees exactly the plain command's bytes.
    expect(result.exitCode).toBe(plain.code)
    expect(result.stdout.text).toBe(plain.stdout)
  })

  it('uses the plan for the do/while tail at column 0', async () => {
    const { result, handed } = await throughTool(DO_WHILE)
    const plain = await shell(DO_WHILE)
    expect(result.progress.instrumented).toBe(true)
    expect(result.progress.steps.map((step) => step.line)).toEqual([1, 2, 6])
    expect(handed.split('\n')[4]).toBe('while ($i -lt 2)')
    expect(result.stdout.text).toBe(plain.stdout)
  })

  it('runs a syntax-broken command unmodified, and its record carries the refusal', async () => {
    // The plan DID answer here — its verdict is "PowerShell reported syntax errors" — and it
    // hands back a best-effort step list. That list is NOT reported: the command ran without
    // markers, so those rows could only ever read "pending", with no timing and no output of
    // their own. The ONE step the record carries is the whole command, which the card draws
    // as a single segment; `refused` is what tells the client the command was not split.
    const { result, handed } = await throughTool(BROKEN_BUT_BALANCED)
    const plain = await shell(BROKEN_BUT_BALANCED)
    expect(result.progress.instrumented).toBe(false)
    expect(result.progress.refused).toBe(true)
    // The CARD's tooltip states this code (see `RefusalCode`): the host logs the English
    // sentence, and the card itself must say the reason in the reader's language.
    expect(result.progress.refusedReason).toBe('syntax-error')
    expect(result.progress.steps).toHaveLength(1)
    expect(result.progress.steps[0]?.text).toBe(BROKEN_BUT_BALANCED)
    expect(handed).toBe(BROKEN_BUT_BALANCED)
    expect(result.stdout.text).toBe(plain.stdout)
    expect(result.exitCode).toBe(plain.code)
  })

  // The tests below are the NEW contract of `resolveSplit`. They replace the old
  // "pins the heuristic bug the plan fixes" test, which asserted the heuristic's
  // superseded `[1, 2, 5, 8]`: when a dialect has a planner, a parse that cannot be
  // produced is a REFUSAL, never a fallback to the guess.

  it('refuses an unclosed block the planner was asked about, and runs it unmodified', async () => {
    // `planPwshSteps` answers `undefined` here (the heuristic already refuses, so
    // the probe is skipped) — the "heuristic-already-unsafe skip" case.
    expect(splitSteps(UNCLOSED_BRACE).safe).toBe(false)
    const { result, handed } = await throughTool(UNCLOSED_BRACE)
    const plain = await shell(UNCLOSED_BRACE)
    expect(result.progress.instrumented).toBe(false)
    expect(result.progress.refused).toBe(true)
    // ONE step: the whole command. A refusal is not a guess, so it never reports the
    // planner's rows — but the command itself is real, and the card draws it as one segment.
    expect(result.progress.steps).toHaveLength(1)
    expect(result.progress.steps[0]?.text).toBe(UNCLOSED_BRACE)
    expect(handed).toBe(UNCLOSED_BRACE)
    expect(result.stdout.text).toBe(plain.stdout)
    expect(result.exitCode).toBe(plain.code)
  })

  it('never falls back to the heuristic when the planner cannot deliver', async () => {
    // The brace counter is happy with twenty column-zero statements, so the OLD
    // code instrumented this from its own guess. The probe cannot even be built,
    // which is a refusal: the command must reach the shell verbatim.
    const heuristic = splitSteps(OVERSIZED)
    expect(heuristic.safe).toBe(true)
    expect(heuristic.steps).toHaveLength(20)
    expect(buildProbeSource(OVERSIZED).length).toBeGreaterThan(MAX_PROBE_CHARS)

    const { result, handed } = await throughTool(OVERSIZED)
    const plain = await shell(OVERSIZED)
    expect(result.progress.instrumented).toBe(false)
    expect(result.progress.refused).toBe(true)
    expect(result.progress.steps).toHaveLength(1)
    expect(result.progress.steps[0]?.text).toBe(OVERSIZED)
    expect(handed).toBe(OVERSIZED)
    expect(handed).not.toContain('__DSH_STEP_')
    expect(result.stdout.text).toBe(plain.stdout)
    expect(result.exitCode).toBe(plain.code)
  })

  it('refuses when the planner cannot spawn a shell, and still runs the command for real', async () => {
    // `DSH_PWSH_PATH` is a bare name, which the resolver returns without touching
    // the filesystem — so only the PLANNER's spawn fails, and the suite's own shell
    // (resolved when this module loaded) is untouched. An if/else the heuristic
    // would instrument is refused instead: that pivot is this change.
    const before = process.env.DSH_PWSH_PATH
    process.env.DSH_PWSH_PATH = 'dsh-shell-that-does-not-exist'
    try {
      const { result, handed } = await throughTool(IF_ELSE)
      const plain = await shell(IF_ELSE)
      expect(result.progress.instrumented).toBe(false)
      expect(result.progress.refused).toBe(true)
      expect(result.progress.steps).toHaveLength(1)
      expect(result.progress.steps[0]?.text).toBe(IF_ELSE)
      expect(handed).toBe(IF_ELSE)
      expect(handed).not.toContain('__DSH_STEP_')
      expect(result.stdout.text).toBe(plain.stdout)
      expect(result.exitCode).toBe(plain.code)
    } finally {
      if (before === undefined) delete process.env.DSH_PWSH_PATH
      else process.env.DSH_PWSH_PATH = before
    }
  })

  it('does not refuse an ordinary single-line command', async () => {
    // The one uninstrumented case that is NOT a refusal: there is no boundary to
    // decide, so the card stays quiet — which the refusal flag, not a step count,
    // is what now distinguishes.
    const command = "Write-Output 'one'"
    const { result, handed } = await throughTool(command)
    expect(result.progress.instrumented).toBe(false)
    expect(result.progress.refused).toBe(false)
    expect(result.progress.steps).toHaveLength(1)
    expect(handed).toBe(command)
  })
})
