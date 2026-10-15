/**
 * The shell-dialect seam: everything that differs between the shells this plugin
 * can drive, behind one interface.
 *
 * The seam exists because the host's own executor seam CANNOT answer the question
 * "which shell is this?". `ShellExecRequest`/`ShellExecSpec` carry command,
 * workdir, timeout, env and sandbox policy — and no executable, no argv and no
 * dialect tag. `ctx.shell` is described as "abstract bash execution service", so
 * PowerShell is merely one IMPLEMENTATION of it, and a plugin asking it what it is
 * gets nothing back.
 *
 * So a tool declares its dialect statically, which is also how DSH itself is laid
 * out: `dsh-tool-pwsh` ("Model-facing pwsh tool over the bash executor seam") and
 * `dsh-tool-bash` are separate model-facing tools over one seam.
 *
 * Only four things are dialect-specific. Everything else — the marker format, the
 * line feeder, the step tracker, the polling loop, the RPC channel, the live
 * registry, the model-visible rendering and the ENTIRE client — is shared and has
 * no idea a second dialect exists.
 *
 * @module dsh-shell-progress/dialect
 */

import type { SplitResult, Step } from './split.ts'

/** One shell this plugin can instrument. */
export interface ShellDialect {
  /** Stable id, used in messages and diagnostics. */
  readonly id: 'pwsh' | 'bash'
  /** The wire tool name. Also the client slot key, so it is never renamed casually. */
  readonly toolName: string
  /** The tool description the model reads. */
  readonly description: string
  /** The tool's `command` parameter description. */
  readonly commandParamDescription: string
  /** The systemPrompt guidance block for this dialect. */
  readonly guidance: string
  /**
   * The variable this dialect's inlined marker borrows, or undefined when it
   * borrows none. A command already using the name is refused rather than risk
   * overwriting the caller's value.
   */
  readonly reservedVariable?: string
  /**
   * Split a command into its top-level steps.
   * @param command - the model's command text.
   * @returns the steps found and whether instrumentation may proceed.
   */
  split(command: string): SplitResult
  /**
   * An AUTHORITATIVE plan for this command, when the dialect has a real parser
   * to ask — asynchronous, because for PowerShell it means running a probe in
   * the shell that will execute the command.
   *
   * `split` stays synchronous and stays the fallback: a dialect that cannot
   * plan, or whose plan cannot be produced (no shell, timeout, unparseable
   * probe output), simply leaves `undefined` here and the heuristic answers.
   * A dialect without a parser omits the member entirely, so the bash side is
   * untouched.
   * @param command - the model's command text.
   * @returns the authoritative result, or undefined for "use `split`".
   */
  plan?(command: string): Promise<SplitResult | undefined>
  /**
   * Rewrite a command so each step announces itself before it runs.
   *
   * The rewrite must keep the line count, and it must not change what the command
   * does or what it exits with. See each implementation for the invariant it has
   * to satisfy; `tests/powershell.spec.ts` measures it against a real shell.
   * @param command - the original command text.
   * @param steps - the steps to mark.
   * @param nonce - this call's nonce.
   * @returns the instrumented command text.
   */
  instrument(command: string, steps: readonly Step[], nonce: string): string
}
