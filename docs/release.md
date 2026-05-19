# KTX release runbook

This runbook covers the maintainer workflow for publishing `@kaelio/ktx` to
npm through GitHub Actions. The workflow uses semantic-release to choose the
next version, update release metadata, publish the package, create the GitHub
release, and commit the release files back to the repository.

## Release channels

KTX has two npm release channels:

- `rc` publishes prereleases such as `0.1.0-rc.2` to the npm `next` tag.
- `stable` publishes normal releases such as `0.1.0` to the npm `latest` tag.

Run rc releases from the source branch you want to publish. The workflow
creates or updates the `next` prerelease branch from that source branch before
running semantic-release, because semantic-release requires a dedicated
prerelease branch in addition to the stable `main` branch. You can publish an
rc from `main` when you want to validate the current stable branch before a
stable release.

Run stable releases only from `main`. The workflow rejects stable releases from
other branches.

## Prerequisites

Before you publish, confirm these requirements:

- npm Trusted Publishing is configured for `@kaelio/ktx`.
- The trusted publisher points at the `Kaelio/ktx` repository and the
  `.github/workflows/release.yml` workflow.
- The workflow keeps `id-token: write` permission so npm can verify the
  GitHub Actions run through OpenID Connect.
- The repository has release metadata in `release-policy.json` for the current
  public package line, such as `0.1.0-rc.1` or `0.1.0`.
- The repository has a stable baseline tag when you need semantic-release to
  publish the first stable version as `0.1.0`.

semantic-release doesn't support choosing an arbitrary first `0.x` stable
release. If KTX has no stable tag yet and you need the first stable release to
be `0.1.0`, create and push the baseline tag once before running the live
stable workflow:

```bash
root_commit="$(git rev-list --max-parents=0 HEAD | tail -n 1)"
git tag v0.0.0 "${root_commit}"
git push origin v0.0.0
```

KTX follows the same versioning schema as the main Kaelio release workflow:
breaking-change and `major` commit markers create a minor release, not an
automatic major release. A major version requires an intentional manual release
path.

## Dry-run a release

Use a dry-run to verify the next version and generated release notes without
publishing to npm.

1. Open **Actions** in GitHub.
2. Select **KTX Release**.
3. Select the branch to release from.
4. Set **release_kind** to `rc` or `stable`.
5. Set **publish_live** to `false`.
6. Optional: Set **force_release** to `true` when you need a patch release even
   if semantic-release doesn't find a releasable commit.
7. Run the workflow.

The dry-run uses the same semantic-release configuration as a live release. For
rc releases, it can create or update the `next` branch. It doesn't publish to
npm and doesn't commit release files.

## Publish an rc release

Publish an rc release when you need a prerelease package for validation before
promoting to `latest`.

1. Open **Actions** in GitHub.
2. Select **KTX Release**.
3. Select the source branch to release from, including `main` when needed.
4. Set **release_kind** to `rc`.
5. Leave **publish_live** set to `true`.
6. Optional: Set **force_release** to `true`.
7. Run the workflow.

The workflow merges the selected source branch into `next`, publishes
`@kaelio/ktx` with `--access public --tag next`, runs the published package
smoke test, creates a GitHub release, and commits `CHANGELOG.md`,
`package.json`, and `release-policy.json` on `next`.

## Publish a stable release

Publish a stable release from `main` after you have validated an rc package.

1. Open **Actions** in GitHub.
2. Select **KTX Release**.
3. Select `main`.
4. Leave **release_kind** set to `stable`.
5. Leave **publish_live** set to `true`.
6. Optional: Set **force_release** to `true`.
7. Run the workflow.

The workflow publishes `@kaelio/ktx` with `--access public --tag latest`, runs
the published package smoke test, creates a GitHub release, and commits the
release metadata.

## Release metadata

semantic-release calls `scripts/update-public-release-version.mjs` during the
prepare step before `@semantic-release/npm` publishes the package. That script
updates:

- `package.json` with the semantic-release version.
- `release-policy.json` with `publicNpmPackageVersion`, npm publish settings,
  and the published package smoke-test version.

The artifact packaging and readiness scripts read `publicNpmPackageVersion`
from `release-policy.json`, so manual version edits in build scripts aren't
needed for rc releases. The semantic-release npm plugin publishes the generated
`dist/public-npm-package` tree and writes the release tarball under
`dist/artifacts/npm`.

The bundled Python runtime wheel also derives its version from
`publicNpmPackageVersion`. Stable npm versions are reused as-is, and rc
versions are normalized to Python's version format. For example,
`0.1.0-rc.2` becomes `0.1.0rc2` in the `kaelio-ktx` wheel filename and wheel
metadata.

## npm authentication

The release workflow publishes through npm Trusted Publishing. It doesn't use
an `NPM_TOKEN` secret, and the publish step doesn't set `NODE_AUTH_TOKEN`.

If npm returns an authentication error, check the Trusted Publishing settings
for the `@kaelio/ktx` package before adding token-based authentication back to
the workflow.
