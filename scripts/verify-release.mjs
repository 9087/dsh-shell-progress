#!/usr/bin/env node
/**
 * Verify the artifact that is actually ON the registry, after it has been published.
 *
 * Everything before this point in a release proves the SOURCE: `pnpm test` runs the
 * suite against `src/`, and the build writes `lib/`. None of that is the thing users
 * download. A tarball can be missing the vendored grammar, ship a stale `lib/client.js`,
 * or be published from the wrong commit, and every gate up to `npm publish` stays green.
 * This script is the only step that reads what the registry serves.
 *
 * It checks, in order, and stops at the first failure it cannot work around:
 *
 * 1. the registry SERVES the version at all — after a publish there is a propagation
 *    window in which the version is simply absent, so this polls rather than guessing
 *    (and it queries the registry directly: `npm view` can answer from its own HTTP
 *    cache, which is exactly how a fresh publish once looked like a 404 for minutes);
 * 2. the record's `gitHead` is the commit being released — the version is built from a
 *    tag, and a tag that points elsewhere publishes someone else's tree;
 * 3. the record carries a PROVENANCE attestation, which is what `--provenance` and
 *    Trusted Publishing exist to produce;
 * 4. the tarball holds the files `package.json` promises, by downloading and extracting
 *    it — including the vendored tree-sitter grammar, which `files` has to name
 *    explicitly and which no test in this repository installs;
 * 5. the bundles are the SHAPE this project depends on, at the sizes it measured: the
 *    client bundle carries its inlined grammar (the purity gate's reason for being) and
 *    the host bundle keeps the harness packages EXTERNAL — the accident this bounds was
 *    a host bundle that inlined them and grew from 77 kB to 315 kB;
 * 6. the published `lib/client.js` RUNS: it is loaded through the shell's module-loader
 *    contract, applied to a fake client context, and used to render a settled four-step
 *    card — the same claim `tests/client-bundle.spec.ts` makes about `lib/`, made here
 *    about the bytes a user would install.
 *
 * React comes from the invoking checkout (it is a peer of this package and a devDependency
 * of the repository); the platform primitives are stubbed, because only the shell's frozen
 * module table can answer them. When React cannot be resolved the render check is reported
 * as a SKIP and the run still fails nothing — a skip is stated, never silent.
 *
 * Usage:
 *   node scripts/verify-release.mjs [version] [--expect-git-head <sha>] [--timeout-ms <ms>] [--keep] [--allow-no-provenance]
 *
 * `version` accepts `1.2.3` or `v1.2.3`, and defaults to the registry's `latest` tag.
 * Exit code is 0 only when every check passed; the summary says what failed and why.
 * `--allow-no-provenance` turns a missing attestation into a stated SKIP, for auditing a
 * release published by the manual fallback in PUBLISH.md — never a silent pass.
 *
 * The checks encode the CURRENT package contract, which is what a fresh release must
 * satisfy. Auditing an older version can therefore report differences that are history
 * rather than defects — 0.1.0, for one, predates both the vendored grammar and the step
 * metadata the render check feeds in. Judge a version by what it claimed to ship; the
 * gate's job is the version being released right now.
 *
 * @module dsh-shell-progress/scripts/verify-release
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(fileURLToPath(new URL('.', import.meta.url)))
const MANIFEST = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

/** Measurements this repository pinned; every bound below is one of them. */
const HOST_BUNDLE_MAX_BYTES = 200_000 // measured 77 kB; the inlining accident was 315 kB
const CLIENT_BUNDLE_MIN_BYTES = 100_000 // measured 487 kB: shiki and both grammars, inlined
const GRAMMAR_MIN_BYTES = 1_000_000 // measured 1,358,224 B — a tree-sitter wasm, not a stub

/** The harness packages the HOST bundle must keep external, by name as it requires them. */
const EXTERNAL_PEERS = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/schemastery']

/** What `files` in `package.json` promises, plus what npm always includes. */
const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/types/index.d.ts',
  'vendor/README.md',
  'vendor/tree-sitter-bash.wasm',
]

const failures = []
const skipped = []

/**
 * Record one check's outcome and print it.
 * @param {string} what - the check's description.
 * @param {boolean} pass - whether it held.
 * @param {string} detail - what was measured.
 * @returns {boolean} `pass`, so a caller can stop on a broken precondition.
 */
function check(what, pass, detail) {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${what}${detail === '' ? '' : ` — ${detail}`}`)
  if (!pass) failures.push(what)
  return pass
}

/** Read one URL as JSON, or undefined when it is not there. */
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
  if (!response.ok) return { status: response.status }
  return { status: response.status, body: await response.json() }
}

/**
 * Wait until the registry serves one version, and return its manifest.
 *
 * A publish is not instantly readable: the version arrives after replication, and the
 * packument can lag behind the version document. Polling the VERSION endpoint is
 * deliberate — it is the smallest document that cannot be satisfied by a stale
 * packument, and it 404s until the real record exists.
 * @param {string} name - the package name.
 * @param {string} version - the version to wait for.
 * @param {number} timeoutMs - how long to keep asking.
 * @returns {Promise<Record<string, unknown> | undefined>} the manifest, or undefined.
 */
async function waitForVersion(name, version, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer yet'
  for (;;) {
    const answer = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`)
    if (answer.body !== undefined) return answer.body
    last = `HTTP ${String(answer.status)}`
    if (Date.now() >= deadline) break
    await new Promise((resolve) => { setTimeout(resolve, 5_000) })
  }
  console.log(`       (waited ${String(Math.round(timeoutMs / 1000))}s; last answer ${last})`)
  return undefined
}

/**
 * The shell's module-loader stand-in, matching `tests/client-bundle.spec.ts`.
 *
 * The published bundle is browser CJS: it calls `window.__ModuleLoader__.load(entry)` and
 * later `entry.factory(require)`. Both are reproduced here, with a `require` that answers
 * the platform modules the shell's frozen table would answer and loads real React from the
 * invoking checkout — the same split the local suite uses, pointed at the tarball.
 * @returns {{ window: unknown, require: (id: string) => unknown }} the sandbox.
 */
function moduleLoaderSandbox() {
  const requireFromRepo = createRequire(join(REPO, 'package.json'))
  /** A stand-in component that renders its children instead of dropping them. */
  const stub = (extra = {}) => new Proxy({ __esModule: true, ...extra }, {
    get(target, property, receiver) {
      if (property === '__esModule') return true
      if (property === 'default') return receiver
      if (property === 'then') return undefined
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      return (props = {}) => undefined
    },
  })
  const load = (id) => {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return stub({
        StateDot: () => null,
        HoverCard: ({ anchor }) => anchor,
      })
    }
    if (id === 'react' || id === 'react/jsx-runtime' || id === 'react-dom' || id === 'react-dom/server') {
      return requireFromRepo(id)
    }
    return stub()
  }
  const loaded = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { loaded.push(entry) } } },
    require: load,
    loaded,
  }
  return sandbox
}

/**
 * Execute one built client bundle and report what it does when applied and rendered.
 *
 * This is the check that cannot be faked by a version number: it runs the file from the
 * published tarball, and the assertion is the feature the package exists for — one
 * segment per step, from the host's own step metadata.
 * @param {string} bundlePath - the extracted `lib/client.js`.
 * @returns {{ contributions: string[], segments: number }} what it registered and drew.
 */
function runPublishedClientBundle(bundlePath) {
  const requireFromRepo = createRequire(join(REPO, 'package.json'))
  const { createElement } = requireFromRepo('react')
  const { renderToStaticMarkup } = requireFromRepo('react-dom/server')

  const code = readFileSync(bundlePath, 'utf8')
  const sandbox = moduleLoaderSandbox()
  const moduleShim = { exports: {} }
  const run = new Function('window', 'module', 'exports', 'require', code)
  run(sandbox.window, moduleShim, moduleShim.exports, sandbox.require)
  if (sandbox.loaded.length !== 1) {
    throw new Error(`the bundle handed the loader ${String(sandbox.loaded.length)} entries, not one`)
  }
  const entry = sandbox.loaded[0]
  const plugin = entry.factory(sandbox.require)

  const registrations = []
  const injected = []
  plugin.apply({
    slots: {
      inject: (name, callback) => { injected.push(name); return callback() },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    connection: { rpc: { call: async () => ({ ok: false, error: { code: 'internal', message: 'stub' } }) } },
    effect: (fn) => fn(),
    on: () => () => {},
  })

  const steps = [
    ['Write-Output "[1/4] fetch"', '[1/4] fetch'],
    ['Write-Output "[2/4] build"', '[2/4] build'],
    ['Write-Output "[3/4] test"', '[3/4] test'],
    ['Write-Output "[4/4] pack"', '[4/4] pack'],
  ]
  const block = {
    kind: 'tool-result',
    callId: 'release-check',
    name: 'shell_progress_pwsh',
    meta: {
      v: 1,
      instrumented: true,
      refused: false,
      partial: false,
      preamble: '',
      steps: steps.map(([text, output], index) => ({
        line: index + 1,
        text,
        output,
        startedAt: index * 1_000,
        endedAt: index * 1_000 + 500,
      })),
    },
  }
  const Component = registrations[0]?.component
  if (typeof Component !== 'function') throw new Error('the bundle registered no component')
  // React warns that `useLayoutEffect` does nothing on the server. It is right, and it is
  // about the harness rather than the package: the card measures its own layout, which
  // static markup has none of. The warning is muted for the render and nothing else is —
  // a throw still propagates and is reported as a failed check.
  const originalError = console.error
  console.error = () => {}
  let html
  try {
    html = renderToStaticMarkup(createElement(Component, {
      callId: 'release-check',
      toolName: 'shell_progress_pwsh',
      phase: 'result',
      block,
      t: (key, params) => {
        let out = key
        for (const [name, value] of Object.entries(params ?? {})) out += ` ${name}=${String(value)}`
        return out
      },
      useProgress: (select) => select({ calls: {} }),
      watchCall: () => () => {},
    }))
  } finally {
    console.error = originalError
  }
  const segments = (html.match(/data-phase="/gu) ?? []).length
  return { contributions: registrations.map((entry) => String(entry.options?.key)), injected, segments }
}

async function main() {
  const argv = process.argv.slice(2)
  const flags = new Map()
  const positional = []
  // Flags that take no value. Without this set a `--flag` swallows the argument after it,
  // which is how `--allow-no-provenance` once parsed as `''` and changed nothing.
  const BOOLEAN_FLAGS = new Set(['keep', 'allow-no-provenance'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('--')) {
      const key = argument.slice(2)
      if (BOOLEAN_FLAGS.has(key)) { flags.set(key, 'true'); continue }
      flags.set(key, argv[index + 1] ?? '')
      index += 1
      continue
    }
    positional.push(argument)
  }
  const name = flags.get('package') ?? MANIFEST.name
  const version = (positional[0] ?? 'latest').replace(/^v/u, '')
  const expectedGitHead = flags.get('expect-git-head')
  const timeoutMs = Number(flags.get('timeout-ms') ?? '120000')

  console.log(`verify-release: ${name}@${version}${expectedGitHead === undefined ? '' : ` (expected commit ${expectedGitHead.slice(0, 8)})`}`)

  const manifest = await waitForVersion(name, version, timeoutMs)
  const served = manifest === undefined ? `nothing at ${name}@${version}` : `${name}@${String(manifest.version)}`
  if (!check('the registry serves the version', manifest !== undefined, served)) return report()
  const resolvedVersion = String(manifest.version)

  check('the record is the version asked for', resolvedVersion === version, resolvedVersion)
  if (expectedGitHead !== undefined) {
    check('the record was built from the expected commit', manifest.gitHead === expectedGitHead,
      `gitHead ${String(manifest.gitHead)}`)
  } else {
    skipped.push('gitHead (no --expect-git-head given)')
  }
  const provenance = manifest.dist?.attestations?.provenance
  if (provenance === undefined && flags.get('allow-no-provenance') === 'true') {
    // The manual fallback in PUBLISH.md publishes without `--provenance`, so its release
    // has none by construction. The skip is stated rather than silent: a version missing
    // an attestation for any OTHER reason still fails, because this flag is opt-in.
    skipped.push('provenance (--allow-no-provenance: a hand-published release has none)')
  } else {
    check('the record carries a provenance attestation', provenance !== undefined,
      provenance === undefined ? 'no dist.attestations.provenance' : String(provenance.predicateType))
  }

  // The tarball, downloaded and extracted: everything below reads these bytes.
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-shell-progress-verify-'))
  try {
    // The tarball is taken from `dist.tarball` — the URL the registry itself names — and
    // checked against `dist.integrity`, the digest an install would verify. Running `npm
    // pack` instead would re-resolve and re-pack, so it would prove less about THIS
    // record, and `npm` is a `.cmd` on Windows, which Node refuses to spawn without a
    // shell.
    const tarballUrl = manifest.dist?.tarball
    const tarball = join(workdir, 'package.tgz')
    let downloaded = false
    if (typeof tarballUrl === 'string') {
      const response = await fetch(tarballUrl, { headers: { 'cache-control': 'no-cache' } })
      if (response.ok) {
        writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
        downloaded = true
      }
    }
    check('the registry\'s tarball downloads', downloaded,
      typeof tarballUrl === 'string' ? tarballUrl.split('/').pop() ?? tarballUrl : 'the record names no dist.tarball')
    if (!downloaded) return report()
    const integrity = manifest.dist?.integrity
    if (typeof integrity === 'string' && integrity.startsWith('sha512-')) {
      const digest = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
      check('the tarball is the digest the registry declares', digest === integrity, integrity.slice(0, 28) + '…')
    } else {
      skipped.push('tarball integrity (the record declares none)')
    }
    execFileSync('tar', ['-xzf', tarball, '-C', workdir])
    const packageDir = join(workdir, 'package')

    const shipped = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    check('the tarball\'s own manifest is the version asked for', shipped.version === resolvedVersion, String(shipped.version))
    const missing = REQUIRED_FILES.filter((file) => !existsSync(join(packageDir, file)))
    check('every promised file is in the tarball', missing.length === 0, missing.length === 0 ? `${String(REQUIRED_FILES.length)} files` : `missing ${missing.join(', ')}`)

    const sizeOf = (rel) => existsSync(join(packageDir, rel)) ? statSync(join(packageDir, rel)).size : -1
    const hostBytes = sizeOf('lib/index.js')
    check('the host bundle keeps its size (peers stayed external)', hostBytes > 0 && hostBytes < HOST_BUNDLE_MAX_BYTES, `${String(hostBytes)} bytes`)
    const clientBytes = sizeOf('lib/client.js')
    check('the client bundle carries its inlined grammar', clientBytes > CLIENT_BUNDLE_MIN_BYTES, `${String(clientBytes)} bytes`)
    const grammarBytes = sizeOf('vendor/tree-sitter-bash.wasm')
    check('the vendored grammar is a real grammar, not a stub', grammarBytes > GRAMMAR_MIN_BYTES, `${String(grammarBytes)} bytes`)

    const hostSource = readFileSync(join(packageDir, 'lib/index.js'), 'utf8')
    const absent = EXTERNAL_PEERS.filter((peer) => !hostSource.includes(peer))
    check('the host bundle names every package it expects the host to provide', absent.length === 0, absent.length === 0 ? EXTERNAL_PEERS.length + ' peers' : `absent: ${absent.join(', ')}`)
    check('the client bundle asks the shell for its primitives', readFileSync(join(packageDir, 'lib/client.js'), 'utf8').includes('@deepseek-ai/dsh-client-ui-primitives'), 'dsh-client-ui-primitives')

    // The one check that runs the artifact. React is a peer this package does not ship,
    // so when the invoking checkout cannot provide it the check is SKIPPED and said so —
    // a skip is reported, never silently counted as a pass.
    let reactAvailable = true
    try {
      createRequire(join(REPO, 'package.json'))('react')
    } catch {
      reactAvailable = false
    }
    if (!reactAvailable) {
      skipped.push('running the published client bundle (React is not resolvable from the invoking checkout)')
    } else {
      try {
        const ran = runPublishedClientBundle(join(packageDir, 'lib/client.js'))
        check('the published client bundle applies to a client context', ran.contributions.length === 2, ran.contributions.join(', '))
        check('the published client bundle draws one segment per step', ran.segments === 4, `${String(ran.segments)} segments`)
      } catch (error) {
        check('the published client bundle runs', false, error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    if (flags.get('keep') === 'true') console.log(`       (kept ${workdir})`)
    else rmSync(workdir, { recursive: true, force: true })
  }
  report()
}

/** Print the summary and set the exit code. */
function report() {
  if (skipped.length > 0) console.log(`skipped: ${skipped.join('; ')}`)
  if (failures.length === 0) {
    console.log('verify-release: PASS')
    return
  }
  console.log(`verify-release: FAIL — ${failures.join('; ')}`)
  process.exitCode = 1
}

await main()
