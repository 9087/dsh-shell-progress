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
 * ## The list is built for a PLATFORM, not for this process
 *
 * `win32` and POSIX differ in three ways, and getting any of them wrong makes
 * `resolvePowershell()` answer `undefined` — a failure that is silent by design,
 * because an unavailable plan is a REFUSAL: the plugin then instruments nothing
 * and refuses every multi-step command. It was found exactly that way. The
 * tag-triggered CI run failed on `ubuntu-latest` at `pnpm test` (run
 * 38781014702, `tests/pwshtree.spec.ts`) while the same suite was green on
 * Windows, because this function was Windows-only:
 *
 * - the executable is `pwsh.exe` there and `pwsh` elsewhere;
 * - `PATH` is separated by `;` there and `:` elsewhere, so a POSIX `PATH` split
 *   on `;` became ONE path and every candidate missed;
 * - the fallbacks are drive-letter install locations versus the ones `pwsh` is
 *   installed to on Linux and macOS.
 *
 * So the paths are built with `path.win32` or `path.posix` to MATCH the platform
 * being asked about, and the platform is a parameter. That is also what makes the
 * behaviour testable off Windows: `tests/pwsh-path.spec.ts` asserts both lists on
 * either host, without spawning anything.
 *
 * This lives in `src/` rather than in the test tree because the parse-based
 * planner (`./pwshtree.ts`) spawns the shell too. `tests/powershell-path.ts`
 * re-exports it, so the semantics suite and `scripts/verify-semantics.ts` keep
 * resolving the shell exactly as they did.
 *
 * @module dsh-shell-progress/pwsh-path
 */

import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * Every command name or path to try, in order.
 * @param env - environment to read the overrides and `PATH` from.
 * @param platform - the platform to build the list for; defaults to this process's.
 * @returns the candidates, in the order they must be tried.
 */
export function powershellCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const windows = platform === 'win32'
  const paths = windows ? win32 : posix
  const candidates: string[] = []
  for (const name of ['DSH_PWSH_PATH', 'PWSH_PATH'] as const) {
    const configured = env[name]
    if (configured !== undefined && configured.length > 0) candidates.push(configured)
  }
  if (windows) {
    // PowerShell 7's default install location. `pwsh` on PATH is tried next.
    candidates.push(paths.join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'))
  }
  const executable = windows ? 'pwsh.exe' : 'pwsh'
  for (const entry of (env.PATH ?? '').split(windows ? ';' : ':')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(paths.join(trimmed, executable))
  }
  if (windows) {
    candidates.push(paths.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  } else {
    // Where the .deb/.rpm package, the tarball and the snap put it — then the bare name,
    // which has no path to test and is returned so the SPAWN resolves it through PATH.
    candidates.push('/opt/microsoft/powershell/7/pwsh', '/usr/bin/pwsh', '/usr/local/bin/pwsh', '/snap/bin/pwsh', 'pwsh')
  }
  return candidates
}

/**
 * The first candidate that exists on disk.
 * @param env - environment to probe; defaults to the process environment.
 * @param platform - the platform whose candidates to walk; defaults to this process's.
 * @returns the executable path, or undefined when none exists.
 */
export function resolvePowershell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  for (const candidate of powershellCandidates(env, platform)) {
    // A bare command name has no path to test; try it and let the spawn decide.
    if (!candidate.includes('\\') && !candidate.includes('/')) return candidate
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
