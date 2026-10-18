/**
 * The `;` normalizer: one-line statement chains become one statement per line.
 *
 * The contract is narrow on purpose. It rewrites NOTHING semantic: PowerShell treats `;` and
 * a newline as the same statement separator, so the script means the same thing and the
 * existing line-start markers apply unchanged. Everything it cannot read with certainty —
 * quotes, `#`, here-strings, blocks, continuations — is refused, and the caller runs the
 * command exactly as written.
 */
import { describe, expect, it } from 'vitest'
import { normalizeStatements, relabelSteps } from '../src/statements.ts'

describe('normalizeStatements', () => {
  it('puts each top-level statement on its own line', () => {
    const normalized = normalizeStatements("cd C:\\app; pnpm build; echo 'done'")
    expect(normalized).toBeDefined()
    expect(normalized?.text).toBe("cd C:\\app;\npnpm build;\necho 'done'")
    expect(normalized?.originalLines).toEqual([1, 1, 1])
  })

  it('keeps the semicolons and drops only the spaces after them', () => {
    const normalized = normalizeStatements('a ; b ; c')
    expect(normalized?.text).toBe('a ;\nb ;\nc')
  })

  it('maps rewritten lines back to the lines the reader typed', () => {
    const normalized = normalizeStatements('a; b\nc; d')
    expect(normalized?.text).toBe('a;\nb\nc;\nd')
    expect(normalized?.originalLines).toEqual([1, 1, 2, 2])
  })

  it('leaves a command with no top-level separator alone', () => {
    expect(normalizeStatements('pnpm test')).toBeUndefined()
    // A `;` inside a string is content, not a boundary.
    expect(normalizeStatements("echo 'a; b'")).toBeUndefined()
  })

  it('never splits inside a block, a subexpression or quotes', () => {
    const block = normalizeStatements('if ($x) { a; b }; c')
    expect(block?.text).toBe('if ($x) { a; b };\nc')

    const subexpression = normalizeStatements('$v = (Get-Item a; Get-Item b); $v.Count')
    expect(subexpression?.text).toBe('$v = (Get-Item a; Get-Item b);\n$v.Count')

    const quoted = normalizeStatements("Write-Output 'a; b'; Write-Output \"c; d\"")
    expect(quoted?.text).toBe("Write-Output 'a; b';\nWrite-Output \"c; d\"")
  })

  it('refuses anything it cannot read with certainty', () => {
    // A comment makes every later `;` part of the comment, so no boundary is provable.
    expect(normalizeStatements('a; # note; b')).toBeUndefined()
    // Here-strings and unterminated quotes.
    expect(normalizeStatements("a; $x = @'\nb\n'@")).toBeUndefined()
    expect(normalizeStatements("a; echo 'unterminated")).toBeUndefined()
    // Unbalanced brackets.
    expect(normalizeStatements('a; if ($x) { b')).toBeUndefined()
    // A continuation backtick.
    expect(normalizeStatements('a; Get-Item `\nb')).toBeUndefined()
    // A doubled separator is not valid PowerShell; do not invent a boundary for it.
    expect(normalizeStatements('a;; b')).toBeUndefined()
  })
})

describe('relabelSteps', () => {
  it('keeps the reader\'s line and records the marker anchor', () => {
    const normalized = normalizeStatements('a; b; c')
    if (normalized === undefined) throw new Error('the fixture must normalize')
    const steps = relabelSteps(
      [{ line: 1, text: 'a;' }, { line: 2, text: 'b;' }, { line: 3, text: 'c' }],
      normalized,
    )
    expect(steps.map((step) => step.line)).toEqual([1, 1, 1])
    expect(steps.map((step) => step.anchor)).toEqual([1, 2, 3])
    expect(steps.map((step) => step.text)).toEqual(['a;', 'b;', 'c'])
  })
})
