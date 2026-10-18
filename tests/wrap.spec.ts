/**
 * The display-only line breaker, against real command shapes.
 *
 * The contract that matters: it never changes what runs, it never reformats a line it cannot
 * scan with certainty, and it only ever inserts newlines — every original character keeps
 * its order, so the card shows the same command, just wrapped.
 */
import { describe, expect, it } from 'vitest'
import { wrappedDisplayText } from '../src/wrap.ts'

/** A realistic one-liner: exactly the shape that ends up as one unreadable step. */
const ONE_LINER = "cd C:\\PROJECTS\\app; pnpm run build 2>&1 | Select-String -Pattern 'complete|error' | Select-Object -First 5; echo '=== test ==='; pnpm test 2>&1 | Select-Object -Last 3; echo done"

describe('wrappedDisplayText', () => {
  it('breaks a long command at its top-level semicolons, inserting only newlines', () => {
    const wrapped = wrappedDisplayText(ONE_LINER)
    expect(wrapped).toBeDefined()
    // Whitespace aside, the characters are unchanged and in order: nothing was rewritten.
    expect(wrapped?.replace(/\s+/g, ' ').trim()).toBe(ONE_LINER.replace(/\s+/g, ' ').trim())
    expect(wrapped?.split('\n').length).toBeGreaterThan(1)
    // The build's own `|` pipeline must not be broken: it is still one line.
    expect(wrapped?.split('\n').some((line) => line.includes('Select-Object -First 5'))).toBe(true)
  })

  it('leaves a short line alone', () => {
    expect(wrappedDisplayText('pnpm test')).toBeUndefined()
  })

  it('leaves a line with no top-level semicolon alone', () => {
    expect(wrappedDisplayText(`pnpm run build 2>&1 | Select-String -Pattern 'complete|error' | Select-Object -First 5`)).toBeUndefined()
  })

  it('never breaks inside a quoted string', () => {
    const quoted = `echo 'a; b'; echo 'c; d'; echo '${'x'.repeat(60)}'`
    const wrapped = wrappedDisplayText(quoted)
    expect(wrapped).toBeDefined()
    const lines = (wrapped?.split('\n') ?? []).map((line) => line.trim())
    // The `;` inside each string is content, not a break; only the two separators break.
    expect(lines[0]).toBe("echo 'a; b';")
    expect(lines[1]).toBe("echo 'c; d';")
    expect(lines).toHaveLength(3)
  })

  it('never breaks inside a subexpression or a block', () => {
    const nested = `$v = Get-ChildItem (Join-Path $PWD 'a;b') | Measure-Object; $v.Count; ${'Write-Output ' + 'x'.repeat(60)}`
    const wrapped = wrappedDisplayText(nested)
    expect(wrapped).toBeDefined()
    const lines = (wrapped?.split('\n') ?? []).map((line) => line.trim())
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("'a;b'")
  })

  it('refuses a line it cannot scan with certainty', () => {
    // An unterminated string is not something to guess around.
    expect(wrappedDisplayText(`echo 'unterminated; echo x; ${'y'.repeat(60)}`)).toBeUndefined()
    // A `#` comment ends the statement list, so later semicolons are not statements.
    expect(wrappedDisplayText(`echo a; # note; echo b; ${'z'.repeat(60)}`)).toBeUndefined()
  })

  it('leaves a multi-line step alone: its own lines are already the breaks', () => {
    const multi = 'cd C:\\PROJECTS\\app;\npnpm run build;\necho done; something long here'
    expect(wrappedDisplayText(multi)).toBeUndefined()
  })
})
