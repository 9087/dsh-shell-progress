/**
 * Following a running command: poll the process handle, fold each delta into
 * the tracker, stop exactly when the process settles.
 *
 * The loop takes a minimal process port rather than a `ShellExecution`, so it
 * can be driven by a fake in a unit test with no shell, no subprocess, and no
 * cordis context involved.
 *
 * @module dsh-shell-progress/run
 */

import { LineFeeder } from './parse.ts'
import type { Step } from './split.ts'
import { StepTracker } from './tracker.ts'
import type { StepTrackerOptions } from './tracker.ts'

/** The slice of a shell process this loop needs. */
export interface ProgressProcess {
  /** Output produced since the previous read; consuming. */
  readOutput(): { readonly delta: string; readonly lossy: boolean }
  /** Resolves when the underlying process settles; never rejects. */
  readonly done: Promise<void>
}

/** Options for {@link follow}. */
export interface FollowOptions extends StepTrackerOptions {
  /** The steps that were instrumented, in source order. */
  readonly steps: readonly Step[]
  /** This run's marker nonce. */
  readonly nonce: string
  /** Milliseconds between reads. Defaults to 120. */
  readonly pollIntervalMs?: number
  /** Called after each read that produced output, so a live view can be refreshed. */
  readonly onUpdate?: () => void
  /**
   * The tracker to drive — pass THE SAME instance the live view reads.
   *
   * `follow` used to build its own tracker and return it, and the caller only
   * adopted it once `follow` resolved. A snapshot taken while the command ran
   * therefore read the pristine tracker created before the run began: no current
   * step, `elapsedMs` zero, every step pending. The card drew its planned steps
   * and could not move until the command ENDED and the finished tracker was
   * swapped in — which is exactly "the bar only updates at the start and the end".
   */
  readonly tracker?: StepTracker
}

/** What following a process produced. */
export interface FollowResult {
  /** The tracker holding per-step output and timings. */
  readonly tracker: StepTracker
  /** True when the executor dropped bytes this loop never saw. */
  readonly lossy: boolean
}

const DEFAULT_POLL_INTERVAL_MS = 120

/**
 * A cancellable sleep. The timer is unref'd so a pending poll can never keep
 * the host process alive on its own.
 * @param milliseconds - how long to wait.
 * @returns a promise that settles after the delay.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    // Node's timer object carries unref; a DOM-typed timer does not.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

/**
 * Poll one running process until it settles, then drain the tail.
 *
 * The final read happens after `done`, because output produced between the
 * last poll and process exit is still readable from the buffered stream.
 * @param process - the running process handle.
 * @param options - the steps, the nonce, and the polling cadence.
 * @returns the tracker and whether any read was lossy.
 */
export async function follow(process: ProgressProcess, options: FollowOptions): Promise<FollowResult> {
  const tracker = options.tracker ?? new StepTracker(options.steps, options)
  const feeder = new LineFeeder(options.nonce)
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  let lossy = false
  let settled = false

  const consume = (): void => {
    const read = process.readOutput()
    if (read.lossy) lossy = true
    if (read.delta.length === 0) return
    for (const event of feeder.feed(read.delta)) tracker.observe(event)
    options.onUpdate?.()
  }

  const loop = (async () => {
    for (;;) {
      consume()
      if (settled) break
      await delay(pollIntervalMs)
    }
    // The stream is finished, so a held-back trailing fragment is a line.
    for (const event of feeder.flush()) tracker.observe(event)
  })()

  try {
    await process.done
  } finally {
    settled = true
    await loop
    tracker.settle()
  }
  return { tracker, lossy }
}

/**
 * Wait for a process this run does NOT track (a degraded run that executed the
 * command unmodified). Nothing is consumed, so the executor's own result
 * projection still reads the whole stream from offset 0.
 * @param process - the running process handle.
 * @returns when the process has settled.
 */
export async function drain(process: ProgressProcess): Promise<void> {
  await process.done
}
