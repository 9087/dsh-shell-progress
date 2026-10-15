/**
 * The PowerShell candidate list, for BOTH platforms, on either host.
 *
 * This spec exists because the list was Windows-only and nothing said so: the
 * tag-triggered CI run (38781014702) failed on `ubuntu-latest` at `pnpm test`
 * — `tests/pwshtree.spec.ts` asserting `instrumented === true` and getting
 * `false` — while every test here was green on Windows. A POSIX host split the
 * `PATH` on `;`, looked for `pwsh.exe` and probed drive letters, so
 * `resolvePowershell()` answered `undefined` and the pwsh PLANNER silently
 * refused every multi-step command.
 *
 * Nothing here spawns a shell, so it runs everywhere; the candidate list is
 * asserted for both platforms, built with the same `path.win32`/`path.posix`
 * pair the module uses.
 */

import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { powershellCandidates, resolvePowershell } from '../src/pwsh-path.ts'

/** A PATH in the shape each platform really has. */
const POSIX_PATH = '/usr/bin:/usr/local/bin:/home/dev/.local/bin'
const WINDOWS_PATH = 'C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7;C:\\tools'

describe('the PowerShell candidate list is built for the platform asked about', () => {
  it('looks for `pwsh` on a POSIX host, one candidate per PATH entry', () => {
    const candidates = powershellCandidates({ PATH: POSIX_PATH }, 'linux')
    expect(candidates).toContain('/usr/bin/pwsh')
    expect(candidates).toContain('/usr/local/bin/pwsh')
    expect(candidates).toContain('/home/dev/.local/bin/pwsh')
    // The install locations the .deb/.rpm, the tarball and the snap use.
    expect(candidates).toContain('/opt/microsoft/powershell/7/pwsh')
    expect(candidates).toContain('/snap/bin/pwsh')
    // And the bare name LAST, which is what makes the spawn resolve it through PATH.
    expect(candidates.at(-1)).toBe('pwsh')
    // Nothing Windows-only survives into this list: no `.exe`, no drive-letter
    // fallback, and — the bug — no backslash anywhere.
    expect(candidates.filter((candidate) => candidate.endsWith('.exe'))).toEqual([])
    expect(candidates.filter((candidate) => candidate.includes('\\'))).toEqual([])
    expect(candidates.filter((candidate) => candidate.startsWith('C:'))).toEqual([])
  })

  it('keeps the Windows list in the order it has always had', () => {
    const candidates = powershellCandidates(
      { PATH: WINDOWS_PATH, ProgramFiles: 'D:\\Apps', SystemRoot: 'C:\\Windows' },
      'win32',
    )
    // Configured path first, then the PowerShell 7 install, then PATH entries, then the
    // in-box 5.1 that a host without PowerShell 7 really runs.
    expect(candidates[0]).toBe(win32.join('D:\\Apps', 'PowerShell', '7', 'pwsh.exe'))
    expect(candidates).toContain(win32.join('C:\\tools', 'pwsh.exe'))
    expect(candidates.at(-1)).toBe(
      win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    )
    // One candidate per PATH entry again — three entries, `;`-separated.
    const fromPath = candidates.filter((candidate) => candidate.endsWith('pwsh.exe'))
    expect(fromPath).toContain(win32.join('C:\\Windows\\System32', 'pwsh.exe'))
    expect(fromPath).toHaveLength(4) // the ProgramFiles install + the three PATH entries
  })

  it('takes a configured interpreter first, on either platform', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const candidates = powershellCandidates(
        { PATH: '', DSH_PWSH_PATH: '/custom/pwsh', PWSH_PATH: '/older/pwsh' },
        platform,
      )
      expect(candidates.slice(0, 2)).toEqual(['/custom/pwsh', '/older/pwsh'])
    }
    // The newer name alone is enough; the old one alone still is too.
    expect(powershellCandidates({ PATH: '', PWSH_PATH: '/older/pwsh' }, 'linux')[0]).toBe('/older/pwsh')
  })

  it('answers with something that IS pwsh when there is nothing to test on disk', () => {
    // The bare POSIX candidate has no path, so it is returned as-is for the spawn to
    // resolve — that is the `?? 'pwsh'` fallback the suites and `verify-semantics` use.
    // (On a host that really has one of the fixed locations, THAT is the answer instead,
    // which is why this asserts what the answer is, not which candidate produced it.)
    expect(resolvePowershell({ PATH: '' }, 'linux')?.endsWith('pwsh')).toBe(true)
    // Windows has no such candidate: with nothing on disk there is no answer at all,
    // which is the `undefined` the planner turns into a refusal.
    expect(resolvePowershell({ PATH: '', ProgramFiles: 'Z:\\nowhere', SystemRoot: 'Z:\\nowhere' }, 'win32')).toBeUndefined()
  })
})
