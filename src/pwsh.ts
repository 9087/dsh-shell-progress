/**
 * The PowerShell dialect: this plugin's original and, on Windows, its default.
 *
 * This file is intentionally thin. It COMPOSES the existing PowerShell modules
 * rather than absorbing them: `./split.ts` and `./instrument.ts` keep their paths,
 * their exports and their tests, and the 42 real-shell semantics tests in
 * `tests/powershell.spec.ts` therefore keep guarding this path unchanged. The
 * dialect layer's job is to name the seam, not to relocate the code behind it.
 *
 * @module dsh-shell-progress/pwsh
 */

import type { ShellDialect } from './dialect.ts'
import { RESERVED_VARIABLE, instrument, looksInstrumented } from './instrument.ts'
import { splitSteps } from './split.ts'

/** The PowerShell dialect. */
export const pwshDialect: ShellDialect = {
  id: 'pwsh',
  toolName: 'shell_progress_pwsh',
  description: 'Execute a multi-line PowerShell command (`pwsh -Command`) and return its stdout/stderr, with a per-step progress bar in the UI. Prefer this over `pwsh` whenever the command has more than one line: it runs the same shell through the same executor and returns identical output and exit markers, so nothing is lost. Use `pwsh` for single-line commands, and for `run_in_background`, which this tool does not implement. Each call runs a fresh pwsh process; pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment variables with `$env:NAME`. Not for commands whose raw stdout must be byte-exact or empty: each step writes one short marker line to the process\'s stdout, stripped from the output you receive but genuinely written.',
  commandParamDescription: 'The PowerShell command to execute. Multi-line commands show one progress segment per top-level step.',
  guidance: 'Multi-line PowerShell commands: prefer `shell_progress_pwsh` over `pwsh`. It runs the same PowerShell through the same executor and returns identical output and exit markers, and it additionally shows the user a per-step progress bar. Use `pwsh` for single-line commands, and when `run_in_background` is needed. Do NOT use it when the command\'s own stdout must be byte-exact or empty: marking each step costs one short extra line written to the process\'s stdout, stripped from the text you receive but genuinely written, so a command that streams a protocol or binary payload, whose output is checksummed or signed, or that must print nothing at all belongs on `pwsh` instead. Redirection INSIDE a step (`foo > out.txt`) and pipes are unaffected — the marker is a separate statement, not part of your pipeline — and stdin is never touched.',
  reservedVariable: RESERVED_VARIABLE,
  split: splitSteps,
  instrument,
}

/** Re-exported so nothing else has to know the PowerShell marker lives in `./instrument.ts`. */
export { looksInstrumented }
