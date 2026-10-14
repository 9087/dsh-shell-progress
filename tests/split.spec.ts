import { describe, expect, it } from 'vitest'
import { scanLine, splitSteps } from '../src/split.ts'

/**
 * The six probes the design document measured on this host. They are fixed
 * cases, not illustrations: each one is a way a naive brace counter gets the
 * depth wrong.
 */
describe('scanLine', () => {
  it('ignores braces inside a double-quoted string', () => {
    expect(scanLine('Write-Output "{ not a brace }"')).toEqual({ braces: 0, safe: true })
  })

  it('ignores a hash inside a double-quoted string', () => {
    expect(scanLine('Write-Output "text # not a comment"')).toEqual({ braces: 0, safe: true })
  })

  it('counts a one-line hashtable as balanced', () => {
    expect(scanLine('$h = @{ a = 1 }')).toEqual({ braces: 0, safe: true })
  })

  it('opens a block', () => {
    expect(scanLine('foreach ($i in 1..2) {')).toEqual({ braces: 1, safe: true })
  })

  it('closes a block', () => {
    expect(scanLine('}')).toEqual({ braces: -1, safe: true })
  })

  it('ignores a brace inside a comment', () => {
    expect(scanLine('# } comment only')).toEqual({ braces: 0, safe: true })
  })

  it('honours the backtick escape inside a double-quoted string', () => {
    expect(scanLine('Write-Output "a `" { b"')).toEqual({ braces: 0, safe: true })
  })

  it('treats a single-quoted string as fully literal', () => {
    expect(scanLine("Write-Output '{ } '' # '")).toEqual({ braces: 0, safe: true })
  })

  it('refuses an unterminated string', () => {
    expect(scanLine('Write-Output "no end').safe).toBe(false)
    expect(scanLine("Write-Output 'no end").safe).toBe(false)
  })

  it('refuses a line whose parentheses do not balance', () => {
    expect(scanLine('$x = Get-Item (Join-Path a b').safe).toBe(false)
  })
})

describe('splitSteps', () => {
  it('selects column-zero lines at depth zero', () => {
    const result = splitSteps(['$a = 1', 'Write-Output $a'].join('\n'))
    expect(result.safe).toBe(true)
    expect(result.steps).toEqual([
      { line: 1, text: '$a = 1' },
      { line: 2, text: 'Write-Output $a' },
    ])
  })

  it('never selects a loop body or a closer', () => {
    const source = [
      '$total = 0',
      'foreach ($n in 1..3) {',
      '  $total += $n',
      '  Write-Output "adding $n"',
      '}',
      'Write-Output $total',
    ].join('\n')
    const result = splitSteps(source)
    expect(result.safe).toBe(true)
    expect(result.steps.map((step) => step.line)).toEqual([1, 2, 6])
  })

  it('selects a nested block head but not its body', () => {
    const source = [
      'if ($true) {',
      '  if ($false) {',
      '    Write-Output "inner"',
      '  }',
      '}',
      'Write-Output "after"',
    ].join('\n')
    expect(splitSteps(source).steps.map((step) => step.line)).toEqual([1, 6])
  })

  it('keeps a step that starts with a hash-brace in a string', () => {
    const source = ['Write-Output "{"', 'Write-Output "}"'].join('\n')
    const result = splitSteps(source)
    expect(result.safe).toBe(true)
    expect(result.steps.map((step) => step.line)).toEqual([1, 2])
  })

  it('skips blank lines without changing depth', () => {
    const source = ['', '  ', 'Write-Output 1', ''].join('\n')
    expect(splitSteps(source).steps.map((step) => step.line)).toEqual([3])
  })

  it('handles CRLF', () => {
    expect(splitSteps('Write-Output 1\r\nWrite-Output 2\r\n').steps.map((step) => step.line)).toEqual([1, 2])
  })

  it('does not treat a tab-indented line as a step', () => {
    expect(splitSteps('\tWrite-Output 1').steps).toEqual([])
  })

  it('accepts a whole-command try/catch/finally', () => {
    const source = [
      'try {',
      '  Write-Output "trying"',
      '} catch {',
      '  Write-Output "caught"',
      '} finally {',
      '  Write-Output "done"',
      '}',
    ].join('\n')
    const result = splitSteps(source)
    expect(result.safe).toBe(true)
    expect(result.steps.map((step) => step.line)).toEqual([1])
  })

  it('refuses an unclosed block', () => {
    expect(splitSteps('if ($true) {').safe).toBe(false)
  })

  it('refuses a closing brace with no opening brace', () => {
    const result = splitSteps('}')
    expect(result.safe).toBe(false)
    expect(result.reason).toContain('closing brace')
  })

  it('refuses a block comment and a here-string', () => {
    expect(splitSteps('<# comment #>\nWrite-Output 1').safe).toBe(false)
    expect(splitSteps("@'\ntext\n'@").safe).toBe(false)
  })

  it('refuses a line continuation', () => {
    expect(splitSteps('Write-Output 1 `\n  Write-Output 2').safe).toBe(false)
  })

  it('reports what it found even when it refuses', () => {
    // The decision comes before the line is scanned, so the undecidable line is
    // reported as a step and the refusal is separate. The partial list is only
    // ever used to draw a degraded card; nothing is instrumented.
    const result = splitSteps('Write-Output 1\nWrite-Output "unterminated')
    expect(result.safe).toBe(false)
    expect(result.steps.map((step) => step.line)).toEqual([1, 2])
  })
})
