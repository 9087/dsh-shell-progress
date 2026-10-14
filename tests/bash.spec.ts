/**
 * The bash half of the semantics suite: does instrumentation change what the
 * command does?
 *
 * This is the test that matters. A splitter or marker bug cannot be caught by
 * asserting the marker's shape — the only honest question is whether the SAME
 * command, run plain and run instrumented, exits the same way and produces the
 * same output. The PowerShell half (`./powershell.spec.ts`) asks exactly that;
 * this asks it of bash, against a real interpreter.
 *
 * Skipped when no usable bash exists (see `./bash-path.ts`), because a false red
 * would be worse than a skip.
 *
 * @module dsh-shell-progress/tests/bash
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { instrumentBash, splitBash } from '../src/bash.ts'
import { createNonce, markerPattern, stripMarkers } from '../src/instrument.ts'
import { resolveBash } from './bash-path.ts'

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The executable a POSIX host's shell seam would pick. */
const BASH = resolveBash()

/** Run one command in a fresh bash, exactly as the harness's tool does. */
async function bash(command: string, cwd?: string): Promise<Run> {
  return await new Promise<Run>((resolve) => {
    execFile(
      BASH ?? 'bash',
      ['-c', command],
      { windowsHide: true, timeout: 60_000, ...cwd === undefined ? {} : { cwd } },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : 1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** One probe: what the command exercises, and the command itself. */
interface Probe {
  readonly name: string
  readonly command: string
}

/**
 * Every probe must be one this splitter DECIDES — a probe that quietly became
 * "unsafe" would turn this suite into a no-op, so the test asserts `safe` too.
 */
const PROBES: readonly Probe[] = [
  {
    name: 'a step that reads $? right after a failure',
    command: ['echo before', 'false', 'echo "after=$?"'].join('\n'),
  },
  {
    name: 'a non-zero exit status',
    command: ['echo before', 'exit 7'].join('\n'),
  },
  {
    name: 'braces and hashes inside strings',
    command: [
      'echo "{ not a brace }"',
      'echo "hash # inside a string"',
      'echo \'single # quoted\'',
    ].join('\n'),
  },
  {
    name: 'a `;` chain, which is ONE step on ONE line',
    command: ['echo a; echo b', 'echo c'].join('\n'),
  },
  {
    name: 'command substitution kept on its own line',
    command: ['x=$(echo hi)', 'echo "x=$x"'].join('\n'),
  },
  {
    name: 'a pipeline across a step boundary',
    command: ['echo hello | tr a-z A-Z', 'echo done'].join('\n'),
  },
  {
    name: 'a backslash inside an argument',
    command: ['echo "a\\tb"', 'echo end'].join('\n'),
  },
]

/** Count this call's marker lines in a captured stream. */
function markerCount(text: string, nonce: string): number {
  const pattern = markerPattern(nonce)
  return text.split('\n').filter((line) => pattern.test(line.endsWith('\r') ? line.slice(0, -1) : line)).length
}

const available = BASH !== undefined && (await bash('echo ready')).stdout.trim() === 'ready'

describe.skipIf(!available)('instrumentation preserves bash command semantics', () => {
  for (const probe of PROBES) {
    it(probe.name, async () => {
      const split = splitBash(probe.command)
      // A probe this splitter refuses is excluded from the loop's meaning: the
      // command would run unmodified and the comparison below would be vacuous.
      expect(split.safe, `the splitter refused a probe it should accept: ${probe.command}`).toBe(true)
      expect(split.steps.length).toBeGreaterThan(1)

      const nonce = createNonce()
      const instrumented = instrumentBash(probe.command, split.steps, nonce)

      const plain = await bash(probe.command)
      const marked = await bash(instrumented)

      // The marker must actually have run, or this proves nothing.
      expect(markerCount(marked.stdout, nonce)).toBeGreaterThan(0)
      // Exit code and model-visible output are byte-identical.
      expect(marked.code, `exit code changed:\n${instrumented}`).toBe(plain.code)
      expect(stripMarkers(marked.stdout, nonce)).toBe(plain.stdout)
      expect(marked.stderr).toBe(plain.stderr)
    })
  }
})

describe.skipIf(!available)('the inlined marker is what makes $? survive', () => {
  it('reads the same $? as the uninstrumented command', async () => {
    const command = ['false', 'echo "after=$?"'].join('\n')
    const split = splitBash(command)
    const nonce = createNonce()
    const marked = await bash(instrumentBash(command, split.steps, nonce))

    // `printf` SUCCEEDS, so without the restore step this reads after=0: the
    // marker would have turned a failed command into a successful-looking one.
    expect(stripMarkers(marked.stdout, nonce).trim()).toBe('after=1')
  })

  it('does not turn a SUCCESSFUL command into a failed one', async () => {
    const command = ['true', 'echo "after=$?"'].join('\n')
    const split = splitBash(command)
    const nonce = createNonce()
    const marked = await bash(instrumentBash(command, split.steps, nonce))

    expect(stripMarkers(marked.stdout, nonce).trim()).toBe('after=0')
  })

  it('would fail if the marker dropped its restore step', async () => {
    // The counterfactual, measured rather than asserted in prose: writing the
    // marker WITHOUT `[ "$__ok" = 0 ] || false` reports success after a failure.
    const withoutRestore = ['false', "__ok=$?; printf '%s\\n' 'MARK'; echo \"after=$?\"", 'echo end'].join('\n')
    const run = await bash(withoutRestore)
    expect(run.stdout).toContain('after=0')
  })
})

describe.skipIf(!available)('the marker stays out of the command\'s own data', () => {
  it('does not leak into a step\'s redirection', async () => {
    // The tool's guidance PROMISES this, so it is pinned here: a step that
    // redirects its own output must receive exactly that output. The marker is a
    // SEPARATE statement, so `echo x > out.txt` writes only `x` while the marker
    // goes to the process's stdout — which is what the host strips.
    const dir = await mkdtemp(join(tmpdir(), 'sp-bash-redirect-'))
    // A RELATIVE target run with `cwd`: bash treats backslashes as escapes, so a
    // `C:\...` path handed to it is mangled into a different (and unwritable)
    // location. The relative name sidesteps path translation entirely.
    const command = 'echo x > out.txt'
    const split = splitBash(command)
    expect(split.safe).toBe(true)

    const nonce = createNonce()
    const marked = await bash(instrumentBash(command, split.steps, nonce), dir)
    expect(markerCount(marked.stdout, nonce)).toBe(1)
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('x\n')
  })
})

describe.skipIf(!available)('the splitter refuses what it cannot decide', () => {
  const REFUSALS: readonly string[] = [
    ['if [ 1 -eq 1 ]; then', '  echo yes', 'fi'].join('\n'),
    ['for n in 1 2 3; do', '  echo $n', 'done'].join('\n'),
    ['cat <<EOF', 'data', 'EOF'].join('\n'),
    ['echo one \\', 'echo two'].join('\n'),
    ['echo "unterminated'].join('\n'),
  ]

  for (const command of REFUSALS) {
    it(`refuses: ${command.split('\n')[0] ?? ''}`, () => {
      const split = splitBash(command)
      expect(split.safe).toBe(false)
      expect(split.reason).toBeTypeOf('string')
    })
  }
})
