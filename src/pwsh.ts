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
  description: 'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr, rendered as a step list — per-step duration and collapsible per-step output — with a progress bar while it runs. PREFER THIS over `pwsh` for every command: it runs the same shell through the same executor and returns identical output and exit markers, so nothing is lost by using it. `pwsh` is for two cases only: (1) the command\'s raw stdout must be byte-exact — a protocol, binary or checksummed payload — because each step writes one short marker line to the process\'s stdout, stripped from the output you receive but genuinely written; (2) `run_in_background`, which this tool does not implement. A command the splitter cannot handle safely still runs, unmodified, and the card says so. Each call runs a fresh pwsh process; pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment variables with `$env:NAME`.',
  commandParamDescription: 'The PowerShell command to execute. Top-level statements become progress segments.',
  guidance: 'PowerShell: use `shell_progress_pwsh` for your commands, not `pwsh`. It runs the same PowerShell through the same executor, returns identical output and exit markers, and additionally renders the call as a step list with per-step timing and output. `pwsh` is for two cases only: (1) the command\'s raw stdout must be byte-exact — a protocol, binary or checksummed payload — since each step writes one short marker line to the process\'s stdout, stripped from the text you receive but genuinely written; (2) the command must run in the background, which this tool does not offer. Everything else — one statement or twenty, fast or slow — belongs on `shell_progress_pwsh`; a command it cannot split safely runs unmodified rather than failing. Redirection inside a step (`foo > out.txt`), pipes and stdin are unaffected: the marker is a separate statement, not part of your pipeline.',
  reservedVariable: RESERVED_VARIABLE,
  split: splitSteps,
  instrument,
}

/** Re-exported so nothing else has to know the PowerShell marker lives in `./instrument.ts`. */
export { looksInstrumented }
