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
    version: '0.1.0-rc.1',
    access: 'public',
    tag: 'next',
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
  it('builds a dry-run npm publish command by default', () => {
    assert.deepEqual(
      buildNpmPublishCommand('/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0-rc.1.tgz', readyReport.npmPublish, {
        live: false,
      }),
      {
        command: 'npm',
        args: [
          'publish',
          '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0-rc.1.tgz',
          '--access',
          'public',
          '--tag',
          'next',
          '--dry-run',
        ],
        env: {},
      },
    );
  });

  it('omits dry-run only for explicit live publish', () => {
    assert.deepEqual(
      buildNpmPublishCommand('/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0-rc.1.tgz', readyReport.npmPublish, {
        live: true,
      }).args,
      [
        'publish',
        '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0-rc.1.tgz',
        '--access',
        'public',
        '--tag',
        'next',
      ],
    );
  });

  it('uses npm_config_registry when a registry is configured', () => {
    const publish = {
      ...readyReport.npmPublish,
      registry: 'https://registry.npmjs.org/',
    };

    assert.deepEqual(
      buildNpmPublishCommand('/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0-rc.1.tgz', publish, { live: false }).env,
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
