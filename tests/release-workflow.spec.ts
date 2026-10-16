/**
 * The release gate's ORDER — the one part of it no other test can see.
 *
 * `scripts/verify-release.mjs` proves what the registry serves, and it is exercised by
 * running it against a real published version. What it cannot check is whether anything
 * ever CALLS it: a workflow that skipped the step, or ran it after the GitHub Release,
 * would leave every gate green while telling users about an artifact nobody verified.
 * That ordering is the claim here — publish, verify, and only then announce.
 *
 * @module dsh-shell-progress/tests/release-workflow
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Under vitest `import.meta.url` is an http URL, so paths come from the test runner's cwd
// — the repository root, which is where `vitest run` is invoked from.
const PROJECT_ROOT = process.cwd()

const workflowLines = readFileSync(join(PROJECT_ROOT, '.github', 'workflows', 'release.yml'), 'utf8').split('\n')

/** The line index of the first line containing a marker, or -1. */
function lineOf(marker: string): number {
  return workflowLines.findIndex((line) => line.includes(marker))
}

describe('the release workflow', () => {
  it('verifies the published artifact, against the released commit', () => {
    const verify = lineOf('verify-release.mjs')
    expect(verify).toBeGreaterThan(-1)
    // Without an expected commit the check would accept any record that happens to carry
    // this version number — which is the failure mode (`gitHead` pointing elsewhere) it
    // exists to catch.
    expect(workflowLines[verify]).toContain('--expect-git-head')
  })

  it('publishes, then verifies, then announces — in that order', () => {
    const publish = lineOf('npm publish')
    const verify = lineOf('verify-release.mjs')
    const announce = lineOf('action-gh-release')
    expect(publish).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(publish)
    expect(announce).toBeGreaterThan(verify)
  })

  it('is reachable as a script, so the same check can be run by hand', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(manifest.scripts?.['verify:release']).toBe('node scripts/verify-release.mjs')
  })
})
