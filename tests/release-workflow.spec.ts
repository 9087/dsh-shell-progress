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

  it('publishes idempotently, because the job cannot be resumed', () => {
    const workflow = workflowLines.join('\n')
    // The publish step runs in the SAME job as the gate and the announcement, so a failure
    // after it leaves the version public and unannounced — and a re-run then dies on the
    // registry's refusal to accept a second publish of a version that exists. Both halves of
    // the guard are asserted: the pre-check, and the refusal it recognises by name.
    expect(workflow).toContain('already on the registry')
    expect(workflow).toContain('cannot publish over the previously published versions')
  })

  it('offers a recovery dispatch that names the tag it is about', () => {
    const workflow = workflowLines.join('\n')
    expect(workflow).toContain('workflow_dispatch')
    // On a dispatch `github.ref_name` is the BRANCH, so the tag has to be an input.
    expect(workflow).toContain("description: 'existing release tag to verify and announce")
    expect(workflow).toContain('inputs.tag')
  })

  it('announces the release TAG, not the branch a dispatch ran from', () => {
    // `softprops/action-gh-release` defaults to `github.ref`; on a dispatch that is the
    // branch, and the Release would be published against `main` instead of the tag.
    const announce = lineOf('action-gh-release')
    const block = workflowLines.slice(announce, announce + 4).join('\n')
    expect(block).toContain('tag_name')
  })
})
