import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  analyzeCommits,
  parseSemver,
  stableBaseVersion,
  verifyRelease,
} = require('./semantic-release-version-policy.cjs');

async function writePolicy(root, version) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'release-policy.json'),
    `${JSON.stringify({ publicNpmPackageVersion: version }, null, 2)}\n`,
  );
}

function releaseContext(root, overrides = {}) {
  return {
    cwd: root,
    env: { KTX_RELEASE_KIND: 'stable' },
    lastRelease: {},
    logger: { log() {} },
    nextRelease: {
      version: '1.0.0',
      gitTag: 'v1.0.0',
      name: 'v1.0.0',
    },
    options: { tagFormat: 'v${version}' },
    ...overrides,
  };
}

describe('semantic-release version policy', () => {
  it('parses semver versions used by public release metadata', () => {
    assert.deepEqual(parseSemver('0.1.0-rc.6'), {
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: 'rc.6',
    });
    assert.equal(stableBaseVersion('0.1.0-rc.6'), '0.1.0');
  });

  it('uses the temporary stable release floor to make 0.1.0 a minor release', async () => {
    const context = releaseContext('/repo/ktx', {
      env: {
        KTX_RELEASE_KIND: 'stable',
        KTX_STABLE_RELEASE_FLOOR_TAG: 'v0.0.0',
      },
      lastRelease: {
        version: '0.0.0',
        gitTag: 'v0.0.0',
      },
    });

    assert.equal(analyzeCommits({}, context), 'minor');
  });

  it('accepts the first stable release from the current public rc base version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-version-policy-'));
    try {
      await writePolicy(root, '0.1.0-rc.6');
      const context = releaseContext(root, {
        env: {
          KTX_RELEASE_KIND: 'stable',
          KTX_STABLE_RELEASE_FLOOR_TAG: 'v0.0.0',
        },
        lastRelease: {
          version: '0.0.0',
          gitTag: 'v0.0.0',
        },
        nextRelease: {
          version: '0.1.0',
          gitTag: 'v0.1.0',
          name: 'v0.1.0',
        },
      });

      verifyRelease({}, context);

      assert.equal(context.nextRelease.version, '0.1.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects automatic major releases until release metadata is manually advanced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-version-policy-'));
    try {
      await writePolicy(root, '0.1.0');
      const context = releaseContext(root, {
        lastRelease: { gitTag: 'v0.1.0' },
      });

      assert.throws(() => verifyRelease({}, context), /Refusing automatic major release 1\.0\.0/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows major releases when release metadata was manually advanced first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-version-policy-'));
    try {
      await writePolicy(root, '1.0.0');
      const context = releaseContext(root, {
        lastRelease: { gitTag: 'v0.1.0' },
      });

      verifyRelease({}, context);

      assert.equal(context.nextRelease.version, '1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
