/**
 * Background jobs: the shell adapter the `pwsh` tool uses, re-stated for a plugin that
 * cannot import it.
 *
 * `@deepseek-ai/dsh-tool-pwsh` adapts a shell process to `ctx.jobs` with three local
 * helpers — its pull sources, its job hooks and its outcome vocabulary — and exports
 * none of them. A plugin installed outside the DSH tree therefore has to speak the same
 * protocol itself, and this module is that: no policy lives here, only the shapes the
 * job registry already understands, so `job_output`, `job_list` and `job_kill` work on
 * a command this plugin started exactly as they work on one the shell tool started.
 *
 * The shape that matters: a job is admitted SYNCHRONOUSLY, before anything is spawned,
 * and its `run()` returns hooks whose `done` starts the process with the job's own abort
 * signal. Output is handed over as non-consuming pull sources, so the job's own readers
 * never eat the bytes a foreground read would have seen.
 *
 * @module dsh-shell-progress/background
 */

import type { ShellExecution } from '@deepseek-ai/dsh-shell'

/** One non-consuming stream reader, as the registry pulls it. */
export interface JobOutputSource {
  /** Which captured stream this source reads. */
  readonly channel: 'stdout' | 'stderr'
  /**
   * Read what this stream has above `fromByte`.
   * @param fromByte - the registry's own cursor, in bytes.
   * @returns the text since that offset, the next offset, and whether bytes were lost.
   */
  read(fromByte: number): { readonly text: string; readonly nextOffset: number; readonly lossy: boolean }
}

/** What the registry records once the process settles. */
export interface JobOutcome {
  /** `failed` is the registry's word for "the caller's own machinery threw". */
  readonly status: 'completed' | 'killed' | 'failed'
  /** One line of detail — the exit code, or why it never got one. */
  readonly detail: string
}

/** One job as the registry admits it. */
export interface BackgroundJob {
  /** Registry row kind, shown by `job_list`. */
  readonly kind: string
  /** One-line label for the roster; the command itself. */
  readonly label: string
  /** The agent that owns the job, when the call had one. */
  readonly owner?: string
  /** Non-consuming readers over the process's captured streams, stdout first. */
  readonly output: readonly JobOutputSource[]
  /**
   * Start the process and report its settlement.
   *
   * Called ONCE, synchronously, by the registry after admission; the spawn itself may be
   * asynchronous and belongs inside `done`.
   * @returns the job's completion, and the way to stop it.
   */
  run(): {
    readonly done: Promise<JobOutcome>
    readonly cancel: (reason: string) => void
  }
}

/** The slice of the host's job registry this plugin mounts a background command with. */
export interface JobRegistryService {
  /**
   * Admit and start one job.
   * @param job - the job spec.
   * @returns its id, for `job_output` and the card.
   */
  start(job: BackgroundJob): string
}

/** The process's own capture, as the registry's pull sources read it. */
interface ObservedStream {
  readFrom(fromByte: number): { readonly text: string; readonly nextOffset: number; readonly lossy: boolean }
}

/**
 * The process's two captured streams as pull sources.
 *
 * Bound lazily because the process is spawned INSIDE the job's `done`, after admission:
 * a read before the spawn yields nothing, and a read afterwards never consumes the
 * bytes the job's own consumer will see.
 * @param getProcess - the process, once it exists.
 * @returns one source per stream, stdout first.
 */
export function observedSources(getProcess: () => ShellExecution | undefined): readonly JobOutputSource[] {
  const source = (channel: 'stdout' | 'stderr'): JobOutputSource => ({
    channel,
    read: (fromByte) => {
      const process = getProcess()
      if (process === undefined) return { text: '', nextOffset: fromByte, lossy: false }
      const observed = process.observed as unknown as Record<'stdout' | 'stderr', ObservedStream>
      return observed[channel].readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * Project a settled process onto the registry's outcome vocabulary.
 *
 * A non-zero exit is `completed` with the code in the detail — the same reading the shell
 * tool reports: a command that failed is not a job that failed.
 * @param process - the settled process.
 * @returns the outcome to record.
 */
export function processOutcome(process: ShellExecution): JobOutcome {
  if (process.status === 'killed') {
    return { status: 'killed', detail: process.signal === null ? 'killed before exit' : `signal: ${process.signal}` }
  }
  const notes: string[] = []
  if (process.sandbox?.runnerFailed === true) {
    notes.push(`[sandbox: the sandbox runner itself failed under ${process.sandbox.mode} mode — the command did not run]`)
  } else if (process.sandbox?.denied === true) {
    notes.push(`[sandbox: denied under ${process.sandbox.mode} mode]`)
  }
  const detail = `exit code: ${String(process.exitCode ?? 0)}${notes.length === 0 ? '' : `; ${notes.join(' ')}`}`
  return { status: 'completed', detail }
}

/**
 * Run one asynchronous spawn under the job's hooks, so the registry can cancel it.
 *
 * The abort signal is the ONLY cancellation path a job has (the tool call that started it
 * is long over), so it is created here and passed to a starter that must hand it to the
 * executor: that is what makes `job_kill` reach the process.
 * @param start - starts the process with job-owned cancellation.
 * @param outcome - projects the settled process into the job outcome.
 * @returns the hooks the registry expects, with completion covering the spawn too.
 */
export function runJob(
  start: (signal: AbortSignal) => Promise<ShellExecution>,
  outcome: (process: ShellExecution) => JobOutcome,
): { readonly done: Promise<JobOutcome>; readonly cancel: (reason: string) => void } {
  const controller = new AbortController()
  let process: ShellExecution | undefined
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      process?.kill()
    },
    done: (async (): Promise<JobOutcome> => {
      try {
        process = await start(controller.signal)
        try {
          if (controller.signal.aborted) process.kill()
        } finally {
          await process.done
        }
        return outcome(process)
      } catch (error) {
        // A spawn that never produced a process was cancelled by the job; anything else is
        // the registry's `failed`. Either way the outcome is a value, never a rejection.
        return {
          status: controller.signal.aborted && process === undefined ? 'killed' : 'failed',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    })(),
  }
}
