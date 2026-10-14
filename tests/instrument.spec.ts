import { describe, expect, it } from 'vitest'
import {
  createNonce,
  inlineMarker,
  instrument,
  looksInstrumented,
  markerPattern,
  markerText,
  stripMarkers,
  usesReservedVariable,
} from '../src/instrument.ts'
import { splitSteps } from '../src/split.ts'

const NONCE = 'deadbeef'

describe('createNonce', () => {
  it('is eight lowercase hex characters', () => {
    for (let index = 0; index < 16; index += 1) expect(createNonce()).toMatch(/^[0-9a-f]{8}$/)
  })

  it('does not repeat', () => {
    const nonces = new Set(Array.from({ length: 64 }, () => createNonce()))
    expect(nonces.size).toBe(64)
  })
})

describe('markerText', () => {
  it('carries the nonce and the original line number', () => {
    expect(markerText(NONCE, 12)).toBe('__DSH_STEP_deadbeef_12__')
  })

  it('is matched only as a whole line', () => {
    const pattern = markerPattern(NONCE)
    expect(pattern.test(markerText(NONCE, 3))).toBe(true)
    expect(pattern.test(`prefix ${markerText(NONCE, 3)}`)).toBe(false)
    expect(pattern.test('__DSH_STEP_other_3__')).toBe(false)
  })
})

describe('inlineMarker', () => {
  it('captures $? first, writes to the console stream, then restores $?', () => {
    const marker = inlineMarker(NONCE, 7, '__sentinel__')
    expect(marker.startsWith('$__ok = $?;')).toBe(true)
    expect(marker).toContain('[Console]::Out.WriteLine(\'__DSH_STEP_deadbeef_7__\')')
    expect(marker).toContain("Get-Item -LiteralPath '__sentinel__' -ErrorAction SilentlyContinue")
    // The regression this guards: a function-shaped marker overwrites `$?`,
    // so the marker must stay ONE inlined statement sequence.
    expect(marker).not.toMatch(/^\s*[A-Za-z][\w-]*\s+\$?__ok/)
  })
})

describe('instrument', () => {
  const source = ['$a = 1', 'if ($true) {', '  Write-Output "x"', '}', 'Write-Output $a'].join('\n')
  const steps = splitSteps(source).steps

  it('keeps the line count identical', () => {
    expect(instrument(source, steps, NONCE).split('\n')).toHaveLength(source.split('\n').length)
  })

  it('prefixes each step in place, leaving other lines byte-identical', () => {
    const lines = instrument(source, steps, NONCE).split('\n')
    expect(lines[1]).toContain('; if ($true) {')
    expect(lines[2]).toBe('  Write-Output "x"')
    expect(lines[3]).toBe('}')
    expect(lines[4]).toContain('; Write-Output $a')
  })

  it('does not append a marker to a line it did not select', () => {
    const lines = instrument(source, steps, NONCE).split('\n')
    for (const line of lines) {
      if (line.trim().startsWith('$__ok')) continue
      expect(line).not.toContain('__DSH_STEP_')
    }
  })

  it('preserves CRLF', () => {
    const crlf = '$a = 1\r\nWrite-Output $a\r\n'
    expect(instrument(crlf, splitSteps(crlf).steps, NONCE).split('\r\n')).toHaveLength(3)
  })

  it('leaves a command with no steps alone', () => {
    expect(instrument('  Write-Output 1', [], NONCE)).toBe('  Write-Output 1')
  })
})

describe('stripMarkers', () => {
  it('removes only this call\'s marker lines', () => {
    const captured = [
      markerText(NONCE, 1),
      'hello',
      markerText(NONCE, 2),
      'world',
      '__DSH_STEP_other_1__',
      '',
    ].join('\n')
    expect(stripMarkers(captured, NONCE)).toBe('hello\nworld\n__DSH_STEP_other_1__\n')
  })

  it('tolerates CRLF marker lines', () => {
    expect(stripMarkers(`${markerText(NONCE, 1)}\r\nkept\r\n`, NONCE)).toBe('kept\r\n')
  })

  it('is a no-op when no marker shape is present', () => {
    const text = 'plain output\n'
    expect(stripMarkers(text, NONCE)).toBe(text)
  })
})

describe('collision guards', () => {
  it('detects the marker prefix', () => {
    expect(looksInstrumented('Write-Output "__DSH_STEP_x"')).toBe(true)
    expect(looksInstrumented('Write-Output "hello"')).toBe(false)
  })

  it('detects the reserved variable', () => {
    expect(usesReservedVariable('$__ok = $?')).toBe(true)
    expect(usesReservedVariable('$ok = $?')).toBe(false)
  })
})
