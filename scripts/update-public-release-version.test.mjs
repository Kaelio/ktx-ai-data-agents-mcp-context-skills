import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { updatePublicReleaseVersion } from './update-public-release-version.mjs';

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeReleaseFixture(root) {
  await writeJson(join(root, 'package.json'), {
    name: 'ktx-workspace',
    version: '0.0.0-private',
    private: true,
  });
  await writeJson(join(root, 'packages', 'cli', 'package.json'), {
    name: '@ktx/cli',
    version: '0.0.0-private',
    private: true,
  });
  await writeJson(join(root, 'release-policy.json'), {
    schemaVersion: 1,
    publicNpmPackageVersion: '0.1.0-rc.1',
    releaseMode: 'ci-artifact-only',
    npm: {
      publish: false,
      registry: null,
      access: 'public',
      tag: 'next',
      packages: ['@kaelio/ktx'],
    },
    python: {
      publish: false,
      repository: null,
      packages: ['kaelio-ktx'],
    },
    publishedPackageSmoke: {
      packageName: '@kaelio/ktx',
      version: '0.1.0-rc.1',
      registry: null,
    },
    runtimeInstaller: {
      uvStrategy: 'path-prerequisite',
      bootstrapUv: false,
      missingUvBehavior: 'focused-error',
    },
    requiredBeforePublishing: ['Choose public release version.'],
  });
}

describe('updatePublicReleaseVersion', () => {
  it('updates package and release policy metadata for rc releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-version-test-'));
    try {
      await writeReleaseFixture(root);

      await updatePublicReleaseVersion(root, '0.1.0-rc.2', 'next');

      assert.equal((await readJson(join(root, 'package.json'))).version, '0.1.0-rc.2');
      assert.equal((await readJson(join(root, 'packages', 'cli', 'package.json'))).version, '0.1.0-rc.2');
      assert.deepEqual(await readJson(join(root, 'release-policy.json')), {
        schemaVersion: 1,
        publicNpmPackageVersion: '0.1.0-rc.2',
        releaseMode: 'npm-public-release-ready',
        npm: {
          publish: true,
          registry: null,
          access: 'public',
          tag: 'next',
          packages: ['@kaelio/ktx'],
        },
        python: {
          publish: false,
          repository: null,
          packages: ['kaelio-ktx'],
        },
        publishedPackageSmoke: {
          packageName: '@kaelio/ktx',
          version: '0.1.0-rc.2',
          registry: null,
        },
        runtimeInstaller: {
          uvStrategy: 'path-prerequisite',
          bootstrapUv: false,
          missingUvBehavior: 'focused-error',
        },
        requiredBeforePublishing: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts branch-prefixed npm release tags produced by branch RC publishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-version-branch-test-'));
    try {
      await writeReleaseFixture(root);

      await updatePublicReleaseVersion(root, '0.1.0-feature-foo.0', 'branch-feature-foo');

      assert.equal((await readJson(join(root, 'package.json'))).version, '0.1.0-feature-foo.0');
      assert.equal(
        (await readJson(join(root, 'packages', 'cli', 'package.json'))).version,
        '0.1.0-feature-foo.0',
      );
      const policy = await readJson(join(root, 'release-policy.json'));
      assert.equal(policy.publicNpmPackageVersion, '0.1.0-feature-foo.0');
      assert.equal(policy.npm.tag, 'branch-feature-foo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid versions and tags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-version-invalid-test-'));
    try {
      await writeReleaseFixture(root);

      await assert.rejects(() => updatePublicReleaseVersion(root, 'not a version', 'next'), /Invalid public npm package version/);
      await assert.rejects(() => updatePublicReleaseVersion(root, '0.2.0', 'canary'), /Invalid public npm release tag/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
