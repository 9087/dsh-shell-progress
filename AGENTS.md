# Agent notes

Conventions this repository depends on. Each one is here because breaking it
costs something that a green build will not catch.

## Never terminate a process you did not start

Do not run `Stop-Process`, `taskkill`, `kill`, or any equivalent against a
process this session did not start. `Stop-Process -Name node` is forbidden
outright — the DSH host is a `node` process, and killing it kills the session
that is running the command. If a command of your own hangs, cancel its job
with `job_kill`, which terminates the tree that job started and nothing else.

## Run the suite once at a time

Two overlapping `vitest run`s in one worktree produce flakes. Run the tests when
nothing else is building or testing.

## Write source files with the edit tools

Change a source file with the `edit`/`write` tools. A round trip through
`Get-Content`/`Set-Content`, `Out-File`, `>` or `-replace` re-encodes the file —
that is how a UTF-8 file ends up with `?` where an em dash was, and how a
newline gets glued onto the wrong line.

## The two invariants

1. **The step marker stays inlined.** `src/instrument.ts` explains why. The
   short form: a helper function that writes the marker becomes the command that
   sets `$?`, so the instrumented command silently reads a different value than
   the plain one. `tests/powershell.spec.ts` runs both shapes against a real
   shell and asserts the difference — if that test ever needs "fixing" to pass,
   the marker was refactored, and the fix belongs in `src/instrument.ts`.

2. **The client bundle stays pure.** `build/tsdown.client.ts` fails the build on
   any `@deepseek-ai/*` VALUE import that is not a platform module
   (`build/platform.ts`), an inline-safe wire layer, or a generated `/remote`
   contribution. Cross-plugin collaboration goes through cordis services.
   Type-only imports are erased and always fine.

## Where the facts came from

`build/platform.ts` is the shell's frozen module table, read back out of the
deployed `@deepseek-ai/dsh-web-frontend` bundle. If the shell's table changes,
that file must change with it: marking a package external that the table cannot
answer is a guaranteed runtime throw, and inlining one the table does answer
duplicates its module identity.

## Tests that talk to a real shell

`tests/powershell.spec.ts` and `scripts/verify-semantics.ts` resolve the shell
the way `@deepseek-ai/dsh-pwsh-local` does (PowerShell 7 install → `pwsh` on
PATH → in-box Windows PowerShell), because on a host without PowerShell 7 the
seam really does run 5.1. `DSH_PWSH_PATH` overrides the search. When no shell
can be spawned the suite reports skips, not failures.
