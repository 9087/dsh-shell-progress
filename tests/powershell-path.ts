/**
 * Resolve a PowerShell executable the way the harness's own executor does.
 *
 * This is the same candidate order as `@deepseek-ai/dsh-pwsh-local`'s
 * `resolvePwshPath`: the PowerShell 7 install, then `pwsh` on PATH, then the
 * in-box Windows PowerShell. That last one matters — on a Windows host without
 * PowerShell 7 (this one), the shell seam really does run 5.1, so a semantics
 * check that only tried `pwsh` would silently skip the configuration in use.
 *
 * `DSH_PWSH_PATH` overrides everything, matching the executor's `pwshPath`.
 *
 * @module dsh-shell-progress/tests/powershell-path
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Every command name or path to try, in order. */
export function powershellCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const candidates: string[] = []
  if (env.PWSH_PATH !== undefined && env.PWSH_PATH.length > 0) candidates.push(env.PWSH_PATH)
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
