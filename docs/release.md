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
prerelease branch in addition to the stable `main` branch.

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

If no stable baseline tag exists, semantic-release treats the stable run as the
first release. KTX seeds that first stable release from the base version in
`release-policy.json`, so `0.1.0-rc.6` promotes to `0.1.0` instead of
semantic-release's default `1.0.0`.

KTX blocks automatic major releases. A major version requires an intentional
manual release path that updates release metadata and creates the intended
version explicitly; don't rely on semantic-release commit analysis for major
bumps.

## Dry-run a release

Use a dry-run to verify the next version and generated release notes without
publishing to npm.

1. Open **Actions** in GitHub.
2. Select **KTX Release**.
3. Select the branch to release from.
4. Set **release_kind** to `rc` or `stable`.
5. Leave **publish_live** set to `false`.
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
3. Select the source branch to release from.
4. Set **release_kind** to `rc`.
5. Set **publish_live** to `true`.
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
4. Set **release_kind** to `stable`.
5. Set **publish_live** to `true`.
6. Optional: Set **force_release** to `true`.
7. Run the workflow.

The workflow publishes `@kaelio/ktx` with `--access public --tag latest`, runs
the published package smoke test, creates a GitHub release, and commits the
release metadata.

## Release metadata

semantic-release calls `scripts/update-public-release-version.mjs` during the
prepare step. That script updates:

- `package.json` with the semantic-release version.
- `release-policy.json` with `publicNpmPackageVersion`, npm publish settings,
  and the published package smoke-test version.

The artifact packaging and readiness scripts read `publicNpmPackageVersion`
from `release-policy.json`, so manual version edits in build scripts aren't
needed for rc releases.

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
