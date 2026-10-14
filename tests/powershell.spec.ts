/**
 * The semantics-preservation suite: the ONE test that must not be weakened.
 *
 * It runs a command twice through a real PowerShell — once as written, once
 * with step markers inlined — and asserts that the model would see the same
 * bytes and the same exit status. The failure this catches is silent: a marker
 * refactored into a helper function overwrites `$?`, so an instrumented
 * command reads the wrong value and nothing anywhere reports an error.
 *
 * Skipped when no `pwsh` can be spawned (a sandbox boundary, or a non-Windows
 * host), because a false red here would be worse than a skip.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNonce, instrument, markerPattern, stripMarkers } from '../src/instrument.ts'
import { splitSteps } from '../src/split.ts'
import { resolvePowershell } from './powershell-path.ts'

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The executable the harness's own shell seam would pick on this host. */
const POWERSHELL = resolvePowershell() ?? 'pwsh'

/** Run one command in a fresh shell, exactly as the harness's tool does. */
async function pwsh(command: string, cwd?: string): Promise<Run> {
  return await new Promise<Run>((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
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

const PROBES: readonly Probe[] = [
  {
    name: 'a step that reads $? right after a failed native command',
    command: ['cmd.exe /c exit 3', "if ($?) { 'ok=True' } else { 'ok=False' }"].join('\n'),
  },
  {
    name: '$LASTEXITCODE across steps',
    command: ['cmd.exe /c exit 5', 'Write-Output "exit=$LASTEXITCODE"'].join('\n'),
  },
  {
    name: 'a loop whose body must NOT be instrumented',
    command: [
      '$total = 0',
      'foreach ($n in 1..3) {',
      '  $total += $n',
      '  Write-Output "adding $n"',
      '}',
      'Write-Output "total=$total"',
    ].join('\n'),
  },
  {
    name: 'try/catch and a defined function',
    command: [
      'function Add-One { param($n) $n + 1 }',
      "try { Write-Output (Add-One 41) } catch { Write-Output 'caught' }",
    ].join('\n'),
  },
  {
    name: 'a pipeline across a step boundary',
    command: [
      '$items = "1,2,3"',
      '($items -split ",").Count',
      'Write-Output "1,2,3" | ForEach-Object { $_.Length }',
    ].join('\n'),
  },
  {
    name: 'cd across steps',
    command: ['Set-Location -LiteralPath $env:SystemRoot', 'Write-Output (Split-Path -Leaf (Get-Location))'].join('\n'),
  },
  {
    name: 'a non-zero exit status',
    command: ["Write-Output 'before'", 'exit 7'].join('\n'),
  },
  {
    name: 'braces and hashes inside strings',
    command: [
      'Write-Output "{ not a brace }"',
      'Write-Output "text # not a comment"',
      '$h = @{ a = 1 }',
      'Write-Output $h.a',
    ].join('\n'),
  },
]

/** Count this call's marker lines in a captured stream. */
function markerCount(text: string, nonce: string): number {
  const pattern = markerPattern(nonce)
  return text.split('\n').filter((line) => pattern.test(line.endsWith('\r') ? line.slice(0, -1) : line)).length
}

const probe = await pwsh("Write-Output 'ready'")
const available = probe.stdout.trim() === 'ready'

describe.skipIf(!available)('instrumentation preserves command semantics', () => {
  for (const entry of PROBES) {
    describe(entry.name, () => {
      it('produces byte-identical model-visible output', async () => {
        const nonce = createNonce()
        const steps = splitSteps(entry.command).steps
        const plain = await pwsh(entry.command)
        const marked = await pwsh(instrument(entry.command, steps, nonce))
        expect(stripMarkers(marked.stdout, nonce)).toBe(plain.stdout)
      })

      it('produces the same exit status', async () => {
        const nonce = createNonce()
        const steps = splitSteps(entry.command).steps
        const plain = await pwsh(entry.command)
        const marked = await pwsh(instrument(entry.command, steps, nonce))
        expect(marked.code).toBe(plain.code)
      })

      it('leaks no marker into the model-visible text', async () => {
        const nonce = createNonce()
        const steps = splitSteps(entry.command).steps
        const marked = await pwsh(instrument(entry.command, steps, nonce))
        expect(marked.stdout).toContain('__DSH_STEP_')
        expect(stripMarkers(marked.stdout, nonce)).not.toContain('__DSH_STEP_')
      })

      it('emits exactly one marker per step, so a loop cannot spam the bar', async () => {
        const nonce = createNonce()
        const steps = splitSteps(entry.command).steps
        const marked = await pwsh(instrument(entry.command, steps, nonce))
        expect(markerCount(marked.stdout, nonce)).toBe(steps.length)
      })

      it('adds nothing to stderr', async () => {
        const nonce = createNonce()
        const steps = splitSteps(entry.command).steps
        const plain = await pwsh(entry.command)
        const marked = await pwsh(instrument(entry.command, steps, nonce))
        // The invariant is what INSTRUMENTATION adds, so it is measured against the
        // same command run plain. Asserting an empty stderr instead conflated two
        // different things: a probe whose own command cannot run on this host —
        // `cmd.exe` on Linux, which is exactly where this used to fail — writes to
        // stderr by itself, and that is the host's business, not ours. On Windows
        // `plain.stderr` is empty, so this is the same assertion it always was.
        expect(marked.stderr).toBe(plain.stderr)
        expect(marked.stderr).not.toContain('__DSH_STEP_')
        expect(marked.stderr).not.toContain(nonce)
      })
    })
  }
})

describe.skipIf(!available)('the inlined marker is what makes $? survive', () => {
  it('reads the same $? as the uninstrumented command', async () => {
    const command = ['cmd.exe /c exit 3', "if ($?) { 'ok=True' } else { 'ok=False' }"].join('\n')
    const plain = await pwsh(command)
    expect(plain.stdout.trim()).toBe('ok=False')

    const nonce = createNonce()
    const steps = splitSteps(command).steps
    const marked = await pwsh(instrument(command, steps, nonce))
    expect(stripMarkers(marked.stdout, nonce).trim()).toBe('ok=False')
  })

  it('would fail if the marker were a helper function instead of inlined text', async () => {
    // The counter-example, kept as evidence, and deliberately the MOST
    // plausible refactor: a helper that captures `$?` and "restores" it. It
    // still loses the value, because the restore happens inside the helper's
    // own scope: the caller's `$?` after `Mark-Step …` reports the HELPER's
    // success, not the failed command's.
    const command = [
      "function Mark-Step($ok) { [Console]::Out.WriteLine('step'); if (-not $ok) { $null = Get-Item -LiteralPath '__dsh_absent__' -ErrorAction SilentlyContinue } }",
      'cmd.exe /c exit 3',
      "Mark-Step $?; if ($?) { 'ok=True' } else { 'ok=False' }",
    ].join('\n')
    const shaped = await pwsh(command)
    // The helper's own line is in stdout too, so read the last line.
    expect(shaped.stdout.trim().split('\n').at(-1)).toBe('ok=True')
  })
})

describe.skipIf(!available)('the marker stays out of the command\'s own data', () => {
  it('does not leak into a step\'s redirection', async () => {
    // The tool's guidance PROMISES this, so it is pinned here — on the dialect this
    // host actually runs. The marker is a SEPARATE statement, so `'x' > out.txt`
    // writes only `x` while the marker goes to the process's stdout, which is the
    // stream the host strips.
    const dir = await mkdtemp(join(tmpdir(), 'sp-pwsh-redirect-'))
    const command = "'x' > out.txt"
    const split = splitSteps(command)
    expect(split.safe).toBe(true)

    const nonce = createNonce()
    const marked = await pwsh(instrument(command, split.steps, nonce), dir)
    expect(markerCount(marked.stdout, nonce)).toBe(1)

    // The encoding is the shell's business — 5.1 writes UTF-16LE with a BOM, 7
    // writes UTF-8 — so the file is checked through BOTH decodings rather than
    // assuming one.
    const raw = await readFile(join(dir, 'out.txt'))
    const asUtf16 = raw.toString('utf16le')
    const asUtf8 = raw.toString('utf8')
    expect(asUtf16).not.toContain('__DSH_STEP_')
    expect(asUtf8).not.toContain('__DSH_STEP_')
    expect(`${asUtf16}${asUtf8}`).toContain('x')
  })
})
