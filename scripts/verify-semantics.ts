/**
 * Standalone semantics check: run a command plain and instrumented through a
 * real PowerShell and compare what the model would see.
 *
 * This exists because the same check inside `tests/powershell.spec.ts` cannot
 * spawn a child process from inside the test runner under this sandbox, while a
 * plain `node` process can. Run it with:
 *
 *   node scripts/verify-semantics.ts
 *
 * Exits non-zero on the first mismatch.
 */

import { execFile } from 'node:child_process'
import { createNonce, instrument, markerPattern, stripMarkers } from '../src/instrument.ts'
import { splitSteps } from '../src/split.ts'
import { resolvePowershell } from '../tests/powershell-path.ts'

const PWSH = resolvePowershell() ?? 'pwsh'

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function pwsh(command: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      PWSH,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error !== null && (error as { code?: unknown }).code === undefined) {
          reject(error)
          return
        }
        const code = error === null ? 0 : (error as { code: number }).code
        resolve({ code, stdout, stderr })
      },
    )
  })
}

const PROBES: readonly { name: string; command: string }[] = [
  {
    name: '$? after a failed native command',
    command: ['cmd.exe /c exit 3', "if ($?) { 'ok=True' } else { 'ok=False' }"].join('\n'),
  },
  {
    name: '$LASTEXITCODE across steps',
    command: ['cmd.exe /c exit 5', 'Write-Output "exit=$LASTEXITCODE"'].join('\n'),
  },
  {
    name: 'loop body (must NOT be instrumented)',
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
    name: 'try/catch and a function',
    command: [
      'function Add-One { param($n) $n + 1 }',
      "try { Write-Output (Add-One 41) } catch { Write-Output 'caught' }",
    ].join('\n'),
  },
  {
    name: 'pipeline across steps',
    command: ['$items = "1,2,3"', '($items -split ",").Count', 'Write-Output "1,2,3" | ForEach-Object { $_.Length }'].join('\n'),
  },
  {
    name: 'cd across steps',
    command: ['Set-Location -LiteralPath $env:SystemRoot', 'Write-Output (Split-Path -Leaf (Get-Location))'].join('\n'),
  },
  {
    name: 'non-zero exit',
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

function markerCount(text: string, nonce: string): number {
  const pattern = markerPattern(nonce)
  return text.split('\n').filter((line) => pattern.test(line.endsWith('\r') ? line.slice(0, -1) : line)).length
}

let failures = 0

const ready = await pwsh("Write-Output 'ready'").catch(() => undefined)
if (ready === undefined || ready.stdout.trim() !== 'ready') {
  console.error(`could not run ${PWSH}: set PWSH_PATH to an absolute pwsh executable`)
  process.exit(2)
}

for (const entry of PROBES) {
  const nonce = createNonce()
  const steps = splitSteps(entry.command).steps
  const plain = await pwsh(entry.command)
  const marked = await pwsh(instrument(entry.command, steps, nonce))
  const visible = stripMarkers(marked.stdout, nonce)
  const markers = markerCount(marked.stdout, nonce)
  const checks: readonly [string, boolean, string][] = [
    ['output identical', visible === plain.stdout, `plain=${JSON.stringify(plain.stdout)} marked=${JSON.stringify(visible)}`],
    ['exit code identical', marked.code === plain.code, `plain=${plain.code} marked=${marked.code}`],
    ['no marker leaked', !visible.includes('__DSH_STEP_'), visible],
    ['one marker per step', markers === steps.length, `steps=${steps.length} markers=${markers}`],
    ['stderr empty', marked.stderr.trim() === '', JSON.stringify(marked.stderr)],
  ]
  const bad = checks.filter(([, ok]) => !ok)
  if (bad.length > 0) failures += 1
  const status = bad.length === 0 ? 'ok  ' : 'FAIL'
  console.log(`${status} ${entry.name}  (${steps.length} steps, ${markers} markers, exit ${plain.code}/${marked.code})`)
  for (const [label, , detail] of bad) console.log(`       ${label}: ${detail}`)
}

console.log(failures === 0 ? '\nall probes preserved command semantics' : `\n${failures} probe(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
