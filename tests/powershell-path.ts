/**
 * Resolve a PowerShell executable the way the harness's own executor does.
 *
 * The candidate order lives in `src/pwsh-path.ts` because the parse-based
 * planner spawns the same shell; this module is the test tree's entry point to
 * it, so the semantics suite and `scripts/verify-semantics.ts` keep importing
 * from the path they always did.
 *
 * The order is the same candidate order as `@deepseek-ai/dsh-pwsh-local`'s
 * `resolvePwshPath`: the PowerShell 7 install, then `pwsh` on PATH, then the
 * in-box Windows PowerShell. That last one matters — on a Windows host without
 * PowerShell 7 (this one), the shell seam really does run 5.1, so a semantics
 * check that only tried `pwsh` would silently skip the configuration in use.
 *
 * `DSH_PWSH_PATH` (and the older `PWSH_PATH`) overrides everything, matching
 * the executor's `pwshPath`.
 *
 * @module dsh-shell-progress/tests/powershell-path
 */

export { powershellCandidates, resolvePowershell } from '../src/pwsh-path.ts'
