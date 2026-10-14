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

3. **Configure Trusted Publishing on npmjs.com** — this repo uses OIDC, so
   there is **no `NPM_TOKEN` secret anywhere**:

   - npmjs.com → your package → *Settings* → *Trusted Publisher* →
     *GitHub Actions*
   - Organization or user: `9087`
   - Repository: `dsh-shell-progress`
   - Workflow filename: `release.yml`
   - Environment: (leave empty)

   Save. That entry is what lets the workflow below publish without a token.

3. **Protect `main`** in the GitHub repository settings, and require the `verify`
   job from `.github/workflows/ci.yml` as a status check.

4. **Push the repository** (the first release needs the workflow file present on
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

```sh
npm view dsh-shell-progress@X.Y.Z gitHead    # must equal the release commit
```

## Manual fallback

Only if CI cannot run:

```sh
pnpm run build
npm publish --registry=https://registry.npmjs.org/
```

This skips the provenance attestation, so prefer the CI path.

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
