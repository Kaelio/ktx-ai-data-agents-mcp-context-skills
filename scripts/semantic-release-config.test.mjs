import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { createReleaseConfig, releaseBranches, releaseKind, releaseTag } = require('./semantic-release-config.cjs');

function releaseExecOptions(config) {
  return config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].prepareCmd)[1];
}

function releaseExecIndex(config) {
  return config.plugins.findIndex((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].prepareCmd);
}

function pluginNames(config) {
  return config.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
}

describe('semantic-release config', () => {
  it('configures rc releases on a dedicated next prerelease branch', () => {
    assert.equal(releaseKind({ KTX_RELEASE_KIND: 'rc' }), 'rc');
    assert.equal(releaseTag('rc'), 'next');
    assert.deepEqual(releaseBranches({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'main' }), [
      'main',
      { name: 'next', prerelease: 'rc', channel: 'next' },
    ]);

    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'main' });
    assert.match(
      releaseExecOptions(config).prepareCmd,
      /update-public-release-version\.mjs "\$\{nextRelease\.version\}" "next"/,
    );
    const releaseFilePluginNames = pluginNames(config).filter(
      (plugin) => plugin === '@semantic-release/changelog' || plugin === '@semantic-release/git',
    );
    assert.deepEqual(releaseFilePluginNames, ['@semantic-release/changelog', '@semantic-release/git']);

    const names = pluginNames(config);
    assert.ok(names.indexOf('@semantic-release/changelog') < releaseExecIndex(config));
    assert.ok(names.indexOf('@semantic-release/git') > releaseExecIndex(config));
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
    assert.ok(config.plugins.includes('./scripts/semantic-release-version-policy.cjs'));
  });

  it('does not commit release files back to protected main during stable releases', () => {
    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'stable', GITHUB_REF_NAME: 'main' });

    assert.equal(pluginNames(config).includes('@semantic-release/git'), false);
    assert.equal(pluginNames(config).includes('@semantic-release/changelog'), false);
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

  it('does not configure any commit type to create an automatic major release', () => {
    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'stable', GITHUB_REF_NAME: 'main' });
    const analyzer = config.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer',
    );

    assert.equal(
      analyzer[1].releaseRules.some((rule) => rule.release === 'major'),
      false,
    );
  });
});
