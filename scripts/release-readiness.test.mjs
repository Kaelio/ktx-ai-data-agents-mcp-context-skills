import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  INTERNAL_NPM_WORKSPACE_PACKAGES,
  NPM_ARTIFACT_PACKAGES,
  packageArtifactLayout,
  writeArtifactManifest,
} from './package-artifacts.mjs';
import { readReleasePolicy, releasePolicyPath, releaseReadinessReport } from './release-readiness.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeReleaseMetadataInputs(root) {
  for (const packageInfo of INTERNAL_NPM_WORKSPACE_PACKAGES) {
    await mkdir(join(root, packageInfo.packageRoot), { recursive: true });
    await writeJson(join(root, packageInfo.packageRoot, 'package.json'), {
      name: packageInfo.name,
      version: '0.0.0-private',
      private: true,
    });
  }

  await mkdir(join(root, 'python', 'ktx-sl'), { recursive: true });
  await mkdir(join(root, 'python', 'ktx-daemon'), { recursive: true });

  await writeFile(
    join(root, 'python', 'ktx-sl', 'pyproject.toml'),
    ['[project]', 'name = "ktx-sl"', 'version = "0.1.0"', ''].join('\n'),
  );
  await writeFile(
    join(root, 'python', 'ktx-daemon', 'pyproject.toml'),
    ['[project]', 'name = "ktx-daemon"', 'version = "0.1.0"', ''].join('\n'),
  );
}

async function writeUploadableArtifactFixtures(layout) {
  await mkdir(layout.npmDir, { recursive: true });
  await mkdir(layout.pythonDir, { recursive: true });

  const fileContents = new Map([
    ...NPM_ARTIFACT_PACKAGES.map((packageInfo) => [
      layout.npmTarballs[packageInfo.name],
      `${packageInfo.name}-tarball`,
    ]),
    [join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'), 'kaelio-ktx-runtime-wheel'],
    [join(layout.pythonDir, 'ktx_sl-0.1.0-py3-none-any.whl'), 'ktx-sl-wheel'],
    [join(layout.pythonDir, 'ktx_sl-0.1.0.tar.gz'), 'ktx-sl-sdist'],
    [join(layout.pythonDir, 'ktx_daemon-0.1.0-py3-none-any.whl'), 'ktx-daemon-wheel'],
    [join(layout.pythonDir, 'ktx_daemon-0.1.0.tar.gz'), 'ktx-daemon-sdist'],
  ]);

  for (const [path, contents] of fileContents) {
    await writeFile(path, contents);
  }
}

function releasePolicy(overrides = {}) {
  const { npm: npmOverrides = {}, python: pythonOverrides = {}, ...policyOverrides } = overrides;

  return {
    schemaVersion: 1,
    releaseMode: 'ci-artifact-only',
    npm: {
      publish: false,
      registry: null,
      packages: ['@kaelio/ktx'],
      ...npmOverrides,
    },
    python: {
      publish: false,
      repository: null,
      packages: ['ktx-sl', 'ktx-daemon', 'kaelio-ktx'],
      ...pythonOverrides,
    },
    publishedPackageSmoke: {
      packageName: '@kaelio/ktx',
      version: 'latest',
      registry: null,
    },
    requiredBeforePublishing: [
      'Choose public release version.',
      'Configure registry credentials outside source control.',
      'Choose release tag and provenance policy.',
    ],
    ...policyOverrides,
  };
}

async function writePolicy(root, policy = releasePolicy()) {
  await writeJson(releasePolicyPath(root), policy);
}

async function writeReadyFixture(root, options = {}) {
  await writeReleaseMetadataInputs(root);
  await writePolicy(root, options.policy ?? releasePolicy());
  const layout = packageArtifactLayout(root);
  await writeUploadableArtifactFixtures(layout);
  await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
    sourceRevision: 'abc123',
  });
  return layout;
}

describe('release readiness policy', () => {
  it('reads the checked release policy path from the KTX root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-policy-test-'));
    try {
      const policy = releasePolicy();
      await writePolicy(root, policy);

      assert.equal(releasePolicyPath(root), join(root, 'release-policy.json'));
      assert.deepEqual(await readReleasePolicy(root), policy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts the current ci-artifact-only policy, package metadata, and artifact manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-ready-test-'));
    try {
      await writeReadyFixture(root);

      const report = await releaseReadinessReport(root);

      assert.deepEqual(report, {
        schemaVersion: 1,
        releaseMode: 'ci-artifact-only',
        sourceRevision: 'abc123',
        npmPublishEnabled: false,
        pythonPublishEnabled: false,
        packageNames: ['@kaelio/ktx', 'ktx-sl', 'ktx-daemon', 'kaelio-ktx'],
        publishedPackageSmokeGate: {
          status: 'not_required',
          script: 'pnpm run release:published-smoke',
          reason: 'Published package smoke remains pending until release-policy.json enables npm registry publishing.',
          configSource: 'release-policy',
          packageName: '@kaelio/ktx',
          version: 'latest',
          registry: null,
        },
        blockedPublishingDecisions: [
          'Choose public release version.',
          'Configure registry credentials outside source control.',
          'Choose release tag and provenance policy.',
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports policy-controlled published package smoke config when present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-smoke-config-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          publishedPackageSmoke: {
            packageName: '@kaelio/ktx',
            version: '2026.5.8',
            registry: 'https://registry.npmjs.org/',
          },
        }),
      });

      const report = await releaseReadinessReport(root);

      assert.deepEqual(report.publishedPackageSmokeGate, {
        status: 'not_required',
        script: 'pnpm run release:published-smoke',
        reason: 'Published package smoke remains pending until release-policy.json enables npm registry publishing.',
        configSource: 'release-policy',
        packageName: '@kaelio/ktx',
        version: '2026.5.8',
        registry: 'https://registry.npmjs.org/',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports required published package smoke when release mode requires it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-smoke-required-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          releaseMode: 'published-package-smoke-required',
          publishedPackageSmoke: {
            packageName: '@kaelio/ktx',
            version: '2026.5.8',
            registry: 'https://registry.npmjs.org/',
          },
          requiredBeforePublishing: [],
        }),
      });

      const report = await releaseReadinessReport(root);

      assert.deepEqual(report, {
        schemaVersion: 1,
        releaseMode: 'published-package-smoke-required',
        sourceRevision: 'abc123',
        npmPublishEnabled: false,
        pythonPublishEnabled: false,
        packageNames: ['@kaelio/ktx', 'ktx-sl', 'ktx-daemon', 'kaelio-ktx'],
        publishedPackageSmokeGate: {
          status: 'required',
          script: 'pnpm run release:published-smoke',
          reason: 'Run the published package smoke before accepting the hybrid-search release.',
          configSource: 'release-policy',
          packageName: '@kaelio/ktx',
          version: '2026.5.8',
          registry: 'https://registry.npmjs.org/',
        },
        blockedPublishingDecisions: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects required published smoke mode without a package name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-smoke-required-missing-config-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          releaseMode: 'published-package-smoke-required',
          publishedPackageSmoke: {
            packageName: null,
            version: 'latest',
            registry: null,
          },
          requiredBeforePublishing: [],
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /published-package-smoke-required release mode requires release-policy\.json publishedPackageSmoke\.packageName/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects required published smoke mode while publishing decisions remain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-smoke-required-blocked-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          releaseMode: 'published-package-smoke-required',
          publishedPackageSmoke: {
            packageName: '@kaelio/ktx',
            version: 'latest',
            registry: null,
          },
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /published-package-smoke-required release mode requires requiredBeforePublishing to be empty/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unsupported release modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-unsupported-mode-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          releaseMode: 'experimental-publish',
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /Unsupported release policy releaseMode: experimental-publish/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects publish-enabled npm policy while releaseMode is ci-artifact-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-npm-publish-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          npm: { publish: true, registry: 'https://registry.npmjs.org/' },
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /ci-artifact-only policy must keep npm.publish false/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects publish-enabled Python policy while releaseMode is ci-artifact-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-python-publish-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          python: { publish: true, repository: 'pypi' },
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /ci-artifact-only policy must keep python.publish false/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe release-policy published package smoke config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-smoke-invalid-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          publishedPackageSmoke: {
            packageName: '@ktx/cli public',
            version: 'latest',
            registry: null,
          },
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /Invalid release-policy\.json publishedPackageSmoke\.packageName/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects release policy that still lists internal npm packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-stale-internal-npm-policy-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          npm: {
            packages: ['@kaelio/ktx', '@ktx/context'],
          },
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /Release policy npm\.packages mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale artifacts before reporting release readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-stale-artifact-test-'));
    try {
      const layout = await writeReadyFixture(root);
      await writeFile(layout.cliTarball, 'changed-cli-tarball');

      await assert.rejects(
        () => releaseReadinessReport(root),
        /Artifact manifest files do not match artifact contents/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
