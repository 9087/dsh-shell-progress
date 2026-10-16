# Publishing

The local release is one command; npm publishing happens in CI from a tag.

```sh
pnpm run release
```

`release-it` derives the version from conventional commits
(`@release-it/conventional-changelog`, `conventionalcommits` preset), runs the
`before:bump` hook (`pnpm run build && pnpm test`), writes `CHANGELOG.md`,
commits `chore: release vX.Y.Z`, tags `vX.Y.Z`, and pushes both.

The push of the tag starts `.github/workflows/release.yml`, which runs the unit
suite, builds, and publishes with `npm publish --provenance`.

## What a human must do once

1. **Claim the npm package name.** The package is unscoped
   (`dsh-shell-progress`), so the name must be free and the publishing account
   must own it. Check with:

   ```sh
   npm view dsh-shell-progress version
   ```

   A `404` means the name is free. If it is taken, either ask its owner for
   access or rename this package in `package.json` before the first release.

2. **Bootstrap the package — the first publish is the ONE manual one.** A
   package's settings page only exists once the package does, and the Trusted
   Publisher form lives on that page: until `dsh-shell-progress` is on the
   registry there is nowhere to configure step 3. So publish it once by hand,
   from a machine logged into the owning account:

   ```sh
   npm login                              # browser + 2FA code
   pnpm run typecheck && pnpm test        # the same gate CI runs
   pnpm run build                         # ships lib/ (npm's `prepare` also runs it)
   npm pack --dry-run                     # read the file list BEFORE uploading
   npm publish --registry=https://registry.npmjs.org/
   npm view dsh-shell-progress version    # must print the version you just published
   ```

   This publishes the version currently in `package.json` (no version bump, no
   tag, no changelog entry) and it carries **no provenance**, because nothing
   attested it — that is expected, and every release after step 3 gets one.

   If the npm website does show a Trusted Publisher form for a name it has
   never seen, use that instead and skip this step.

   That publish creates **`0.1.0`** — `npm publish` sends whatever
   `package.json` says and computes nothing — and npm refuses to publish the
   same version twice, so the number is spent the moment the command returns.
   A bad `0.1.0` is therefore not fixable in place: publish `0.1.1`.
   `npm unpublish` is a 72-hour, no-dependents escape hatch, not a revert.

   **Tag the commit you published.** The bootstrap publish leaves no tag, and
   `release-it` derives the NEXT version from the last tag, so without one its
   first run proposes a version that is already on the registry:

   ```sh
   git tag v0.1.0 <the commit that was published>
   ```

3. **Configure Trusted Publishing on npmjs.com** — this repo uses OIDC, so
   there is **no `NPM_TOKEN` secret anywhere**:

   - npmjs.com → your package → *Settings* → *Trusted Publisher* →
     *GitHub Actions*
   - Organization or user: `9087`
   - Repository: `dsh-shell-progress`
   - Workflow filename: `release.yml`
   - Environment: (leave empty)

   Save. That entry is what lets the workflow below publish without a token.

4. **Protect `main` (optional)** — and be careful which half you turn on.

   `release-it` pushes its release commit **directly to `main`** (`git.push: true` in
   `.release-it.json`), so enabling *Require a pull request before merging* makes
   `pnpm run release` fail at its LAST step — after it has already bumped the
   version, written `CHANGELOG.md`, committed and tagged. If you want protection
   anyway, allow the repository admin to bypass it.

   For a repository with one committer the half that earns its keep is the other
   one: block **force-pushes** and **branch deletion**, leave the pull-request
   requirement off, and treat `verify` as a visible signal rather than a gate.
   Skipping protection entirely is also defensible here, because the release path
   already gates itself twice: `before:bump` runs `pnpm run build && pnpm test`,
   and the tag triggers `release.yml`, which runs the same suite before publishing.

5. **Push the repository** (the first release needs the workflow file present on
   the default branch):

   ```sh
   git remote -v          # git@github.com:9087/dsh-shell-progress.git
   git push -u origin main
   ```

## What you do NOT need to do

- No npm token, no `NODE_AUTH_TOKEN`, no secret of any kind, for any release.
- No manual `npm publish` **after the one in step 2** — that bootstrap is the
  only one, and every release from then on is CI's job.

## Verifying a release landed

CI does this, and as a **gate rather than a report**. After `npm publish`, and before the
GitHub Release is created, `release.yml` runs the same check by hand would:

```sh
node scripts/verify-release.mjs "$VERSION" --expect-git-head "$(git rev-parse HEAD)"
```

It polls for up to ten minutes until the registry actually serves the version (a fresh
publish is absent for a while — on v0.3.0 the version document took over two minutes to
appear, and a two-minute budget made the gate fail on nothing but its own impatience — and
`npm view` can answer from its own cache, which is how a published version once looked like
a 404), then checks that the record was built from that commit and carries a
provenance attestation, downloads the tarball and verifies it against the registry's own
`dist.integrity`, confirms the files `package.json` promises are inside it (including the
vendored grammar, which no test in this repository installs), and finally loads the
PUBLISHED `lib/client.js` through the shell's module-loader contract and renders a
four-step card with it.

The version number alone proves none of that: `pnpm test` runs against `src/`, and the
build writes `lib/`. A tarball can ship a stale client bundle or an absent grammar with
every earlier gate green. To audit any published version afterwards:

```sh
pnpm run verify:release 0.2.0     # omit the version for `latest`
```

It exits non-zero and names every failed check.

## Manual fallback

Only if CI cannot run:

```sh
pnpm run build
npm publish --registry=https://registry.npmjs.org/
```

This skips the provenance attestation, so prefer the CI path. It also skips the
post-publish verification CI runs, so finish by hand — and expect the attestation line to
be reported as a SKIP rather than a pass, because a hand-published release really has none:

```sh
pnpm run verify:release -- 0.2.0 --expect-git-head "$(git rev-parse HEAD)" --allow-no-provenance
```

## Rules

- Never commit or push without the user's explicit approval.
- Never ask for, type, or transmit npm credentials or OTP values.
- Do not skip the `prepare` build: it is what ships `lib/`.
- Bump rules: `feat:` minor, `fix:` / `perf:` patch, breaking major. Never
  reuse a published version.
- If a release fails midway, check `git status`; `release-it` rolls its own
  working-tree changes back, and anything left over can be cleared with
  `git reset --hard HEAD`.
- `CHANGELOG.md` is generated. Do not hand-write it.
