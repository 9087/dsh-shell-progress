import { describe, expect, it } from 'vitest'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import { renderShellResult } from '../src/render.ts'
import type { CanonicalRunResult } from '../src/render.ts'

/** A clean exit with no output, which every case below adjusts. */
function result(overrides: Partial<CanonicalRunResult> = {}): CanonicalRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 120_000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

describe('renderShellResult', () => {
  it('renders a clean exit with no marker at all', () => {
    expect(renderShellResult(result({ stdout: { text: 'hello\n', truncated: false } }))).toBe('hello\n')
  })

  it('says "(no output)" when there is nothing', () => {
    expect(renderShellResult(result())).toBe('(no output)')
  })

  it('adds a marked stderr section', () => {
    expect(renderShellResult(result({
      stdout: { text: 'out\n', truncated: false },
      stderr: { text: 'err\n', truncated: false },
    }))).toBe('out\n[stderr]\nerr\n')
  })

  it('separates stdout and stderr with exactly one newline', () => {
    expect(renderShellResult(result({
      stdout: { text: 'out', truncated: false },
      stderr: { text: 'err', truncated: false },
    }))).toBe('out\n[stderr]\nerr')
  })

  it('reports a non-zero exit as a marker, not an error', () => {
    expect(renderShellResult(result({ exitCode: 3, stdout: { text: 'x\n', truncated: false } })))
      .toBe('x\n[exit code: 3]')
  })

  it('reports a signal kill instead of an exit code', () => {
    expect(renderShellResult(result({ exitCode: null, signal: 'SIGTERM' })))
      .toBe('(no output)\n[killed by signal: SIGTERM]')
  })

  it('reports a timeout with the applied budget', () => {
    expect(renderShellResult(result({ timedOut: true, exitCode: null, signal: 'SIGTERM' })))
      .toBe('(no output)\n[timed out after 120000ms]\n[killed by signal: SIGTERM]')
  })

  it('mirrors pwsh\'s marker order even when a timed-out kill reported no signal', () => {
    // Faithful to `renderPwshResult`, oddity included: with neither a signal nor
    // a zero exit code, the exit marker reads `null`.
    expect(renderShellResult(result({ timedOut: true, exitCode: null })))
      .toBe('(no output)\n[timed out after 120000ms]\n[exit code: null]')
  })

  it('appends the truncation notice with the spill path', () => {
    expect(renderShellResult(result({
      stdout: { text: 'tail\n', truncated: true, spillPath: 'C:\\tmp\\spill.txt' },
    }))).toBe('tail\n\n[output truncated; full output: C:\\tmp\\spill.txt]')
  })

  it('says the spill path is unavailable when it is', () => {
    expect(renderShellResult(result({ stdout: { text: 'tail', truncated: true } })))
      .toContain('[output truncated; full output: (unavailable)]')
  })

  it('reports a sandbox denial, with the escalation hint when one is offered', () => {
    const denied = result({ sandbox: { mode: 'read-only', denied: true } })
    expect(renderShellResult(denied)).toContain(sandboxDenialMarker('read-only'))
    expect(renderShellResult(denied)).not.toContain(escalationHintMarker('command'))
    expect(renderShellResult(denied, ['workspace-write'])).toContain(escalationHintMarker('command'))
  })

  it('puts the exit marker last, because the exit-status parser anchors there', () => {
    const rendered = renderShellResult(result({
      exitCode: 1,
      stdout: { text: 'body\n', truncated: false },
      sandbox: { mode: 'read-only', denied: true },
    }))
    expect(rendered.split('\n').at(-1)).toBe('[exit code: 1]')
  })
})
