/**
 * The bash parse-based planner, and the tool path that uses it.
 *
 * Four things need proving, and they are different questions:
 *
 * 1. `./bashtree.ts` must answer correctly: a clean parse becomes the top-level
 *    statements' line numbers, a block form contributes ONE line (the one that
 *    opens it), and a parse with an `ERROR` node is REFUSED rather than read.
 *    Those are pure tests and they run everywhere.
 * 2. A grammar that cannot be loaded must yield `undefined`, never a throw and
 *    never a fallback.
 * 3. The tool must actually USE the parser's answer — so the last suites drive
 *    the registered tool through `apply`. One does it with an executor that only
 *    records what it was handed (so the marker placement is checked on every
 *    host), and one runs a REAL bash, so "nothing changed" is measured in bytes
 *    rather than asserted in prose.
 * 4. The pivot itself: every command these suites plan is one `splitBash`
 *    REFUSES. If that stops being true, these tests are no longer about the
 *    planner.
 *
 * The suites that need a real interpreter are skipped when none can be spawned
 * (see `./bash-path.ts`), because a false red would be worse than a skip.
 *
 * @module dsh-shell-progress/tests/bashtree
 */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bashDialect, instrumentBash, splitBash } from '../src/bash.ts'
import {
  GRAMMAR_URL,
  loadBashParser,
  planBashSteps,
  sharedBashParser,
} from '../src/bashtree.ts'
import { apply } from '../src/index.ts'
import { MARKER_PREFIX, createNonce, markerPattern, stripMarkers } from '../src/instrument.ts'
import { stepsAtLines } from '../src/plan.ts'
import { stepsAtLines as stepsAtLinesFromPwsh } from '../src/pwshtree.ts'
import { resolveBash } from './bash-path.ts'

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The executable a POSIX host's shell seam would pick. */
const BASH = resolveBash()

/** Run one command in a fresh bash, exactly as the harness's tool does. */
async function bash(command: string): Promise<Run> {
  return await new Promise<Run>((resolve) => {
    execFile(
      BASH ?? 'bash',
      ['-c', command],
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

/**
 * An `if`/`else` block: the shape the heuristic CANNOT do, because
 * `if`/`then`/`else`/`fi` are keyword-delimited and a brace counter cannot find
 * their end. The `else` sits at column 0, exactly where a wrong boundary would
 * land a marker and turn a valid command into a syntax error.
 */
const IF_ELSE = [
  'if [ 1 -eq 1 ]; then',
  '  echo yes',
  'else',
  '  echo no',
  'fi',
  'echo done',
].join('\n')

/** A `for` loop whose body must never become a step. */
const FOR_DO = [
  'for n in 1 2 3; do',
  '  echo $n',
  'done',
  'echo after',
].join('\n')

/** A `while` loop preceded by a real step. */
const WHILE_DO = [
  'i=0',
  'while [ $i -lt 2 ]; do',
  '  i=$((i+1))',
  'done',
  'echo after',
].join('\n')

/** The plain two-line sequence, whose parse adds nothing to the heuristic. */
const SEQUENCE = ['echo one', 'echo two'].join('\n')

/**
 * A script bash cannot parse. The heuristic refuses it too (the `if` keyword),
 * so on its own it only shows that SOMETHING refuses. {@link BROKEN_SEMICOLONS}
 * is the case that isolates the parser: the heuristic is perfectly happy with
 * it and would have instrumented it from its own guess.
 */
const BROKEN_IF = ['if true; then', '  echo yes', 'echo done'].join('\n')

/**
 * The trap, measured: `;;` outside a `case` is a bash syntax error, opens no
 * brace, closes none, and starts with no reserved word — so `splitBash` reports
 * `safe: true` with three steps and would have instrumented all three. Only the
 * parser's error flag catches it. (This is bash's counterpart of the pwsh
 * suite's `[` line, which is a parse error that changes no depth.)
 */
const BROKEN_SEMICOLONS = ['echo before', ';;', 'echo after'].join('\n')

describe('the grammar the planner loads', () => {
  it('is addressed from this module\'s own location, not the working directory', () => {
    expect(GRAMMAR_URL.protocol).toBe('file:')
    expect(GRAMMAR_URL.pathname.endsWith('/vendor/tree-sitter-bash.wasm')).toBe(true)
    // Resolved independently from THIS file's own directory: `tests/../vendor`,
    // which is the same package-relative file `src/../vendor` names.
    expect(fileURLToPath(GRAMMAR_URL)).toBe(resolve(import.meta.dirname, '../vendor/tree-sitter-bash.wasm'))
  })

  it('builds one shared parser and reuses it', async () => {
    const first = await sharedBashParser()
    const second = await sharedBashParser()
    expect(first).toBeDefined()
    // Same instance: a second call does not re-read or re-compile the wasm.
    expect(second).toBe(first)
  })
})

describe('planBashSteps skips only what it cannot help with', () => {
  it('skips a single-line command', async () => {
    expect(await planBashSteps('echo one')).toBeUndefined()
  })

  it('skips a multi-line command the heuristic already splits into one step', async () => {
    // A `;` chain is ONE line and therefore one step; the parse would agree.
    const command = ['echo a; echo b'].join('\n')
    expect(splitBash(command).safe).toBe(true)
    expect(await planBashSteps(command)).toBeUndefined()
  })

  it('PARSES a command the heuristic refuses, because that is the whole point', async () => {
    // The heuristic refuses every keyword block, so a planner that skipped
    // `safe: false` would never plan anything the heuristic could not already
    // do — see the module header of `./bashtree.ts`.
    expect(splitBash(IF_ELSE).safe).toBe(false)
    const plan = await planBashSteps(IF_ELSE)
    expect(plan?.safe).toBe(true)
    expect(plan?.steps.map((step) => step.line)).toEqual([1, 6])
  })
})

describe('planBashSteps, against the real grammar', () => {
  const cases: readonly { readonly name: string; readonly command: string; readonly lines: readonly number[] }[] = [
    { name: 'a two-line sequence is two steps', command: SEQUENCE, lines: [1, 2] },
    { name: 'the whole if/else block is ONE step', command: IF_ELSE, lines: [1, 6] },
    { name: 'the whole for loop is ONE step', command: FOR_DO, lines: [1, 4] },
    { name: 'the whole while loop is ONE step', command: WHILE_DO, lines: [1, 2, 5] },
  ]

  for (const entry of cases) {
    it(`plans ${entry.name}`, async () => {
      const plan = await planBashSteps(entry.command)
      expect(plan?.safe).toBe(true)
      expect(plan?.steps.map((step) => step.line)).toEqual(entry.lines)
      // Each step's text is its own source line, unchanged.
      for (const step of plan?.steps ?? []) {
        expect(step.text).toBe(entry.command.split('\n')[step.line - 1])
      }
    })
  }

  it('gives a block only its OPENING line, never its body', async () => {
    // The failure this guards is a marker on `else` or on a loop body, which is
    // both a wrong step and — for `else` at column 0 — a syntax error.
    const ifElse = await planBashSteps(IF_ELSE)
    expect(ifElse?.steps.map((step) => step.line)).not.toContain(3)
    expect(ifElse?.steps.map((step) => step.line)).toEqual([1, 6])

    const forDo = await planBashSteps(FOR_DO)
    expect(forDo?.steps.map((step) => step.line)).toEqual([1, 4])

    const whileDo = await planBashSteps(WHILE_DO)
    expect(whileDo?.steps.map((step) => step.line)).toEqual([1, 2, 5])
  })

  it('keeps two statements that share one line as ONE step', async () => {
    const command = ['a=1; b=2', 'echo $b'].join('\n')
    const plan = await planBashSteps(command)
    expect(plan?.safe).toBe(true)
    expect(plan?.steps.map((step) => step.line)).toEqual([1, 2])
  })

  it('refuses a script the parser reports a syntax error in', async () => {
    // THE TRAP. tree-sitter does not fail on broken input: it decorates the
    // tree with an ERROR node and still reports top-level children, so the
    // error flag is the only thing that may be believed.
    const plan = await planBashSteps(BROKEN_IF)
    expect(plan?.safe).toBe(false)
    expect(plan?.steps).toEqual([])
    expect(plan?.reason).toMatch(/syntax error/)
  })

  it('refuses a syntax error the brace counter cannot see', async () => {
    // `;;` opens no brace and starts with no reserved word, so `splitBash`
    // accepts it: THREE steps, all of which it would have instrumented. Only
    // the parser's error flag stands between that guess and a broken command.
    expect(splitBash(BROKEN_SEMICOLONS).safe).toBe(true)
    expect(splitBash(BROKEN_SEMICOLONS).steps).toHaveLength(3)
    const plan = await planBashSteps(BROKEN_SEMICOLONS)
    expect(plan?.safe).toBe(false)
    expect(plan?.steps).toEqual([])
    expect(plan?.reason).toMatch(/syntax error/)
  })
})

describe('a released tree never costs the shared parser', () => {
  /**
   * 200, and the number is not doing the work: the failure this guards against
   * is DETERMINISTIC, not probabilistic. If the release reached the shared
   * `Parser` (or its `Language`) instead of the tree, the very next
   * `planBashSteps` would throw inside `parser.parse` and come back `undefined`
   * — a refusal — so the second iteration alone would already fail. 200 puts
   * the loop far past any per-call lazy re-initialisation and past the point
   * where a finalizer could plausibly have freed something this module still
   * holds, and costs ~8 ms (the 200-call loop and the 25-call refusal loop
   * measure 8 ms and 2 ms in this suite).
   */
  const ITERATIONS = 200

  it('plans the same if/else command on every one of 200 consecutive calls', async () => {
    const parser = await sharedBashParser()
    expect(parser).toBeDefined()

    const seen: (readonly number[] | undefined)[] = []
    for (let i = 0; i < ITERATIONS; i += 1) {
      const plan = await planBashSteps(IF_ELSE)
      seen.push(plan?.steps.map((step) => step.line))
    }

    // Every call answered, and answered identically. An over-eager release
    // shows up as `undefined` (or a throw) on the first call after it, which
    // the array comparison reports in full.
    expect(seen).toEqual(Array.from({ length: ITERATIONS }, () => [1, 6]))
    // The cached slot still holds the SAME live parser afterwards.
    expect(await sharedBashParser()).toBe(parser)
  })

  it('keeps planning after the REFUSAL path released its tree too', async () => {
    // The `hasError` branch returns early; without the `finally` that path is
    // the one a tree leaks from, and a wrong release there would break planning
    // for every command that followed it.
    for (let i = 0; i < 25; i += 1) {
      const refused = await planBashSteps(BROKEN_SEMICOLONS)
      expect(refused?.safe).toBe(false)
      expect(refused?.steps).toEqual([])
    }
    const after = await planBashSteps(IF_ELSE)
    expect(after?.safe).toBe(true)
    expect(after?.steps.map((step) => step.line)).toEqual([1, 6])
  })
})

describe('a grammar that cannot be loaded yields undefined, never a throw', () => {
  it('returns undefined for a wasm file that is not there', async () => {
    const absent = new URL('./__no_such_grammar__.wasm', import.meta.url)
    expect(await loadBashParser(absent)).toBeUndefined()
  })

  it('returns undefined for a wasm file that is not a wasm file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sp-bash-grammar-'))
    const path = join(dir, 'tree-sitter-bash.wasm')
    await writeFile(path, 'this is not a WebAssembly module')
    expect(await loadBashParser(pathToFileURL(path))).toBeUndefined()
    // A broken attempt must not poison the runtime for the real grammar.
    expect(await sharedBashParser()).toBeDefined()
  })

  it('is what the host turns into a refusal — the shared parser has no fallback', async () => {
    // The shared slot is a module-level cache seeded from `GRAMMAR_URL`, so a
    // test cannot point `planBashSteps` itself at a bad grammar. The nearest
    // honest thing is what `planBashSteps` calls: the loader, which returns
    // `undefined` for exactly the inputs above, and `resolveSplit`, which turns
    // that into a refusal instead of a guessed split (`./pwshtree.spec.ts` pins
    // that path).
    expect(await planBashSteps('echo one')).toBeUndefined()
    expect(await planBashSteps('if true; then\necho x\nfi')).toBeDefined()
  })

  it('is exposed by the bash dialect', () => {
    expect(bashDialect.plan).toBe(planBashSteps)
  })
})

describe('stepsAtLines is shared, not duplicated', () => {
  it('is the same function the pwsh planner re-exports', () => {
    // The extraction into `./plan.ts` must not have left a second copy behind
    // in `./pwshtree.ts`.
    expect(stepsAtLinesFromPwsh).toBe(stepsAtLines)
  })

  it('collapses duplicate lines and drops a line the source does not have', () => {
    expect(stepsAtLines('a=1; b=2\necho $b', [1, 1, 2])).toEqual([
      { line: 1, text: 'a=1; b=2' },
      { line: 2, text: 'echo $b' },
    ])
    expect(stepsAtLines('echo 1', [1, 9])).toEqual([{ line: 1, text: 'echo 1' }])
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

/** The `apply` context shape these suites build, with only what the tool touches. */
function fakeContext(execute: (command: string) => Promise<unknown>): {
  readonly ctx: Record<string, unknown>
  readonly registry: RegisteredTool[]
  readonly handed: string[]
} {
  const handed: string[] = []
  const registry: RegisteredTool[] = []
  const ctx: Record<string, unknown> = {
    tools: { register: (definition: RegisteredTool) => { registry.push(definition); return () => {} } },
    shell: {
      sandboxMode: undefined,
      resolve: (request: unknown) => request,
      execute: async (request: { readonly command: string }) => {
        handed.push(request.command)
        return await execute(request.command)
      },
    },
    shellEnv: { collect: () => ({}) },
    systemPrompt: undefined,
    logger: { debug: () => {}, warn: () => {} },
    effect: (fn: () => unknown) => fn(),
    inject: (_deps: string[], callback: (context: unknown) => unknown) => callback(ctx),
    get: () => undefined,
  }
  return { ctx, registry, handed }
}

/** One completed run as an executor would report it. */
function finishedRun(stdoutText: string, code = 0): Record<string, unknown> {
  let cursor = 0
  return {
    readOutput: () => {
      const delta = stdoutText.slice(cursor)
      cursor = stdoutText.length
      return { delta, lossy: false }
    },
    done: Promise.resolve(),
    result: async () => ({
      aborted: false,
      exitCode: code,
      signal: null,
      timedOut: false,
      timeoutMs: 60_000,
      stdout: { text: stdoutText, truncated: false },
      stderr: { text: '', truncated: false },
    }),
  }
}

/**
 * `apply` with an executor that only RECORDS the command it was handed.
 *
 * Nothing is executed, so the assertions below are about the TEXT this plugin
 * produced — which is the only place a misplaced marker can be seen — and they
 * run on every host.
 */
function toolWithRecordingExecutor(): { readonly tool: RegisteredTool; readonly handed: string[] } {
  const { ctx, registry, handed } = fakeContext(async () => finishedRun(''))
  apply(ctx as never, { pollIntervalMs: 1, dialects: ['bash'] })
  const tool = registry[0]
  if (tool === undefined) throw new Error('the plugin registered no tool')
  return { tool, handed }
}

/** Drive one command through the registered bash tool, recording what it sent. */
async function throughTool(command: string): Promise<{ readonly result: ToolResult; readonly handed: string }> {
  const { tool, handed } = toolWithRecordingExecutor()
  const result = await tool.execute({ command, description: 'planner wiring' }, { callId: 'call-1' })
  const sent = handed[0]
  if (sent === undefined) throw new Error('the executor was never called')
  return { result, handed: sent }
}

describe('the tool path instruments from the plan, not the heuristics refusal', () => {
  it('marks the if/else block\'s opening and closing lines and nothing inside it', async () => {
    const { result, handed } = await throughTool(IF_ELSE)

    // The plan's lines. The heuristic could only ever have refused this command.
    expect(result.progress.instrumented).toBe(true)
    expect(result.progress.refused).toBe(false)
    expect(result.progress.steps.map((step) => step.line)).toEqual([1, 6])

    const sent = handed.split('\n')
    expect(sent[0]).toContain(MARKER_PREFIX)
    expect(sent[0]).toContain('if [ 1 -eq 1 ]; then')
    // The body and the `else` clause are untouched — a marker on line 3 would
    // be a syntax error, which is exactly the bug the heuristic has.
    expect(sent[1]).toBe('  echo yes')
    expect(sent[2]).toBe('else')
    expect(sent[3]).toBe('  echo no')
    expect(sent[4]).toBe('fi')
    expect(sent[5]).toContain(MARKER_PREFIX)
  })

  it('marks only the loop header and the step after it', async () => {
    const { result, handed } = await throughTool(FOR_DO)
    expect(result.progress.instrumented).toBe(true)
    expect(result.progress.steps.map((step) => step.line)).toEqual([1, 4])
    const sent = handed.split('\n')
    expect(sent[0]).toContain(MARKER_PREFIX)
    expect(sent[1]).toBe('  echo $n')
    expect(sent[2]).toBe('done')
    expect(sent[3]).toContain(MARKER_PREFIX)
  })

  it('runs a syntax-broken command unmodified, and its record carries the refusal', async () => {
    const { result, handed } = await throughTool(BROKEN_IF)
    expect(result.progress.instrumented).toBe(false)
    expect(result.progress.refused).toBe(true)
    expect(result.progress.steps).toEqual([])
    expect(handed).toBe(BROKEN_IF)
    expect(handed).not.toContain(MARKER_PREFIX)
  })

  it('does not refuse an ordinary single-line command', async () => {
    const command = 'echo one'
    const { result, handed } = await throughTool(command)
    expect(result.progress.instrumented).toBe(false)
    expect(result.progress.refused).toBe(false)
    expect(result.progress.steps).toHaveLength(1)
    expect(handed).toBe(command)
  })
})

const available = BASH !== undefined && (await bash('echo ready')).stdout.trim() === 'ready'

describe.skipIf(!available)('the planner, against a real bash', () => {
  for (const entry of [
    { name: 'the if/else block', command: IF_ELSE, lines: [1, 6] },
    { name: 'the for loop', command: FOR_DO, lines: [1, 4] },
    { name: 'the while loop', command: WHILE_DO, lines: [1, 2, 5] },
  ]) {
    it(`produces byte-identical output and the same exit status for ${entry.name}`, async () => {
      const plan = await planBashSteps(entry.command)
      expect(plan?.safe).toBe(true)
      expect(plan?.steps.map((step) => step.line)).toEqual(entry.lines)

      const nonce = createNonce()
      const plain = await bash(entry.command)
      const marked = await bash(instrumentBash(entry.command, plan?.steps ?? [], nonce))

      // The markers really ran, and the model-visible bytes are the plain run's.
      expect(markerCount(marked.stdout, nonce)).toBe((plan?.steps ?? []).length)
      expect(stripMarkers(marked.stdout, nonce)).toBe(plain.stdout)
      expect(marked.code).toBe(plain.code)
      expect(marked.stderr).toBe(plain.stderr)
    })
  }
})

describe.skipIf(!available)('the tool path against a real bash', () => {
  it('runs the planned if/else through the executor and returns the plain bytes', async () => {
    // The executor here is the one seam that must NOT be faked: whether the
    // plan is used is visible in the text handed to it, and whether the result
    // is right is visible in the bytes that come back.
    const { ctx, registry, handed } = fakeContext(async (command) => {
      const run = await bash(command)
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
    })
    apply(ctx as never, { pollIntervalMs: 1, dialects: ['bash'] })
    const tool = registry[0]
    if (tool === undefined) throw new Error('the plugin registered no tool')

    const plain = await bash(IF_ELSE)
    const result = await tool.execute({ command: IF_ELSE, description: 'real bash' }, { callId: 'call-1' })
    const sent = handed[0] ?? ''

    expect(result.progress.instrumented).toBe(true)
    expect(result.progress.steps.map((step) => step.line)).toEqual([1, 6])
    const lines = sent.split('\n')
    expect(lines[0]).toContain(MARKER_PREFIX)
    expect(lines[2]).toBe('else')
    expect(lines[2]).not.toContain(MARKER_PREFIX)
    expect(result.exitCode).toBe(plain.code)
    expect(result.stdout.text).toBe(plain.stdout)
  })
})

/**
 * The cache's stickiness, and the parser's own failure branches.
 *
 * Neither has a seam in production — `sharedBashParser` is a module-level
 * `??=` slot and `planBashSteps` calls whatever it holds — so the seam is
 * VITEST'S: `vi.doMock('web-tree-sitter', …)` replaces the one package the
 * loader imports, which is enough to make the first load fail and to hand the
 * planner a parser that misbehaves.
 *
 * ## Why `doMock` and a dynamic import, and not a file-level `vi.mock`
 *
 * `vi.mock` is hoisted, so a mock declared here would replace the loader for
 * EVERY suite in this file — including the ones above that need the real
 * grammar. `vi.doMock` is registered inside the case, after those suites have
 * run.
 *
 * `parserPromise ??= loadBashParser()` lives in the MODULE, so the mock alone
 * cannot reset it: a fresh `import('../src/bashtree.ts')` is what gives each
 * case its own empty slot. `vi.resetModules()` first, then `doMock`, then the
 * dynamic import — in that order, because resetting the registry also drops the
 * mock registration and the import that follows must see it.
 *
 * `FOR_DO` is the command these cases drive: the heuristic REFUSES it (its
 * `for`/`do`/`done` are keyword-delimited) and it is multi-line, which is the
 * only path through `planBashSteps` that reaches the loader at all.
 */
describe('a failed grammar load is cached, and the parser\'s own failures are swallowed', () => {
  /** How many times each step of the load — and the parse — was entered. */
  interface Counters {
    init: number
    load: number
    parse: number
  }

  /** A module the loader can be handed instead of the real `web-tree-sitter`. */
  type MockedLoader = Record<string, unknown>

  afterEach(() => {
    // Drop the mock BEFORE the next registry reset, so a later case — or a
    // later FILE, since vitest isolates files but not necessarily workers —
    // cannot inherit a stubbed loader.
    vi.doUnmock('web-tree-sitter')
    vi.resetModules()
  })

  /**
   * Build a FRESH `./bashtree.ts` over one mocked loader module.
   * @param factory - builds the mocked module, closing over the counters.
   * @returns the freshly imported module and the counters it reports through.
   */
  async function freshBashtreeOver(
    factory: (counters: Counters) => MockedLoader,
  ): Promise<{ readonly bashtree: typeof import('../src/bashtree.ts'); readonly counters: Counters }> {
    const counters: Counters = { init: 0, load: 0, parse: 0 }
    vi.resetModules()
    vi.doMock('web-tree-sitter', () => factory(counters))
    return { bashtree: await import('../src/bashtree.ts'), counters }
  }

  it('does NOT retry a load that failed in Parser.init', async () => {
    const { bashtree, counters } = await freshBashtreeOver(() => ({
      Parser: {
        init: async (): Promise<void> => {
          counters.init += 1
          throw new Error('the wasm loader is not usable')
        },
      },
      Language: {
        load: async (): Promise<unknown> => {
          counters.load += 1
          return {}
        },
      },
    }))

    // The FIRST call pays for the attempt and degrades to the safe refusal.
    expect(await bashtree.planBashSteps(FOR_DO)).toBeUndefined()
    // The SECOND call must NOT pay again. This is the assertion that proves the
    // stickiness: `??=` kept the first promise, so the failing `init` ran once.
    expect(await bashtree.planBashSteps(FOR_DO)).toBeUndefined()
    expect(counters.init, 'the failed load was attempted more than once').toBe(1)
    // `Language.load` is behind `init`, so it was never reached at all.
    expect(counters.load).toBe(0)
  })

  it('does NOT retry a load that failed at Language.load', async () => {
    const { bashtree, counters } = await freshBashtreeOver(() => ({
      Parser: {
        init: async (): Promise<void> => {
          counters.init += 1
        },
      },
      Language: {
        load: async (): Promise<unknown> => {
          counters.load += 1
          throw new Error('the grammar is corrupt or truncated')
        },
      },
    }))

    expect(await bashtree.planBashSteps(FOR_DO)).toBeUndefined()
    expect(await bashtree.planBashSteps(FOR_DO)).toBeUndefined()
    // Same instance of `init` once, and the grammar read once: the cached
    // promise — the one that resolved to undefined — answered the second call.
    expect(counters.init).toBe(1)
    expect(counters.load, 'the grammar was re-read after the first failure').toBe(1)
  })

  it('turns a parse that returns null into no answer, not a throw', async () => {
    const { bashtree, counters } = await freshBashtreeOver(() => ({
      Parser: class {
        static async init(): Promise<void> { counters.init += 1 }
        setLanguage(): void {}
        parse(): null {
          counters.parse += 1
          return null
        }
      },
      Language: { load: async (): Promise<unknown> => { counters.load += 1; return {} } },
    }))

    // The loader SUCCEEDS here, so the branch under test is `parseTree`'s
    // `?? undefined`: a null parse is "no authoritative answer", which the
    // caller turns into a refusal rather than a guessed split.
    expect(await bashtree.planBashSteps(FOR_DO)).toBeUndefined()
    // Proof the branch was entered, not skipped: the parser was asked once.
    expect(counters.parse).toBe(1)
    expect(counters.load).toBe(1)
  })

  it('turns a parse that throws into no answer, not a throw into the tool path', async () => {
    const { bashtree, counters } = await freshBashtreeOver(() => ({
      Parser: class {
        static async init(): Promise<void> { counters.init += 1 }
        setLanguage(): void {}
        parse(): never {
          counters.parse += 1
          throw new Error('the wasm tree allocation failed')
        }
      },
      Language: { load: async (): Promise<unknown> => { counters.load += 1; return {} } },
    }))

    // `expect(...).resolves` would pass on a rejection only by accident; the
    // awaited call itself must RETURN undefined.
    await expect(bashtree.planBashSteps(FOR_DO)).resolves.toBeUndefined()
    expect(counters.parse).toBe(1)
  })

  it('still loads the REAL grammar once the mock is gone', async () => {
    // The reset above is what makes this true, and it is the guard against a
    // leak: a later suite must never be handed a stubbed loader.
    const first = await sharedBashParser()
    expect(first).toBeDefined()
    expect(await sharedBashParser()).toBe(first)
  })
})
