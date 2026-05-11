import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  buildPublishedPackageNpxCommand,
  buildPublishedPackageSmokeCommands,
  isPublishedPackageSemanticQueryLabel,
  isPublishedPackageVersionLabel,
  publishedPackageSpec,
  readPublishedPackageSmokeConfig,
} from './published-package-smoke.mjs';

describe('published package smoke config', () => {
  it('skips by default until a published package name is supplied', () => {
    assert.deepEqual(readPublishedPackageSmokeConfig({}, []), {
      enabled: false,
      requireConfig: false,
      reason:
        'Set KTX_PUBLISHED_KTX_PACKAGE or release-policy.json publishedPackageSmoke.packageName to the published npm package name after the release decision.',
    });
  });

  it('can require the published package config for post-publication CI', () => {
    assert.deepEqual(readPublishedPackageSmokeConfig({}, ['--require-config']), {
      enabled: false,
      requireConfig: true,
      reason:
        'Set KTX_PUBLISHED_KTX_PACKAGE or release-policy.json publishedPackageSmoke.packageName to the published npm package name after the release decision.',
    });
  });

  it('reads the package, version, and registry from environment variables', () => {
    assert.deepEqual(
      readPublishedPackageSmokeConfig(
        {
          KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx',
          KTX_PUBLISHED_KTX_VERSION: 'latest',
          KTX_PUBLISHED_KTX_REGISTRY: 'https://registry.npmjs.org/',
        },
        [],
      ),
      {
        enabled: true,
        requireConfig: false,
        configSource: 'environment',
        packageName: '@kaelio/ktx',
        packageVersion: 'latest',
        registry: 'https://registry.npmjs.org/',
      },
    );
  });

  it('reads the package, version, and registry from release policy when env vars are absent', () => {
    assert.deepEqual(
      readPublishedPackageSmokeConfig(
        {},
        [],
        {
          packageName: '@kaelio/ktx',
          version: '2026.5.8',
          registry: 'https://registry.npmjs.org/',
        },
      ),
      {
        enabled: true,
        requireConfig: false,
        configSource: 'release-policy',
        packageName: '@kaelio/ktx',
        packageVersion: '2026.5.8',
        registry: 'https://registry.npmjs.org/',
      },
    );
  });

  it('lets environment variables override release policy values', () => {
    assert.deepEqual(
      readPublishedPackageSmokeConfig(
        {
          KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx',
          KTX_PUBLISHED_KTX_VERSION: 'latest',
        },
        [],
        {
          packageName: '@kaelio/ktx',
          version: '2026.5.8',
          registry: 'https://registry.npmjs.org/',
        },
      ),
      {
        enabled: true,
        requireConfig: false,
        configSource: 'environment',
        packageName: '@kaelio/ktx',
        packageVersion: 'latest',
        registry: 'https://registry.npmjs.org/',
      },
    );
  });

  it('rejects package names that would be unsafe as npx package specs', () => {
    assert.throws(
      () => readPublishedPackageSmokeConfig({ KTX_PUBLISHED_KTX_PACKAGE: '--package=@evil/pkg' }, []),
      /Invalid KTX_PUBLISHED_KTX_PACKAGE/,
    );
    assert.throws(
      () => readPublishedPackageSmokeConfig({ KTX_PUBLISHED_KTX_PACKAGE: '@ktx/cli public' }, []),
      /Invalid KTX_PUBLISHED_KTX_PACKAGE/,
    );
    assert.throws(
      () =>
        readPublishedPackageSmokeConfig(
          {},
          [],
          {
            packageName: '@ktx/cli public',
            version: 'latest',
            registry: null,
          },
        ),
      /Invalid release-policy\.json publishedPackageSmoke\.packageName/,
    );
  });

  it('rejects unsafe version tags and non-HTTP registries', () => {
    assert.throws(
      () =>
        readPublishedPackageSmokeConfig(
          {
            KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx',
            KTX_PUBLISHED_KTX_VERSION: '--tag latest',
          },
          [],
        ),
      /Invalid KTX_PUBLISHED_KTX_VERSION/,
    );
    assert.throws(
      () =>
        readPublishedPackageSmokeConfig(
          {
            KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx',
            KTX_PUBLISHED_KTX_REGISTRY: 'file:///tmp/npm',
          },
          [],
        ),
      /KTX_PUBLISHED_KTX_REGISTRY must be an http\(s\) URL/,
    );
  });
});

describe('published package smoke output validation labels', () => {
  it('classifies version and semantic query commands', () => {
    assert.equal(isPublishedPackageVersionLabel('published package npx version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package local version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package global version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package setup demo'), false);

    assert.equal(isPublishedPackageSemanticQueryLabel('published package npx sl query'), true);
    assert.equal(isPublishedPackageSemanticQueryLabel('published package local sl query'), true);
    assert.equal(isPublishedPackageSemanticQueryLabel('published package global sl query'), true);
    assert.equal(isPublishedPackageSemanticQueryLabel('published package local install'), false);
  });
});

describe('published package smoke command construction', () => {
  const config = {
    enabled: true,
    requireConfig: false,
    packageName: '@kaelio/ktx',
    packageVersion: 'latest',
    registry: 'https://registry.npmjs.org/',
  };

  it('builds the npx package spec from package name and version tag', () => {
    assert.equal(publishedPackageSpec(config), '@kaelio/ktx@latest');
  });

  it('builds npx commands with a registry env patch instead of shell interpolation', () => {
    assert.deepEqual(buildPublishedPackageNpxCommand(config, ['--version']), {
      label: 'published package command',
      command: 'npx',
      args: ['--yes', '@kaelio/ktx@latest', '--version'],
      env: { npm_config_registry: 'https://registry.npmjs.org/' },
    });
  });

  it('builds the full public package smoke command list', () => {
    assert.deepEqual(
      buildPublishedPackageSmokeCommands(
        config,
        '/tmp/ktx-smoke/demo',
        '/tmp/ktx-smoke/managed-runtime',
      ),
      [
        {
          label: 'published package npx version',
          command: 'npx',
          args: ['--yes', '@kaelio/ktx@latest', '--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package setup demo',
          command: 'npx',
          args: [
            '--yes',
            '@kaelio/ktx@latest',
            'setup',
            'demo',
            '--project-dir',
            '/tmp/ktx-smoke/demo',
            '--no-input',
            '--plain',
          ],
          env: {
            npm_config_registry: 'https://registry.npmjs.org/',
            KTX_RUNTIME_ROOT: '/tmp/ktx-smoke/managed-runtime',
          },
        },
        {
          label: 'published package npx sl query',
          command: 'npx',
          args: [
            '--yes',
            '@kaelio/ktx@latest',
            'sl',
            'query',
            '--project-dir',
            '/tmp/ktx-smoke/demo',
            '--connection-id',
            'orbit_demo',
            '--measure',
            'contracts.contract_count',
            '--format',
            'sql',
            '--yes',
          ],
          env: {
            npm_config_registry: 'https://registry.npmjs.org/',
            KTX_RUNTIME_ROOT: '/tmp/ktx-smoke/managed-runtime',
          },
        },
        {
          label: 'published package local install',
          command: 'pnpm',
          args: ['add', '@kaelio/ktx@latest'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package local version',
          command: 'npx',
          args: ['ktx', '--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package local sl query',
          command: 'npx',
          args: [
            'ktx',
            'sl',
            'query',
            '--project-dir',
            '/tmp/ktx-smoke/demo',
            '--connection-id',
            'orbit_demo',
            '--measure',
            'contracts.contract_count',
            '--format',
            'sql',
            '--yes',
          ],
          env: {
            npm_config_registry: 'https://registry.npmjs.org/',
            KTX_RUNTIME_ROOT: '/tmp/ktx-smoke/managed-runtime',
          },
        },
        {
          label: 'published package global install',
          command: 'pnpm',
          args: ['add', '--global', '@kaelio/ktx@latest'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package global version',
          command: 'ktx',
          args: ['--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package global sl query',
          command: 'ktx',
          args: [
            'sl',
            'query',
            '--project-dir',
            '/tmp/ktx-smoke/demo',
            '--connection-id',
            'orbit_demo',
            '--measure',
            'contracts.contract_count',
            '--format',
            'sql',
            '--yes',
          ],
          env: {
            npm_config_registry: 'https://registry.npmjs.org/',
            KTX_RUNTIME_ROOT: '/tmp/ktx-smoke/managed-runtime',
          },
        },
      ],
    );
  });

  it('exposes the smoke through the package release script', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.equal(
      packageJson.scripts['release:published-smoke'],
      'node scripts/published-package-smoke.mjs --require-config',
    );
  });
});
