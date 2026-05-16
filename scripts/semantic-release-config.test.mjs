import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { createReleaseConfig, releaseBranches, releaseKind, releaseTag } = require('./semantic-release-config.cjs');

function releaseExecOptions(config) {
  return config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].prepareCmd)[1];
}

describe('semantic-release config', () => {
  it('configures manual rc releases on the selected branch with next channel', () => {
    assert.equal(releaseKind({ KTX_RELEASE_KIND: 'rc' }), 'rc');
    assert.equal(releaseTag('rc'), 'next');
    assert.deepEqual(releaseBranches({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'release-candidate' }), [
      { name: 'release-candidate', prerelease: 'rc', channel: 'next' },
    ]);

    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'release-candidate' });
    assert.match(
      releaseExecOptions(config).prepareCmd,
      /update-public-release-version\.mjs "\$\{nextRelease\.version\}" "next"/,
    );
  });

  it('configures stable releases only from main with latest tag', () => {
    assert.equal(releaseKind({ KTX_RELEASE_KIND: 'stable' }), 'stable');
    assert.equal(releaseTag('stable'), 'latest');
    assert.deepEqual(releaseBranches({ KTX_RELEASE_KIND: 'stable', GITHUB_REF_NAME: 'main' }), ['main']);

    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'stable', GITHUB_REF_NAME: 'main' });
    assert.match(
      releaseExecOptions(config).prepareCmd,
      /update-public-release-version\.mjs "\$\{nextRelease\.version\}" "latest"/,
    );
  });

  it('rejects stable releases from non-main branches', () => {
    assert.throws(
      () => releaseBranches({ KTX_RELEASE_KIND: 'stable', GITHUB_REF_NAME: 'feature/release-test' }),
      /Stable KTX releases must run from main, got feature\/release-test/,
    );
  });

  it('keeps the force-release patch escape hatch', () => {
    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'main' });
    const analyzeExec = config.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].analyzeCommitsCmd,
    );
    assert.match(analyzeExec[1].analyzeCommitsCmd, /FORCE_RELEASE === 'true' \? 'patch' : ''/);
  });
});
