/**
 * The dependency-classification guard.
 *
 * A plugin's `dependencies` are INSTALLED INTO THE CONSUMER'S PROFILE. The harness
 * packages are not the plugin's to install: the dsh profile uses `nodeLinker: hoisted`,
 * so a copy of `@deepseek-ai/dsh-tools` — and everything that copy pulls with it —
 * lands in the profile root as a PHYSICAL directory and SHADOWS the host's own copy.
 *
 * That is not a size problem, it is an identity problem. The host keys its tool
 * scheduler with a plain `Symbol("@deepseek-ai/dsh-tools.scheduler")` — not
 * `Symbol.for(...)`, which would be shared across instances — so two module instances
 * produce two DIFFERENT symbols, the lookup with one misses the object built by the
 * other, and every tool call dies with:
 *
 *     TypeError: Cannot read properties of undefined (reading 'prepare')
 *
 * measured end to end: with the packages declared as dependencies, installing the
 * published tarball into a hoisted root materialised 20 `@deepseek-ai/*` physical
 * copies (dsh-tools, dsh-session, dsh-agent, cordis, schemastery, …); after moving
 * them out, the count fell to the two the framework peer pulled in — and once
 * `@deepseek-ai/cordis` was marked `optional` too, `auto-install-peers` stopped
 * installing it and its `cosmokit` dependency, so a consumer root now gains no
 * `@deepseek-ai` directory at all.
 *
 * So: whatever the host provides belongs in `devDependencies` (for local types and
 * tests) or `peerDependencies` (the framework), NEVER in `dependencies`.
 *
 * It reads the BUILT host half, so like `./client-bundle.spec.ts` it needs a build:
 * `pnpm run build && pnpm test`. CI builds before testing for exactly this reason.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = process.cwd()
const HOST_BUNDLE = join(PROJECT_ROOT, 'lib', 'index.js')

/** The harness packages the built host half reaches for, deduplicated and sorted. */
async function harnessImports(): Promise<string[]> {
  const bundle = await readFile(HOST_BUNDLE, 'utf8')
  const found = bundle.match(/@deepseek-ai\/[a-z0-9-]+/g) ?? []
  return [...new Set(found)].sort()
}

/** The classification in `package.json`. */
async function classification(): Promise<Record<string, Record<string, string>>> {
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return {
    dependencies: manifest.dependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    devDependencies: manifest.devDependencies ?? {},
  }
}

describe('what the host provides is never a runtime dependency', () => {
  it('declares no harness package in dependencies', async () => {
    const imports = await harnessImports()
    const { dependencies } = await classification()
    // If this fails, the plugin will install its own copy of a harness package into
    // every consumer's profile — see the note at the top of this file for what that
    // does to the host's Symbol-keyed handles.
    expect(imports.length, 'the host half imports no harness package at all, which cannot be right').toBeGreaterThan(0)
    for (const specifier of imports) {
      expect(Object.keys(dependencies), `${specifier} must not be a runtime dependency`).not.toContain(specifier)
    }
  })

  it('keeps the plugin\'s own runtime libraries as dependencies', async () => {
    const { dependencies } = await classification()
    // The client bundle inlines these, and nothing else ships them: if they fall out of
    // `dependencies` they stop being installed for anyone but this repository.
    expect(Object.keys(dependencies)).toContain('shiki')
    expect(Object.keys(dependencies)).toContain('@shikijs/langs')
  })

  it('pins the version gate: the host-provided services stay optional peers', async () => {
    const { peerDependencies, dependencies } = await classification()
    // The bundle's own specifier list is NOT a usable check here: it also carries packages
    // reached transitively through the framework (`cordis`, `cosmokit`, `dsh-pwsh-local`,
    // …), which the plugin neither declares nor controls. What is worth pinning is the
    // decision itself: these four are the host's to provide, so they are PEERS — which
    // expresses the compatible RANGE (a mismatched host becomes reportable) and keeps them
    // external in the host bundle — and they must never drift back into `dependencies`,
    // where pnpm would install a second copy into the consumer's profile.
    const services = [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ]
    for (const name of services) {
      expect(Object.keys(peerDependencies), `${name} must stay a peer`).toContain(name)
      expect(Object.keys(dependencies), `${name} must not be a runtime dependency`).not.toContain(name)
    }
  })
})
