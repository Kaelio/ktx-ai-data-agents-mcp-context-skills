# KTX release runbook

This runbook covers the maintainer workflow for publishing `@kaelio/ktx` to
npm through GitHub Actions. The workflow uses semantic-release to choose the
next version, update release metadata in the CI workspace, publish the
package, and create the GitHub release. No files are ever committed back to
the repository — the git tag and the published npm artifact are the source of
truth for any released version.

## Release channels

`main` is the bleeding-edge branch. Every release runs from `main`; the
dispatcher chooses the channel:

- `rc` publishes prereleases such as `0.3.0-rc.1` to the npm `next` tag.
- `stable` publishes normal releases such as `0.3.0` to the npm `latest` tag.

Tag history on `main` interleaves rc and stable tags
(`v0.2.0 → v0.3.0-rc.1 → v0.3.0-rc.2 → v0.3.0 → …`). semantic-release uses the
prerelease tags to graduate to the next stable cleanly.

The workflow rejects releases from any branch other than `main`.

## Prerequisites

Before you publish, confirm these requirements:

- npm Trusted Publishing is configured for `@kaelio/ktx`.
- The trusted publisher points at the `Kaelio/ktx-ai-data-agents-context` repository and the
  `.github/workflows/release.yml` workflow.
- The workflow keeps `id-token: write` permission so npm can verify the
  GitHub Actions run through OpenID Connect.
- The repository has release metadata in `release-policy.json` for the current
  public package line, such as `0.1.0-rc.1` or `0.1.0`.
- The repository has a stable baseline tag when you need semantic-release to
  publish the first stable version as `0.1.0`.

If you rename the GitHub repository, the semantic-release run adapts on its
own: `scripts/semantic-release-config.cjs` derives `repositoryUrl` from the
runner's `GITHUB_REPOSITORY`, so `@semantic-release/github` always matches the
current clone URL. The one thing that does **not** auto-update is the npm
Trusted Publishing config — re-point it at the new repository name (plus
`release.yml`) on npm, or `npm publish --provenance` will fail OIDC
verification. The `repository` field in `package.json` is npm-display metadata
only and can stay whatever public name you prefer.

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
3. Select `main`.
4. Set **release_kind** to `rc` or `stable`.
5. Set **publish_live** to `false`.
6. Optional: Set **force_release** to `true` when you need a patch release even
   if semantic-release doesn't find a releasable commit.
7. Run the workflow.

The dry-run uses the same semantic-release configuration as a live release. It
doesn't publish to npm and doesn't push any tags.

## Publish an rc release

Publish an rc release when you need a prerelease package for validation before
promoting to `latest`.

1. Open **Actions** in GitHub.
2. Select **KTX Release**.
3. Select `main`.
4. Set **release_kind** to `rc`.
5. Leave **publish_live** set to `true`.
6. Optional: Set **force_release** to `true`.
7. Run the workflow.

The workflow publishes `@kaelio/ktx` with `--access public --tag next`, runs
the published package smoke test, creates a GitHub release, and pushes the
`vX.Y.Z-rc.N` tag.

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
the published package smoke test, creates a GitHub release, and pushes the
`vX.Y.Z` tag. semantic-release graduates from the most recent rc tag, so the
prior rc lineage is consumed cleanly.

## Release metadata

semantic-release calls `scripts/update-public-release-version.mjs` during the
prepare step before the exec publish command runs. That script rewrites the
following files in lockstep:

- `package.json` and `packages/cli/package.json` with the semantic-release
  version.
- `python/ktx-daemon/pyproject.toml` and `python/ktx-sl/pyproject.toml` with
  the same version, normalized for PEP 440 (e.g. `0.1.0-rc.2` →
  `0.1.0rc2`). Branch-prefixed npm releases skip this step because they are
  not published to PyPI.
- `release-policy.json` with the npm publish settings, release mode, and
  published package smoke-test version. The package version itself is not
  stored here; it is derived from `packages/cli/package.json.version` by
  `scripts/public-npm-release-metadata.mjs`, so there is only one place that
  owns the version.

The `@semantic-release/git` plugin then commits these files back to `main`
with the release tag (see `scripts/semantic-release-config.cjs`). As a
result, the dev tree always reflects the most recently published version —
there is no sentinel pin. `ktx --version` and the bundled Python wheel both
report whatever was last released.

At runtime the CLI reads its version from its own `package.json` via
`getKtxCliPackageInfo()` (`packages/cli/src/cli-runtime.ts`); the Python
daemon reads its version from installed-package metadata via
`importlib.metadata.version()` (`python/ktx-daemon/src/ktx_daemon/__init__.py`).

The bundled Python runtime wheel also derives its version from the same
single source. Stable npm versions are reused as-is, and rc versions are
normalized to Python's version format. For example, `0.1.0-rc.2` becomes
`0.1.0rc2` in the `kaelio-ktx` wheel filename and wheel metadata.

## npm authentication

The release workflow publishes through npm Trusted Publishing. It doesn't use
an `NPM_TOKEN` secret, and the publish step doesn't set `NODE_AUTH_TOKEN`.

If npm returns an authentication error, check the Trusted Publishing settings
for the `@kaelio/ktx` package before adding token-based authentication back to
the workflow.
