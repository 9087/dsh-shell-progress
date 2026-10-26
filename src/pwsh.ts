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
import { planPwshSteps } from './pwshtree.ts'
import { splitSteps } from './split.ts'

/** The PowerShell dialect. */
export const pwshDialect: ShellDialect = {
  id: 'pwsh',
  toolName: 'shell_progress_pwsh',
  description: 'The tool is named `shell_progress_pwsh`: it executes a PowerShell command (`pwsh -Command`) and returns its stdout/stderr. It IS the `pwsh` tool underneath: the same executor, the same sandbox mode and the same sandbox rules apply, and the model-visible stdout, stderr and exit status are byte-identical — nothing about the command, its environment or its result changes. The one difference is what the USER sees: this tool normally renders the call as a numbered step list — a progress bar while it runs, per-step duration and collapsible per-step output — where `pwsh` shows one opaque block. Prefer this tool for every command for that reason, exploration included: listings, greps, file reads and one-liners alike. Use `pwsh` in only one case: something OTHER than you consumes the raw stdout byte-exactly — a protocol, a binary or a checksummed payload — because each step writes one short marker line to the process\'s stdout, stripped from the text you receive but genuinely written. A long command is NOT a reason to leave: pass `run_in_background: true` and this tool starts a real background job (collect with `job_output`, stop with `job_kill`, no timeout applies), running the command unmodified so its output is exact — the card then shows the command\'s statements without per-step data, because the command outlives the call that started it. Step boundaries come from PowerShell\'s own parser: a command it cannot plan still runs unmodified, and the card says so. Each call runs a fresh pwsh process; pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment variables with `$env:NAME`.',
  commandParamDescription: 'The PowerShell command to execute. Top-level statements become progress segments.',
  guidance: 'PowerShell: DEFAULT to `shell_progress_pwsh` for your commands, exploration included — listings, greps, `Get-Content` slices and one-liners all belong here. It is the same tool with a better user experience: underneath it is the same executor as `pwsh`, the same sandbox mode and the same sandbox rules, and the stdout, stderr and exit status you receive are byte-identical. The difference is what the user sees — a numbered step list, a progress bar while it runs, per-step duration and per-step output — where `pwsh` shows one opaque block. Use `pwsh` in only one case, and for no other reason: something OTHER than you consumes the raw stdout byte-exactly — a protocol, a binary or a checksummed payload — since each step writes one short marker line to the process\'s stdout, stripped from the text you receive but genuinely written. For a long command use `run_in_background: true` here instead of leaving: it starts a real job (collect with `job_output`, stop with `job_kill`), runs the command unmodified so its output is exact, and the card then shows its statements without per-step data. Step boundaries come from PowerShell\'s own parser, so a command it cannot plan runs unmodified rather than failing, because a guessed boundary could corrupt the command. Redirection inside a step (`foo > out.txt`), pipes and stdin are unaffected: the marker is a separate statement, not part of your pipeline. PREFER ONE STATEMENT PER LINE: a `;` chain on a single line is split into one step per top-level `;` (never inside quotes, `&&`/`||`, pipes, `()` or `{}`), so a one-liner still gets real per-step segments; a `;` inside a quoted string or a comment is never a boundary.',
  reservedVariable: RESERVED_VARIABLE,
  split: splitSteps,
  // The authoritative half: PowerShell's own parser answers "where does each
  // top-level statement start?", so a clause that continues a statement
  // (`else {`, `catch {`, a `do` block's trailing `while (...)`) is no longer
  // mistaken for a new step. Undefined leaves `split` in charge.
  plan: planPwshSteps,
  instrument,
}

/** Re-exported so nothing else has to know the PowerShell marker lives in `./instrument.ts`. */
export { looksInstrumented }
