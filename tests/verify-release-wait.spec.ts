/**
 * The gate's WAITING loop, driven by a fake registry.
 *
 * This loop is the one part of `scripts/verify-release.mjs` that a hand-run cannot stage: it
 * exists for "the version is published but the registry does not serve it yet", a window that
 * lasts minutes and occurs once per release. The first tag that gate ever guarded (v0.3.0)
 * failed on nothing but this budget — the artifact was fine, the loop gave up first — so its
 * behaviour is asserted here rather than left to a constant chosen by eye.
 *
 * The clock, the pause and the read are injected, so every case below is deterministic and
 * touches no network.
 *
 * @module dsh-shell-progress/tests/verify-release-wait
 */

import { describe, expect, it, vi } from 'vitest'

import { waitForVersion } from '../scripts/verify-release.mjs'

/** One answer from the fake registry. */
interface FakeAnswer {
  readonly status: number
  readonly body?: unknown
}

/**
 * A fake registry: the clock only advances when the loop sleeps, and the last answer repeats
 * for any read beyond the script, so a missing answer can never be mistaken for success.
 * @param answers - what each successive read returns.
 * @param options - the budget and the pause to drive the loop with.
 * @returns the fake read, clock, sleep, and the calls they recorded.
 */
function fakeRegistry(answers: readonly FakeAnswer[], options: { timeoutMs?: number; intervalMs?: number } = {}) {
  const reads: string[] = []
  const pauses: number[] = []
  let elapsed = 0
  const last = answers[answers.length - 1] ?? { status: 404 }
  return {
    reads,
    pauses,
    fetchJson: async (url: string) => {
      reads.push(url)
      return answers[Math.min(reads.length - 1, answers.length - 1)] ?? last
    },
    sleep: async (ms: number) => {
      pauses.push(ms)
      elapsed += ms
    },
    now: () => elapsed,
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: options.intervalMs ?? 5_000,
  }
}

/** Run the loop against a fake registry, and collect what it printed. */
async function waitAgainst(fake: ReturnType<typeof fakeRegistry>): Promise<{ manifest: unknown, printed: string }> {
  const printed: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { printed.push(parts.join(' ')) })
  try {
    const manifest = await waitForVersion('dsh-shell-progress', '0.3.0', {
      timeoutMs: fake.timeoutMs,
      intervalMs: fake.intervalMs,
      fetchJson: fake.fetchJson,
      sleep: fake.sleep,
      now: fake.now,
    })
    return { manifest, printed: printed.join('\n') }
  } finally {
    spy.mockRestore()
  }
}

describe('the registry wait', () => {
  it('keeps asking until the version is served, then stops asking', async () => {
    const manifest = { version: '0.3.0', gitHead: 'd615de8' }
    const fake = fakeRegistry([
      { status: 404 },
      { status: 404 },
      { status: 404 },
      { status: 200, body: manifest },
    ])

    const result = await waitAgainst(fake)

    expect(result.manifest).toEqual(manifest)
    // Three 404s, then the answer: no fourth pause, because the loop stops on success.
    expect(fake.reads).toHaveLength(4)
    expect(fake.pauses).toEqual([5_000, 5_000, 5_000])
    // It asks the VERSION endpoint — the smallest document a stale packument cannot satisfy.
    expect(fake.reads[0]).toBe('https://registry.npmjs.org/dsh-shell-progress/0.3.0')
    expect(result.printed).not.toContain('waited')
  })

  it('gives up when the budget is gone, and names what the registry last answered', async () => {
    const fake = fakeRegistry([{ status: 503 }], { timeoutMs: 10_000, intervalMs: 5_000 })

    const result = await waitAgainst(fake)

    expect(result.manifest).toBeUndefined()
    // Reads at 0 ms, 5 s and 10 s; the deadline is reached on the third, so no fourth read
    // and no third pause — the loop must not sleep past a budget it has already spent.
    expect(fake.reads).toHaveLength(3)
    expect(fake.pauses).toEqual([5_000, 5_000])
    expect(result.printed).toContain('waited 10s')
    expect(result.printed).toContain('HTTP 503')
  })

  it('reports the LAST status, not the first, so the message describes the current state', async () => {
    const fake = fakeRegistry([{ status: 404 }, { status: 404 }, { status: 503 }], { timeoutMs: 10_000, intervalMs: 5_000 })

    const result = await waitAgainst(fake)

    expect(result.printed).toContain('HTTP 503')
    expect(result.printed).not.toContain('HTTP 404')
  })
})
