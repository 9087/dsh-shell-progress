/**
 * Finding the PowerShell this host would actually run.
 *
 * The host's executor seam cannot answer "which shell is this?" (see
 * `./dialect.ts`), so the candidate order is the one
 * `@deepseek-ai/dsh-pwsh-local`'s `resolvePwshPath` uses: the PowerShell 7
 * install, then `pwsh` on PATH, then the in-box Windows PowerShell. That last
 * one matters — on a Windows host without PowerShell 7 (this one), the shell
 * seam really does run 5.1, so anything that spawns a shell of its own has to
 * reach the same binary or its answer describes a different interpreter.
 *
 * `DSH_PWSH_PATH` (and the older `PWSH_PATH`) overrides everything, matching
 * the executor's `pwshPath`.
 *
 * This lives in `src/` rather than in the test tree because the parse-based
 * planner (`./pwshtree.ts`) spawns the shell too. `tests/powershell-path.ts`
 * re-exports it, so the semantics suite and `scripts/verify-semantics.ts` keep
 * resolving the shell exactly as they did.
 *
 * @module dsh-shell-progress/pwsh-path
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Every command name or path to try, in order. */
export function powershellCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const candidates: string[] = []
  for (const name of ['DSH_PWSH_PATH', 'PWSH_PATH'] as const) {
    const configured = env[name]
    if (configured !== undefined && configured.length > 0) candidates.push(configured)
  }
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  candidates.push(join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(join(trimmed, 'pwsh.exe'))
  }
  candidates.push(join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return candidates
}

/**
 * The first candidate that exists on disk.
 * @param env - environment to probe; defaults to the process environment.
 * @returns the executable path, or undefined when none exists.
 */
export function resolvePowershell(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const candidate of powershellCandidates(env)) {
    // A bare command name has no path to test; try it and let the spawn decide.
    if (!candidate.includes('\\') && !candidate.includes('/')) return candidate
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
