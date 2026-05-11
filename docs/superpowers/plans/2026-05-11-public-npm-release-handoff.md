# Public NPM Release Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the remaining npm-managed Python runtime release gap into a
guarded public `@kaelio/ktx` npm release handoff for version `0.1.0`.

**Architecture:** Keep one public npm package and keep Python packages
unpublished. The public package builder stamps the assembled `@kaelio/ktx`
package as `0.1.0`, release readiness accepts a publish-ready policy only when
all blocking decisions are encoded, and a new publish script performs a dry-run
by default before any live registry publish.

**Tech Stack:** Node 22 ESM scripts, `node:test`, pnpm 10 publish, JSON release
policy, GitHub Actions workflow validation.

---

## Spec trace and current state

This plan follows
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

The existing plan files that reference that spec are:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`
- `docs/superpowers/plans/2026-05-11-managed-agent-mcp-semantic-runtime.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-runtime.md`
- `docs/superpowers/plans/2026-05-11-managed-local-ingest-daemon-runtime.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-runtime-docs-and-postgres-smoke-cleanup.md`
- `docs/superpowers/plans/2026-05-11-public-kaelio-ktx-npm-package.md`
- `docs/superpowers/plans/2026-05-11-published-package-managed-runtime-smoke.md`

All twelve are implemented in the current tree: their referenced source and
test files exist, and the runtime command, daemon, package artifact,
published-package smoke, local-embedding smoke, and README markers are present.

The remaining release gap is explicit in `release-policy.json`: the repository
still uses `ci-artifact-only`, `npm.publish` is `false`, and the README states
that registry publishing is disabled. This plan changes that to a guarded
handoff for the first public npm release while leaving Python registry
publication disabled because the spec says KTX-owned Python code ships inside
the npm package as a bundled wheel for this release.

## File structure

- Modify `scripts/build-public-npm-package.mjs`: make the assembled public npm
  package version and tarball name `0.1.0` instead of `0.0.0-private`.
- Modify `scripts/build-public-npm-package.test.mjs`: cover public version
  stamping and the versioned tarball path.
- Modify `scripts/package-artifacts.mjs`: make artifact metadata report
  `@kaelio/ktx` as version `0.1.0`.
- Modify `scripts/package-artifacts.test.mjs`: update artifact manifest,
  metadata, runtime smoke, and demo smoke expectations for the public tarball.
- Modify `scripts/local-embeddings-runtime-smoke.test.mjs`: update public
  tarball selection coverage for `kaelio-ktx-0.1.0.tgz`.
- Modify `scripts/release-readiness.mjs`: add the
  `npm-public-release-ready` release mode and policy validation.
- Modify `scripts/release-readiness.test.mjs`: cover the publish-ready policy
  and validation failures.
- Modify `release-policy.json`: encode the first public npm release handoff.
- Create `scripts/publish-public-npm-package.mjs`: verify readiness and run
  `pnpm publish` in dry-run mode by default.
- Create `scripts/publish-public-npm-package.test.mjs`: cover publish command
  construction and policy gating.
- Modify `package.json`: add `release:npm-publish`.
- Create `.github/workflows/release.yml`: add a manual dry-run/live publish
  workflow for the public npm tarball.
- Create `scripts/release-workflow.test.mjs`: validate that the release
  workflow is manual, uses pnpm, runs readiness checks, and gates live publish.
- Modify `README.md`: replace the disabled publishing note with the guarded
  handoff commands.

### Task 1: Stamp public npm artifacts as `0.1.0`

**Files:**

- Modify: `scripts/build-public-npm-package.mjs`
- Modify: `scripts/build-public-npm-package.test.mjs`
- Modify: `scripts/package-artifacts.mjs`
- Modify: `scripts/package-artifacts.test.mjs`
- Modify: `scripts/local-embeddings-runtime-smoke.test.mjs`

- [ ] **Step 1: Write failing public version tests**

In `scripts/build-public-npm-package.test.mjs`, extend the import from
`./build-public-npm-package.mjs` so it includes `PUBLIC_NPM_PACKAGE_VERSION`
and `publicNpmPackageTarballName`:

```js
import {
  PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
  PUBLIC_NPM_PACKAGE_NAME,
  PUBLIC_NPM_PACKAGE_VERSION,
  collectPublicDependencies,
  createPublicNpmPackageTree,
  publicNpmPackageJson,
  publicNpmPackageLayout,
  publicNpmPackageTarballName,
  publicNpmPackCommand,
} from './build-public-npm-package.mjs';
```

Replace the `publicNpmPackageLayout` test expectation with:

```js
describe('publicNpmPackageLayout', () => {
  it('uses the first public npm release version for the tarball name', () => {
    const layout = publicNpmPackageLayout('/repo/ktx');

    assert.equal(PUBLIC_NPM_PACKAGE_VERSION, '0.1.0');
    assert.equal(publicNpmPackageTarballName(), 'kaelio-ktx-0.1.0.tgz');
    assert.equal(layout.tarballPath, '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0.tgz');
  });
});
```

In the `publicNpmPackageJson` test, add this assertion after the package name
assertion:

```js
assert.equal(packageJson.version, '0.1.0');
```

In the `publicNpmPackCommand` test, replace the tarball assertion block with:

```js
assert.deepEqual(publicNpmPackCommand(layout), {
  command: 'pnpm',
  args: [
    '--config.node-linker=hoisted',
    'pack',
    '--out',
    '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0.tgz',
  ],
  cwd: '/repo/ktx/dist/public-npm-package',
});
```

- [ ] **Step 2: Run public package tests to verify failure**

Run:

```bash
node --test scripts/build-public-npm-package.test.mjs
```

Expected: FAIL. The failure mentions at least one stale
`kaelio-ktx-0.0.0-private.tgz` or `0.0.0-private` public package version
expectation.

- [ ] **Step 3: Implement public version stamping**

In `scripts/build-public-npm-package.mjs`, replace the current public version
constants and layout helper with:

```js
export const PUBLIC_NPM_PACKAGE_NAME = '@kaelio/ktx';
export const PUBLIC_NPM_PACKAGE_VERSION = '0.1.0';

export function publicNpmPackageTarballName(version = PUBLIC_NPM_PACKAGE_VERSION) {
  return `kaelio-ktx-${version}.tgz`;
}
```

Replace `publicNpmPackageLayout` with:

```js
export function publicNpmPackageLayout(rootDir = scriptRootDir(), version = PUBLIC_NPM_PACKAGE_VERSION) {
  return {
    rootDir,
    packageVersion: version,
    cliPackageRoot: join(rootDir, 'packages', 'cli'),
    packRoot: join(rootDir, 'dist', 'public-npm-package'),
    npmDir: join(rootDir, 'dist', 'artifacts', 'npm'),
    tarballPath: join(rootDir, 'dist', 'artifacts', 'npm', publicNpmPackageTarballName(version)),
  };
}
```

Change `publicNpmPackageJson` so it accepts the public version explicitly:

```js
export function publicNpmPackageJson(cliPackageJson, dependencies, version = PUBLIC_NPM_PACKAGE_VERSION) {
  return {
    name: PUBLIC_NPM_PACKAGE_NAME,
    version,
    description: 'Standalone KTX context layer for database agents',
    private: false,
    type: 'module',
    engines: cliPackageJson.engines ?? { node: '>=22.0.0' },
    bin: { ktx: './dist/bin.js' },
    main: cliPackageJson.main ?? 'dist/index.js',
    types: cliPackageJson.types ?? 'dist/index.d.ts',
    exports: cliPackageJson.exports ?? {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    },
    files: ['dist', 'assets'],
    dependencies,
    bundledDependencies: PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
    license: cliPackageJson.license ?? 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/kaelio/ktx.git',
    },
    bugs: {
      url: 'https://github.com/kaelio/ktx/issues',
    },
    homepage: 'https://github.com/kaelio/ktx#readme',
  };
}
```

In `copyCliPackage`, pass the layout version:

```js
await writeJson(
  join(layout.packRoot, 'package.json'),
  publicNpmPackageJson(cliPackageJson, dependencies, layout.packageVersion),
);
```

In `createPublicNpmPackageTree`, return the versioned package JSON:

```js
return {
  layout,
  packageJson: publicNpmPackageJson(cliPackageJson, dependencies, layout.packageVersion),
  bundledPackages: PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
};
```

- [ ] **Step 4: Run public package tests to verify pass**

Run:

```bash
node --test scripts/build-public-npm-package.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Write failing artifact metadata tests**

In `scripts/package-artifacts.test.mjs`, replace expectations that use the
public npm tarball or package version:

```js
assert.equal(layout.cliTarball, '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0.tgz');
```

```js
{
  ecosystem: 'npm',
  packageName: '@kaelio/ktx',
  packageRoot: 'packages/cli',
  packageVersion: '0.1.0',
  private: false,
  releaseMode: 'ci-artifact-only',
}
```

```js
{
  ecosystem: 'npm',
  packageName: '@kaelio/ktx',
  packageVersion: '0.1.0',
  path: 'npm/kaelio-ktx-0.1.0.tgz',
  bytes: Buffer.byteLength('@kaelio/ktx-tarball'),
  sha256: createHash('sha256').update('@kaelio/ktx-tarball').digest('hex'),
}
```

In the runtime smoke source expectation, replace:

```js
requireOutput('ktx public package version', version, /@kaelio\/ktx 0\.1\.0/);
```

In `scripts/local-embeddings-runtime-smoke.test.mjs`, replace the public
tarball selection assertion with:

```js
assert.equal(
  publicKtxTarballName(['kaelio-ktx-0.1.0.tgz', 'ignore-me.tgz']),
  'kaelio-ktx-0.1.0.tgz',
);
```

- [ ] **Step 6: Run artifact tests to verify failure**

Run:

```bash
node --test scripts/package-artifacts.test.mjs scripts/local-embeddings-runtime-smoke.test.mjs
```

Expected: FAIL. The failure mentions stale artifact metadata or tarball
expectations for `0.0.0-private`.

- [ ] **Step 7: Implement artifact metadata versioning**

In `scripts/package-artifacts.mjs`, change the build-public import to:

```js
import {
  PUBLIC_NPM_PACKAGE_NAME,
  PUBLIC_NPM_PACKAGE_VERSION,
  publicNpmPackageTarballName,
} from './build-public-npm-package.mjs';
```

Replace `npmPackageTarballName` with:

```js
function npmPackageTarballName(packageName) {
  if (packageName === PUBLIC_NPM_PACKAGE_NAME) {
    return publicNpmPackageTarballName(PUBLIC_NPM_PACKAGE_VERSION);
  }
  return `${packageName.replace('@ktx/', 'ktx-')}-${PACKAGE_VERSION}.tgz`;
}
```

In `readNpmPackageMetadata`, return the public package version for
`@kaelio/ktx`:

```js
  const isPublicKtxPackage = packageInfo.name === PUBLIC_NPM_PACKAGE_NAME;
  return releaseMetadataEntry({
    ecosystem: 'npm',
    packageName: packageInfo.name,
    packageRoot: packageInfo.packageRoot,
    packageVersion: isPublicKtxPackage ? PUBLIC_NPM_PACKAGE_VERSION : packageJson.version,
    privatePackage: isPublicKtxPackage ? false : packageJson.private === true,
  });
```

In `npmRuntimeSmokeSource`, replace the version output regex with:

```js
requireOutput('ktx public package version', version, /@kaelio\/ktx 0\.1\.0/);
```

- [ ] **Step 8: Run artifact tests to verify pass**

Run:

```bash
node --test scripts/package-artifacts.test.mjs scripts/local-embeddings-runtime-smoke.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit public version stamping**

Run:

```bash
git add scripts/build-public-npm-package.mjs scripts/build-public-npm-package.test.mjs scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/local-embeddings-runtime-smoke.test.mjs
git commit -m "build: stamp public npm package version"
```

Expected: commit created.

### Task 2: Add publish-ready release policy validation

**Files:**

- Modify: `scripts/release-readiness.mjs`
- Modify: `scripts/release-readiness.test.mjs`
- Modify: `release-policy.json`

- [ ] **Step 1: Write failing release readiness tests**

In `scripts/release-readiness.test.mjs`, add `PUBLIC_NPM_PACKAGE_VERSION` to
the imports from `./build-public-npm-package.mjs`:

```js
import { PUBLIC_NPM_PACKAGE_VERSION } from './build-public-npm-package.mjs';
```

Update `releasePolicy()` so the default npm block includes publish settings:

```js
npm: {
  publish: false,
  registry: null,
  access: 'public',
  tag: 'latest',
  packages: ['@kaelio/ktx'],
  ...npmOverrides,
},
```

In each existing `releaseReadinessReport` expected object for
`ci-artifact-only` and `published-package-smoke-required`, add:

```js
npmPublish: null,
```

Place it after `publishedPackageSmokeGate` and before
`blockedPublishingDecisions`.

In `writeReleaseMetadataInputs`, keep internal workspace package versions
private. The public package version comes from artifact metadata:

```js
version: '0.0.0-private',
private: true,
```

Add this test after the existing
`reports required published package smoke when release mode requires it` test:

```js
it('accepts the npm public release ready policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ktx-npm-public-ready-test-'));
  try {
    await writeReadyFixture(root, {
      policy: releasePolicy({
        releaseMode: 'npm-public-release-ready',
        npm: {
          publish: true,
          registry: null,
          access: 'public',
          tag: 'latest',
        },
        publishedPackageSmoke: {
          packageName: '@kaelio/ktx',
          version: PUBLIC_NPM_PACKAGE_VERSION,
          registry: null,
        },
        requiredBeforePublishing: [],
      }),
    });

    const report = await releaseReadinessReport(root);

    assert.deepEqual(report, {
      schemaVersion: 1,
      releaseMode: 'npm-public-release-ready',
      sourceRevision: 'abc123',
      npmPublishEnabled: true,
      pythonPublishEnabled: false,
      packageNames: ['@kaelio/ktx', 'ktx-sl', 'ktx-daemon', 'kaelio-ktx'],
      publishedPackageSmokeGate: {
        status: 'required',
        script: 'pnpm run release:published-smoke',
        reason: 'Run the published package smoke after the npm package is published.',
        configSource: 'release-policy',
        packageName: '@kaelio/ktx',
        version: PUBLIC_NPM_PACKAGE_VERSION,
        registry: null,
      },
      npmPublish: {
        packageName: '@kaelio/ktx',
        version: PUBLIC_NPM_PACKAGE_VERSION,
        access: 'public',
        tag: 'latest',
        registry: null,
      },
      blockedPublishingDecisions: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Add this validation test:

```js
it('rejects npm public release ready mode when npm publish is disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ktx-npm-public-ready-disabled-test-'));
  try {
    await writeReadyFixture(root, {
      policy: releasePolicy({
        releaseMode: 'npm-public-release-ready',
        npm: {
          publish: false,
          registry: null,
          access: 'public',
          tag: 'latest',
        },
        publishedPackageSmoke: {
          packageName: '@kaelio/ktx',
          version: PUBLIC_NPM_PACKAGE_VERSION,
          registry: null,
        },
        requiredBeforePublishing: [],
      }),
    });

    await assert.rejects(
      () => releaseReadinessReport(root),
      /npm-public-release-ready policy requires npm.publish true/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Add this validation test:

```js
it('rejects npm public release ready mode when Python publishing is enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ktx-npm-public-ready-python-test-'));
  try {
    await writeReadyFixture(root, {
      policy: releasePolicy({
        releaseMode: 'npm-public-release-ready',
        npm: {
          publish: true,
          registry: null,
          access: 'public',
          tag: 'latest',
        },
        python: {
          publish: true,
          repository: 'pypi',
        },
        publishedPackageSmoke: {
          packageName: '@kaelio/ktx',
          version: PUBLIC_NPM_PACKAGE_VERSION,
          registry: null,
        },
        requiredBeforePublishing: [],
      }),
    });

    await assert.rejects(
      () => releaseReadinessReport(root),
      /npm-public-release-ready policy keeps python.publish false/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run release readiness tests to verify failure**

Run:

```bash
node --test scripts/release-readiness.test.mjs
```

Expected: FAIL with `Unsupported release policy releaseMode:
npm-public-release-ready` or missing `npm.access` validation.

- [ ] **Step 3: Implement publish-ready policy validation**

In `scripts/release-readiness.mjs`, import the public package version:

```js
import { PUBLIC_NPM_PACKAGE_VERSION } from './build-public-npm-package.mjs';
```

Add the release mode constant and include it in `SUPPORTED_RELEASE_MODES`:

```js
const NPM_PUBLIC_RELEASE_READY_MODE = 'npm-public-release-ready';
const SUPPORTED_RELEASE_MODES = new Set([
  CI_ARTIFACT_ONLY_RELEASE_MODE,
  PUBLISHED_PACKAGE_SMOKE_REQUIRED_RELEASE_MODE,
  NPM_PUBLIC_RELEASE_READY_MODE,
]);
```

Add string validators for the npm publish settings:

```js
function assertNpmAccess(value) {
  if (value !== 'public') {
    throw new Error('Release policy npm.access must be public');
  }
}

function assertNpmTag(value) {
  assertString(value, 'Release policy npm.tag');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid Release policy npm.tag: ${value}`);
  }
}
```

In `validateReleasePolicy`, validate the new npm fields after
`assertNullableString(policy.npm.registry, 'Release policy npm.registry');`:

```js
  assertNpmAccess(policy.npm.access);
  assertNpmTag(policy.npm.tag);
```

Replace `assertRequiredBeforePublishing` with:

```js
function assertRequiredBeforePublishing(policy) {
  assertStringArray(policy.requiredBeforePublishing, 'Release policy requiredBeforePublishing');

  if (policy.releaseMode === CI_ARTIFACT_ONLY_RELEASE_MODE && policy.requiredBeforePublishing.length === 0) {
    throw new Error('Release policy requiredBeforePublishing must list the remaining publishing decisions');
  }

  if (
    (policy.releaseMode === PUBLISHED_PACKAGE_SMOKE_REQUIRED_RELEASE_MODE ||
      policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE) &&
    policy.requiredBeforePublishing.length > 0
  ) {
    throw new Error(`${policy.releaseMode} release mode requires requiredBeforePublishing to be empty`);
  }
}
```

Replace `publishedPackageSmokeGate` with:

```js
function publishedPackageSmokeGate(policy) {
  const config = readPublishedPackageSmokeConfig({}, [], policy.publishedPackageSmoke);

  if (
    (policy.releaseMode === PUBLISHED_PACKAGE_SMOKE_REQUIRED_RELEASE_MODE ||
      policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE) &&
    !config.enabled
  ) {
    throw new Error(`${policy.releaseMode} release mode requires release-policy.json publishedPackageSmoke.packageName`);
  }

  const base =
    policy.releaseMode === CI_ARTIFACT_ONLY_RELEASE_MODE
      ? {
          status: 'not_required',
          reason: 'Published package smoke remains pending until release-policy.json enables npm registry publishing.',
        }
      : policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE
        ? {
            status: 'required',
            reason: 'Run the published package smoke after the npm package is published.',
          }
        : {
            status: 'required',
            reason: 'Run the published package smoke before accepting the hybrid-search release.',
          };

  return {
    ...base,
    script: 'pnpm run release:published-smoke',
    configSource: config.enabled ? config.configSource : null,
    packageName: config.enabled ? config.packageName : null,
    version: config.enabled ? config.packageVersion : policy.publishedPackageSmoke.version,
    registry: config.enabled ? (config.registry ?? null) : policy.publishedPackageSmoke.registry,
  };
}
```

Add this function below `assertNonPublishingArtifactPolicy`:

```js
function assertNpmPublicReleaseReadyPolicy(policy, metadata) {
  if (policy.npm.publish !== true) {
    throw new Error('npm-public-release-ready policy requires npm.publish true');
  }
  if (policy.python.publish !== false) {
    throw new Error('npm-public-release-ready policy keeps python.publish false');
  }
  if (policy.python.repository !== null) {
    throw new Error('npm-public-release-ready policy keeps python.repository null');
  }

  assertSameMembers(policy.npm.packages, ['@kaelio/ktx'], 'Release policy npm.packages');
  assertSameMembers(policy.python.packages, metadataNames(metadata, 'python'), 'Release policy python.packages');

  const npmMetadata = metadata.find((entry) => entry.ecosystem === 'npm' && entry.packageName === '@kaelio/ktx');
  if (!npmMetadata) {
    throw new Error('npm-public-release-ready policy requires @kaelio/ktx artifact metadata');
  }
  if (npmMetadata.private !== false) {
    throw new Error('npm-public-release-ready policy requires @kaelio/ktx to be publishable');
  }
  if (npmMetadata.packageVersion !== PUBLIC_NPM_PACKAGE_VERSION) {
    throw new Error(
      `npm-public-release-ready policy expected @kaelio/ktx ${PUBLIC_NPM_PACKAGE_VERSION}, got ${npmMetadata.packageVersion}`,
    );
  }
  if (policy.publishedPackageSmoke.packageName !== '@kaelio/ktx') {
    throw new Error('npm-public-release-ready policy requires publishedPackageSmoke.packageName @kaelio/ktx');
  }
  if (policy.publishedPackageSmoke.version !== PUBLIC_NPM_PACKAGE_VERSION) {
    throw new Error(
      `npm-public-release-ready policy requires publishedPackageSmoke.version ${PUBLIC_NPM_PACKAGE_VERSION}`,
    );
  }
}
```

Inside `assertNonPublishingArtifactPolicy`, replace the npm package version
suffix check with public-package-aware validation:

```js
      if (isPublicKtxPackage) {
        if (entry.packageVersion !== PUBLIC_NPM_PACKAGE_VERSION) {
          throw new Error(
            `${policyLabel} npm package @kaelio/ktx must use public version ${PUBLIC_NPM_PACKAGE_VERSION}`,
          );
        }
      } else if (!entry.packageVersion.endsWith('-private')) {
        throw new Error(`${policyLabel} npm package ${entry.packageName} must use a private version suffix`);
      }
```

In `releaseReadinessReport`, replace the unconditional
`assertNonPublishingArtifactPolicy(policy, metadata);` call with:

```js
  if (policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE) {
    assertNpmPublicReleaseReadyPolicy(policy, metadata);
  } else {
    assertNonPublishingArtifactPolicy(policy, metadata);
  }
```

Add `npmPublish` to the returned report:

```js
    npmPublish:
      policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE
        ? {
            packageName: '@kaelio/ktx',
            version: PUBLIC_NPM_PACKAGE_VERSION,
            access: policy.npm.access,
            tag: policy.npm.tag,
            registry: policy.npm.registry,
          }
        : null,
```

Update the text output so it prints the npm publish target when present:

```js
  if (report.npmPublish) {
    process.stdout.write(
      `NPM publish target: ${report.npmPublish.packageName}@${report.npmPublish.version} (${report.npmPublish.tag})\n`,
    );
  } else {
    process.stdout.write('Registry publishing remains disabled by release-policy.json.\n');
  }
```

- [ ] **Step 4: Update release policy**

Replace `release-policy.json` with:

```json
{
  "schemaVersion": 1,
  "releaseMode": "npm-public-release-ready",
  "npm": {
    "publish": true,
    "registry": null,
    "access": "public",
    "tag": "latest",
    "packages": ["@kaelio/ktx"]
  },
  "python": {
    "publish": false,
    "repository": null,
    "packages": ["ktx-sl", "ktx-daemon", "kaelio-ktx"]
  },
  "publishedPackageSmoke": {
    "packageName": "@kaelio/ktx",
    "version": "0.1.0",
    "registry": null
  },
  "requiredBeforePublishing": []
}
```

- [ ] **Step 5: Run release readiness tests to verify pass**

Run:

```bash
node --test scripts/release-readiness.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit release policy validation**

Run:

```bash
git add scripts/release-readiness.mjs scripts/release-readiness.test.mjs release-policy.json
git commit -m "release: add npm public release policy"
```

Expected: commit created.

### Task 3: Add guarded npm publish script

**Files:**

- Create: `scripts/publish-public-npm-package.test.mjs`
- Create: `scripts/publish-public-npm-package.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing publish script tests**

Create `scripts/publish-public-npm-package.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  buildNpmPublishCommand,
  requireNpmPublicReleaseReady,
  resolvePublishMode,
} from './publish-public-npm-package.mjs';

const readyReport = {
  releaseMode: 'npm-public-release-ready',
  npmPublishEnabled: true,
  npmPublish: {
    packageName: '@kaelio/ktx',
    version: '0.1.0',
    access: 'public',
    tag: 'latest',
    registry: null,
  },
};

describe('resolvePublishMode', () => {
  it('dry-runs by default', () => {
    assert.deepEqual(resolvePublishMode([]), { live: false });
  });

  it('requires an explicit flag for live publish', () => {
    assert.deepEqual(resolvePublishMode(['--publish']), { live: true });
  });
});

describe('requireNpmPublicReleaseReady', () => {
  it('accepts the npm public release ready report', () => {
    assert.equal(requireNpmPublicReleaseReady(readyReport), readyReport.npmPublish);
  });

  it('rejects artifact-only reports', () => {
    assert.throws(
      () =>
        requireNpmPublicReleaseReady({
          releaseMode: 'ci-artifact-only',
          npmPublishEnabled: false,
          npmPublish: null,
        }),
      /release-policy.json must use npm-public-release-ready before publishing/,
    );
  });
});

describe('buildNpmPublishCommand', () => {
  it('builds a dry-run pnpm publish command by default', () => {
    assert.deepEqual(buildNpmPublishCommand('/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0.tgz', readyReport.npmPublish, { live: false }), {
      command: 'pnpm',
      args: [
        'publish',
        '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0.tgz',
        '--access',
        'public',
        '--tag',
        'latest',
        '--dry-run',
      ],
      env: {},
    });
  });

  it('omits dry-run only for explicit live publish', () => {
    assert.deepEqual(buildNpmPublishCommand('/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0.tgz', readyReport.npmPublish, { live: true }).args, [
      'publish',
      '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0.tgz',
      '--access',
      'public',
      '--tag',
      'latest',
    ]);
  });

  it('uses npm_config_registry when a registry is configured', () => {
    const publish = {
      ...readyReport.npmPublish,
      registry: 'https://registry.npmjs.org/',
    };

    assert.deepEqual(
      buildNpmPublishCommand('/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0.tgz', publish, { live: false }).env,
      { npm_config_registry: 'https://registry.npmjs.org/' },
    );
  });
});

describe('package script', () => {
  it('registers release:npm-publish', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.equal(packageJson.scripts['release:npm-publish'], 'node scripts/publish-public-npm-package.mjs');
  });
});
```

- [ ] **Step 2: Run publish script tests to verify failure**

Run:

```bash
node --test scripts/publish-public-npm-package.test.mjs
```

Expected: FAIL with `Cannot find module` for
`scripts/publish-public-npm-package.mjs`.

- [ ] **Step 3: Implement publish script**

Create `scripts/publish-public-npm-package.mjs` with:

```js
#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { packageArtifactLayout } from './package-artifacts.mjs';
import { releaseReadinessReport } from './release-readiness.mjs';

const execFileAsync = promisify(execFile);

export function resolvePublishMode(args = process.argv.slice(2)) {
  return { live: args.includes('--publish') };
}

export function requireNpmPublicReleaseReady(report) {
  if (report.releaseMode !== 'npm-public-release-ready' || report.npmPublishEnabled !== true || !report.npmPublish) {
    throw new Error('release-policy.json must use npm-public-release-ready before publishing');
  }
  return report.npmPublish;
}

export function buildNpmPublishCommand(tarballPath, publish, mode) {
  return {
    command: 'pnpm',
    args: [
      'publish',
      tarballPath,
      '--access',
      publish.access,
      '--tag',
      publish.tag,
      ...(mode.live ? [] : ['--dry-run']),
    ],
    env: publish.registry ? { npm_config_registry: publish.registry } : {},
  };
}

async function assertFileExists(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing npm tarball: ${path}. Run pnpm run artifacts:check first.`);
  }
}

async function runPublishCommand(command) {
  process.stdout.write(`$ ${command.command} ${command.args.join(' ')}\n`);
  await execFileAsync(command.command, command.args, {
    env: { ...process.env, ...command.env },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
}

export async function publishPublicNpmPackage(options = {}) {
  const rootDir = options.rootDir;
  const mode = options.mode ?? resolvePublishMode(options.args);
  const report = await releaseReadinessReport(rootDir);
  const publish = requireNpmPublicReleaseReady(report);
  const layout = packageArtifactLayout(rootDir);
  const tarballPath = layout.cliTarball;

  await assertFileExists(tarballPath);
  const command = buildNpmPublishCommand(tarballPath, publish, mode);
  await runPublishCommand(command);

  process.stdout.write(
    mode.live
      ? `Published ${publish.packageName}@${publish.version} with tag ${publish.tag}\n`
      : `Dry-run verified ${publish.packageName}@${publish.version} with tag ${publish.tag}\n`,
  );
}

async function main() {
  await publishPublicNpmPackage({ args: process.argv.slice(2) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Add the package script**

In root `package.json`, add this script after `release:local-embeddings-smoke`:

```json
"release:npm-publish": "node scripts/publish-public-npm-package.mjs",
```

- [ ] **Step 5: Run publish script tests to verify pass**

Run:

```bash
node --test scripts/publish-public-npm-package.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Run a dry-run publish after artifacts are built**

Run:

```bash
pnpm run artifacts:check
pnpm run release:npm-publish
```

Expected: PASS. The publish command includes `--dry-run`, and the final line is:

```text
Dry-run verified @kaelio/ktx@0.1.0 with tag latest
```

- [ ] **Step 7: Commit publish script**

Run:

```bash
git add scripts/publish-public-npm-package.mjs scripts/publish-public-npm-package.test.mjs package.json
git commit -m "release: add guarded npm publish script"
```

Expected: commit created.

### Task 4: Add manual release workflow and docs

**Files:**

- Create: `.github/workflows/release.yml`
- Create: `scripts/release-workflow.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Write failing workflow tests**

Create `scripts/release-workflow.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('release workflow', () => {
  it('publishes only from manual dispatch with an explicit live input', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

    assert.match(workflow, /^name: KTX Release$/m);
    assert.match(workflow, /^  workflow_dispatch:$/m);
    assert.match(workflow, /publish_live:/);
    assert.match(workflow, /default: false/);
    assert.match(workflow, /pnpm run artifacts:check/);
    assert.match(workflow, /pnpm run release:readiness/);
    assert.match(workflow, /pnpm run release:npm-publish$/m);
    assert.match(workflow, /pnpm run release:npm-publish -- --publish/);
    assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /^  push:/m);
    assert.doesNotMatch(workflow, /^  pull_request:/m);
  });
});
```

- [ ] **Step 2: Run workflow tests to verify failure**

Run:

```bash
node --test scripts/release-workflow.test.mjs
```

Expected: FAIL because `.github/workflows/release.yml` does not exist.

- [ ] **Step 3: Add the release workflow**

Create `.github/workflows/release.yml` with:

```yaml
name: KTX Release

on:
  workflow_dispatch:
    inputs:
      publish_live:
        description: "Publish @kaelio/ktx to npm instead of running a dry-run"
        required: true
        type: boolean
        default: false

permissions:
  contents: read

concurrency:
  group: ktx-release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  npm-public-release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: Setup pnpm
        uses: pnpm/action-setup@41ff72655975bd51cab0327fa583b6e92b6d3061 # v4.2.0
        with:
          run_install: false

      - name: Setup Node.js
        uses: actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238 # v6.2.0
        with:
          node-version: "24"
          cache: "pnpm"
          cache-dependency-path: "pnpm-lock.yaml"

      - name: Install TypeScript dependencies
        run: pnpm install --frozen-lockfile

      - name: Setup Python
        uses: actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405 # v6.2.0
        with:
          python-version: "3.13"

      - name: Setup uv
        uses: astral-sh/setup-uv@eac588ad8def6316056a12d4907a9d4d84ff7a3b # v7.3.0
        with:
          enable-cache: true
          cache-dependency-glob: "uv.lock"

      - name: Install Python dependencies
        run: uv sync --all-packages

      - name: Build and verify artifacts
        run: pnpm run artifacts:check

      - name: Check release readiness
        run: pnpm run release:readiness

      - name: Dry-run npm publish
        if: ${{ !inputs.publish_live }}
        run: pnpm run release:npm-publish

      - name: Publish npm package
        if: ${{ inputs.publish_live }}
        run: pnpm run release:npm-publish -- --publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 4: Update release docs**

In `README.md`, replace the current `## Release status` section with:

```markdown
## Release status

This repository builds one public npm artifact named `@kaelio/ktx`. The first
public npm handoff is policy-gated through `release-policy.json`, which keeps
Python package publishing disabled because KTX-owned Python code ships inside
the npm package as a bundled wheel.

Build local package artifacts and verify the guarded dry-run publish path with:

```bash
source .venv/bin/activate
pnpm run artifacts:check
pnpm run release:readiness
pnpm run release:npm-publish
```

Run the live npm publish only from the manual `KTX Release` workflow with the
`publish_live` input enabled after the `NPM_TOKEN` secret is configured.
```

- [ ] **Step 5: Run workflow and README checks**

Run:

```bash
node --test scripts/release-workflow.test.mjs scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit workflow and docs**

Run:

```bash
git add .github/workflows/release.yml scripts/release-workflow.test.mjs README.md
git commit -m "release: document public npm release handoff"
```

Expected: commit created.

### Task 5: Final verification

**Files:**

- Verify: `scripts/*.test.mjs`
- Verify: `packages/cli/src/*`
- Verify: `README.md`
- Verify: `release-policy.json`

- [ ] **Step 1: Run focused script tests**

Run:

```bash
node --test scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs scripts/local-embeddings-runtime-smoke.test.mjs scripts/release-readiness.test.mjs scripts/publish-public-npm-package.test.mjs scripts/published-package-smoke.test.mjs scripts/release-workflow.test.mjs scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run workspace type and package checks**

Run:

```bash
pnpm run type-check
pnpm run artifacts:check
```

Expected: PASS. The artifact build creates
`dist/artifacts/npm/kaelio-ktx-0.1.0.tgz`.

- [ ] **Step 3: Run release readiness and dry-run publish**

Run:

```bash
pnpm run release:readiness
pnpm run release:npm-publish
```

Expected: PASS. `release:readiness` prints `KTX release mode:
npm-public-release-ready`, and `release:npm-publish` prints `Dry-run verified
@kaelio/ktx@0.1.0 with tag latest`.

- [ ] **Step 4: Run pre-commit for changed files**

Run:

```bash
uv run pre-commit run --files scripts/build-public-npm-package.mjs scripts/build-public-npm-package.test.mjs scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/local-embeddings-runtime-smoke.test.mjs scripts/release-readiness.mjs scripts/release-readiness.test.mjs scripts/publish-public-npm-package.mjs scripts/publish-public-npm-package.test.mjs scripts/release-workflow.test.mjs release-policy.json package.json README.md .github/workflows/release.yml
```

Expected: PASS. If pre-commit is unavailable because the local `uv` version or
pre-commit environment is missing, report that explicitly and keep the script
tests, `pnpm run type-check`, `pnpm run artifacts:check`, `pnpm run
release:readiness`, and `pnpm run release:npm-publish` results as the closest
checks.

- [ ] **Step 5: Confirm the worktree is clean**

Run:

```bash
git status --short
```

Expected: no output. If there are uncommitted tracked changes, inspect them and
commit only files from this plan with the exact task commit commands above.

## Success criteria

- `@kaelio/ktx` artifact metadata and tarball names use version `0.1.0`.
- `release-policy.json` encodes `npm-public-release-ready`,
  `npm.publish: true`, and `python.publish: false`.
- `pnpm run release:npm-publish` performs a dry-run by default.
- Live npm publishing requires `pnpm run release:npm-publish -- --publish` or
  the manual `KTX Release` workflow with `publish_live` enabled.
- Published-package smoke remains the post-publication proof for `npx
  @kaelio/ktx`, local `npx ktx`, and global `ktx` invocation modes.
- No Python package publication is added for this release.

## Self-review

- Spec coverage: this plan covers the remaining public npm handoff gap while
  preserving the bundled Python wheel model and single npm package surface.
- Placeholder scan: no open placeholders or deferred implementation notes are
  present.
- Type consistency: the release mode name is consistently
  `npm-public-release-ready`; the public npm version is consistently `0.1.0`;
  the publish script consumes the `npmPublish` report shape produced by
  `release-readiness.mjs`.
