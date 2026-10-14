/**
 * Where the real bash is, for the semantics tests that need one.
 *
 * `bash` on PATH is NOT good enough on Windows: `C:\WINDOWS\system32\bash.exe` is
 * the WSL launcher, which runs the command inside a different filesystem namespace
 * and can print its own startup diagnostics on the same stream the test is
 * comparing — turning an output-equality assertion into a coin flip. Git for
 * Windows ships a real MSYS2 bash, and that is what this resolves first.
 *
 * `DSH_BASH_PATH` overrides everything, the way `DSH_PWSH_PATH` does for the
 * PowerShell half.
 *
 * @module dsh-shell-progress/tests/bash-path
 */

import { existsSync } from 'node:fs'

/** Candidate interpreters, most preferred first. */
const CANDIDATES: readonly string[] = [
  ...process.env.DSH_BASH_PATH === undefined ? [] : [process.env.DSH_BASH_PATH],
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`,
  '/bin/bash',
  '/usr/bin/bash',
]

/** Resolvers to avoid: the WSL launcher masquerades as `bash`. */
const REJECTED = /[\\/]system32[\\/]bash\.exe$/i

/**
 * Resolve a bash that behaves like the one a POSIX host would give the executor.
 * @returns the interpreter's path, or undefined when this host has none.
 */
export function resolveBash(): string | undefined {
  for (const candidate of CANDIDATES) {
    if (candidate === '' || REJECTED.test(candidate)) continue
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
