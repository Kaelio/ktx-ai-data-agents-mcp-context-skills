# KTX release runbook

This runbook covers the maintainer workflow for publishing `@kaelio/ktx` to
npm through GitHub Actions. The workflow uses semantic-release to choose the
next version, update release metadata, publish the package, create the GitHub
release, and commit the release files back to the repository.

## Release channels

KTX has two npm release channels:

- `rc` publishes prereleases such as `0.1.0-rc.2` to the npm `next` tag.
- `stable` publishes normal releases such as `0.1.0` to the npm `latest` tag.

Run stable releases only from `main`. The workflow rejects stable releases from
other branches.

## Prerequisites

Before you publish, confirm these requirements:

- The repository has an Actions secret named `NPM_TOKEN`.
- `NPM_TOKEN` is a granular npm token that can publish `@kaelio/ktx`.
- The token can publish non-interactively if the npm account or package uses
  two-factor authentication for writes.
- The repository has a baseline semantic-release tag for the latest published
  package version, such as `v0.1.0-rc.1`.

If no baseline tag exists, semantic-release treats the run as the first release
and may choose a version that doesn't match the currently published package.

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

The dry-run uses the same semantic-release configuration as a live release. It
doesn't publish to npm and doesn't commit release files.

## Publish an rc release

Publish an rc release when you need a prerelease package for validation before
promoting to `latest`.

1. Open **Actions** in GitHub.
2. Select **KTX Release**.
3. Select the branch to release from.
4. Set **release_kind** to `rc`.
5. Set **publish_live** to `true`.
6. Optional: Set **force_release** to `true`.
7. Run the workflow.

The workflow publishes `@kaelio/ktx` with `--access public --tag next`, runs the
published package smoke test, creates a GitHub release, and commits
`CHANGELOG.md`, `package.json`, and `release-policy.json`.

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

## Trusted Publishing follow-up

This workflow uses `NPM_TOKEN` today. Move to npm Trusted Publishing after the
final publish command path is verified for the package manager and workflow
filename configured in npm package settings.
