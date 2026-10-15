# Known limits

What this plugin does not do, and what it does not verify. Each entry is either
**accepted** — a deliberate, understood cost — **to fix**, or **closed** — a gap
a test now covers, kept here with the test that closed it. Nothing here is
softened: an unverified entry says so.

1. A FAILED grammar load is cached and never retried. **closed — covered by a test**
   - Evidence: `tests/bashtree.spec.ts` replaces the loader with vitest's module
     mocking (`vi.doMock('web-tree-sitter', …)`), resets the module registry
     (`vi.resetModules()`) so each case builds a FRESH module — and therefore a
     fresh `parserPromise` slot — and then drives a command only the parser can
     answer. A first call whose mocked `Parser.init()` throws yields `undefined`
     (the safe refusal); a SECOND call also yields `undefined` while the mocked
     `init` call count stays at **1**. A second case fails the load at
     `Language.load` instead and asserts the same stickiness there (`init` once,
     `load` once, across two calls). `src/bashtree.ts`'s module header now lists
     the realistic failure modes this cache exists for.

2. The `parseTree` null/throw branch in `src/bashtree.ts`. **closed — covered by a test**
   - Evidence: `tests/bashtree.spec.ts` hands the planner a mocked parser whose
     `parse` returns `null` (one case) and one that throws (another), and asserts
     both calls RETURN `undefined` — never a throw into the tool path — while the
     mock's `parse` counter proves the branch was entered rather than skipped.

3. tree-sitter's bash grammar accepts a few constructs real bash rejects (a bare
   `}`; a stray `fi`/`done`/`esac`) with `hasError === false`, so the planner
   instruments a command a real interpreter will refuse. A marker is a separate
   statement, so such a command still fails identically. **closed — covered by a
   test**
   - Evidence: `tests/bash.spec.ts` runs both shapes against a real bash,
     instrumented and plain, and compares them. Measured, and stated exactly:
     the exit status and the marker-stripped stdout are byte-identical, and the
     stderr differs in ONE place only — bash names the line it choked on and
     ECHOES that source line, and that line now carries the inlined marker. The
     test removes the inlined marker from the echo and requires the plain stderr
     back byte for byte, so the difference cannot grow unnoticed.
   - `echo >` with no redirection target was the other construct this entry used
     to name, and the vendored grammar does NOT accept it: tree-sitter reports an
     ERROR, the planner REFUSES the command, and it runs unmodified — so its
     bytes are identical to the plain command's by construction. The test pins
     that refusal, and additionally forces a marker onto the command from the
     heuristic (the shape a dialect without a planner would produce) to show that
     even then it fails the same way.
   - Residual, accepted: for a syntax-error command, the marker text can therefore
     appear inside the echoed line of the model-visible stderr. The failure, its
     exit status and its stdout are unchanged; what changes is one echoed source
     line.

4. The pwsh probe resolves the interpreter through the shared candidate order
   (`src/pwsh-path.ts`), not through the executor's private `pwshPath` config,
   which the seam does not expose. A host configured with an unusual explicit
   interpreter path could probe a different one than it executes. **accepted**
   - Evidence: `resolvePwsh()` implements install → PATH → in-box order and
     honours `DSH_PWSH_PATH`, so a host with a custom interpreter path can point
     the probe at the SAME interpreter it executes by setting that variable.
     What remains is only that nothing reads the executor's own configuration:
     this entry closes if the shell seam ever exposes the interpreter.

5. `EndBlock.Statements` only: a leading `param(...)`/`#requires` is not a step
   line. **accepted**
   - Evidence: the pwsh planner reads the script's `EndBlock.Statements`; a
     `param(...)` block or a `#requires` comment is not one of them, so it is
     not a step.

6. An instrumented multi-line PowerShell command costs one extra short-lived
   process (~78–96 ms measured on this host; ~0.085 ms of it is the parse
   itself). **accepted**
   - Evidence: measured on this host. The extra process is the probe that
     resolves the interpreter and asks the parser for the statement list; the
     parse is a rounding error inside it.

7. `cordis` materialised in a consumer profile: `@deepseek-ai/cordis` was a
   NON-optional peer, so pnpm's default `auto-install-peers` installed it — and
   its `cosmokit` dependency — into the profile root, where a physical copy can
   shadow the host's own framework instance. **fixed in this change**
   - The change: `@deepseek-ai/cordis` is now `"optional": true` in
     `peerDependenciesMeta`. The declared RANGE (`>=4.0.1`) is untouched, because
     it is the compatibility statement and a host still has to satisfy it;
     `optional` only stops the auto-INSTALL. `react` is left as it was.
   - Evidence, measured with pnpm 11.22.0: the packed tarball was unpacked twice,
     differing ONLY in that flag, and each copy was installed as a `file:`
     dependency into a throwaway and otherwise empty consumer root with a
     hoisted linker (`--config.node-linker=hoisted`, `auto-install-peers` at its
     default `true`). With the flag ABSENT the root gained
     `node_modules/@deepseek-ai/{cordis,cosmokit}` (53 packages installed); with
     the flag present no `@deepseek-ai` directory exists at all (50 packages), so
     cordis, cosmokit and the four already-optional harness services are all
     absent. The plugin itself installed and resolved in both runs, so the
     difference is the peer flag and nothing else.
   - `pnpm install` reports "Already up to date" and rewrites nothing:
     `pnpm-lock.yaml`'s importer section records a project's dependencies and
     devDependencies, not its own `peerDependenciesMeta`, so there is no lockfile
     fact for this change to carry. No external fact is outstanding — a
     consumer's `auto-install-peers` setting cannot re-add it, because optional
     peers are not auto-installed under any value of that setting.

8. There is no cross-host-version smoke test yet. **closed — the job has run green**
   - Evidence: before this change, no workflow in `.github/workflows/` ran a
     smoke suite against a harness version other than the pinned devDeps. This
     change adds that job (`.github/workflows/harness-matrix.yml`), and the
     release it shipped in is the first CI run to execute it: both entries are
     green on commit `96b5316` — `smoke (0.2.0-rc.2, true)`, the BLOCKING set
     (check run 116585960444), and `smoke (0.2.1-alpha.3, false)`, the
     non-blocking probe (116585959830). The gate earned its keep getting there:
     the run that first reached it found a real POSIX defect (entry 11).
   - Operational note: the job's BLOCKING set currently holds one entry,
     `0.2.0-rc.2`, because it is the only published version inside the declared
     peer range (`^0.2.0-rc.2`). The newest published version rides beside it as
     a non-blocking probe. So whenever the peer range widens or the pinned
     harness is bumped, a version MUST be added to the blocking set in the same
     change — otherwise the gate keeps running, keeps passing, and silently stops
     testing anything.

9. `import.meta.dirname` requires Node ≥ 20.11, which `package.json`'s
   `engines.node` now declares (`"node": ">=20.11"`). **accepted**
   - Evidence: `src/bashtree.ts` resolves the vendored `.wasm` through
     `import.meta.dirname`, with `fileURLToPath(new URL('.', import.meta.url))`
     as the fallback for a runtime that lacks it. `engines` is the declaration
     of that floor; the fallback is what a Node 20.0–20.10 runtime would take.

10. The pwsh parse probe is NOT skipped for a brace-free multi-line command.
    **accepted — measured, and the shortcut is rejected**
    - Considered: with no brace outside quotes a block is impossible, so every
      non-blank column-0 line in such a command looked like a provably top-level
      statement, and the probe (entry 6, ~80 ms) could be skipped for that class.
    - Measured, and the premise is false: a line can CONTINUE into the next one
      with no brace at all. For `echo a |` + newline + `cat`, `splitSteps`
      answers `[{"line":1,"text":"echo a |"},{"line":2,"text":"cat"}]` with
      `safe: true` — TWO trusted steps — while the same text given to the real
      parser (`planPwshSteps`) answers ONE step, line 1. A pipeline split across
      lines is one statement to PowerShell. `1 +` / `2` reproduces the same
      disagreement; a trailing `&&` or `||` is mis-split by the heuristic too
      (PowerShell then reports those as syntax errors, so the planner refuses).
    - Therefore rejected: a "fast path" would skip the probe exactly where the
      heuristic is provably wrong, and put the heuristic back into the
      INSTRUMENTATION path — two markers inside one pipeline statement, which is
      the corruption the probe exists to prevent. Today the parser gets the
      pipeline right, and a multi-step heuristic answer is never instrumented.
    - Mitigation already in place: for a dialect that has a planner
      (`pwsh` and `bash` both declare `plan`), a command with more than one
      heuristically-safe step is planned, and an unavailable plan REFUSES
      (`resolveSplit` in `src/index.ts`), so the command runs unmodified rather
      than instrumented. The heuristic's mis-splits can therefore only ever be
      display data, never a marker.
    - Reproduce:
      ```
      node --experimental-transform-types --input-type=module -e "const {splitSteps} = await import('./src/split.ts'); console.log(JSON.stringify(splitSteps(['echo a |','cat'].join('\n'))))"
      ```

11. The PowerShell candidate list was WINDOWS-ONLY, so on a POSIX host the pwsh
    planner never resolved a shell and every multi-step command was REFUSED — the
    instrumented path did not exist there at all. **closed — covered by a test**
    - Found by the first tag-triggered CI run (Release run 38781014702): it failed
      at `pnpm test` on `ubuntu-latest` while the same suite was green on Windows,
      in `tests/pwshtree.spec.ts` — `instrumented` was `false` where a plan was
      expected, and a refusal's step list was empty (`expected 0 to be greater
      than 1`). The refusal-path tests in that same file passed on Linux for
      exactly that reason, which is what pointed at the resolver rather than at
      the planner.
    - The cause: `src/pwsh-path.ts` split `PATH` on `;`, appended `pwsh.exe`,
      probed `C:\Program Files\PowerShell\7` and fell back to the in-box
      `powershell.exe`. On Linux `PATH` is `:`-separated, so the whole variable
      became ONE candidate and every probe missed; `resolvePowershell()` answered
      `undefined`, which `resolveSplit` turns into a refusal — by design, and
      therefore SILENT: the card simply showed no bar.
    - The fix: the list is built for a PLATFORM (now a parameter) using
      `path.win32`/`path.posix`, `pwsh.exe` versus `pwsh`, `;` versus `:`, and the
      POSIX install locations plus a bare `pwsh` as the last candidate. The
      Windows order is unchanged.
    - Evidence: `tests/pwsh-path.spec.ts` asserts both lists on either host and
      spawns nothing, so it runs on Windows and on the Linux runner that found
      this. The Windows side is measured green here (`pnpm test`, 19 files / 305
      tests, plus the e2e). The Linux side is what the CI run for this fix
      verifies, and it is NOT claimed before that run is green.
