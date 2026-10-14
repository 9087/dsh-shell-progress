import { describe, expect, it } from 'vitest'
import { createNonce, markerText } from '../src/instrument.ts'
import { follow } from '../src/run.ts'
import type { ProgressProcess } from '../src/run.ts'
import type { Step } from '../src/split.ts'

const STEPS: readonly Step[] = [
  { line: 1, text: 'Write-Output "one"' },
  { line: 2, text: 'Write-Output "two"' },
]

/**
 * A scripted process handle: each read hands over the next queued chunk, which
 * is exactly the contract `ShellProcess.readOutput` offers (output since the
 * previous read, consuming).
 */
function scripted(chunks: readonly string[], options: { readonly lossyAt?: number } = {}): {
  readonly process: ProgressProcess
  readonly settle: () => void
} {
  let index = 0
  let release: () => void = () => {}
  const done = new Promise<void>((resolve) => { release = resolve })
  return {
    process: {
      readOutput: () => {
        const delta = chunks[index] ?? ''
        const lossy = options.lossyAt === index
        index += 1
        return { delta, lossy }
      },
      done,
    },
    settle: () => { release() },
  }
}

describe('follow', () => {
  it('turns markers into the current step and attributes output', async () => {
    const nonce = createNonce()
    const { process, settle } = scripted([
      `${markerText(nonce, 1)}\none\n`,
      `${markerText(nonce, 2)}\ntwo\n`,
    ])
    const following = follow(process, { steps: STEPS, nonce, pollIntervalMs: 1 })
    settle()
    const { tracker, lossy } = await following
    expect(lossy).toBe(false)
    expect(tracker.current()).toBe(2)
    expect(tracker.steps().map((step) => step.output)).toEqual(['one', 'two'])
  })

  it('calls back after a read that produced output, so a live view can refresh', async () => {
    const nonce = createNonce()
    const { process, settle } = scripted([`${markerText(nonce, 1)}\n`])
    let updates = 0
    const following = follow(process, {
      steps: STEPS,
      nonce,
      pollIntervalMs: 1,
      onUpdate: () => { updates += 1 },
    })
    settle()
    await following
    expect(updates).toBeGreaterThan(0)
  })

  it('drains output that arrives between the last poll and process exit', async () => {
    const nonce = createNonce()
    const { process, settle } = scripted([
      `${markerText(nonce, 1)}\n`,
      `${markerText(nonce, 2)}\nlate\n`,
    ])
    const following = follow(process, { steps: STEPS, nonce, pollIntervalMs: 5 })
    settle()
    const { tracker } = await following
    expect(tracker.steps()[1]?.output).toBe('late')
  })

  it('emits a trailing fragment with no line terminator', async () => {
    const nonce = createNonce()
    const { process, settle } = scripted([`${markerText(nonce, 1)}\nno terminator`])
    const following = follow(process, { steps: STEPS, nonce, pollIntervalMs: 1 })
    settle()
    const { tracker } = await following
    expect(tracker.steps()[0]?.output).toBe('no terminator')
  })

  it('reports a lossy read', async () => {
    const nonce = createNonce()
    const { process, settle } = scripted([`${markerText(nonce, 1)}\n`], { lossyAt: 0 })
    const following = follow(process, { steps: STEPS, nonce, pollIntervalMs: 1 })
    settle()
    expect((await following).lossy).toBe(true)
  })

  it('settles the running step so its duration is final', async () => {
    const nonce = createNonce()
    const { process, settle } = scripted([`${markerText(nonce, 1)}\n`])
    const following = follow(process, { steps: STEPS, nonce, pollIntervalMs: 1 })
    settle()
    const { tracker } = await following
    expect(tracker.steps()[0]?.endedAt).not.toBeNull()
  })
})
