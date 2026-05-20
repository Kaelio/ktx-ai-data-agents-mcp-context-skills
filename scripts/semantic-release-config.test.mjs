import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { createReleaseConfig, releaseBranches, releaseKind, releaseTag } = require('./semantic-release-config.cjs');

function releaseExecOptions(config) {
  return config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].prepareCmd)[1];
}

function pluginNames(config) {
  return config.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
}

describe('semantic-release config', () => {
  it('configures rc releases as a prerelease on main', () => {
    assert.equal(releaseKind({ KTX_RELEASE_KIND: 'rc' }), 'rc');
    assert.equal(releaseTag('rc'), 'next');
    assert.deepEqual(releaseBranches({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'main' }), [
      { name: 'main', prerelease: 'rc', channel: 'next' },
    ]);

    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'main' });
    assert.equal(
      config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/npm'),
      undefined,
      '@semantic-release/npm must not run; the exec publishCmd publishes the pre-built tarball',
    );
    assert.match(
      releaseExecOptions(config).prepareCmd,
      /update-public-release-version\.mjs "\$\{nextRelease\.version\}" "next"/,
    );
    assert.match(
      releaseExecOptions(config).publishCmd,
      /^npm publish dist\/artifacts\/npm\/kaelio-ktx-\$\{nextRelease\.version\}\.tgz --tag next --access public --provenance/,
    );
    assert.match(releaseExecOptions(config).publishCmd, /pnpm run release:published-smoke/);
    assert.doesNotMatch(JSON.stringify(config.plugins), /release:npm-publish/);
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
    assert.match(
      releaseExecOptions(config).publishCmd,
      /^npm publish dist\/artifacts\/npm\/kaelio-ktx-\$\{nextRelease\.version\}\.tgz --tag latest --access public --provenance/,
    );
    assert.equal(config.plugins.includes('./scripts/semantic-release-version-policy.cjs'), false);
  });

  it('never commits release files back to the repo', () => {
    for (const kind of ['rc', 'stable']) {
      const config = createReleaseConfig({ KTX_RELEASE_KIND: kind, GITHUB_REF_NAME: 'main' });
      assert.equal(pluginNames(config).includes('@semantic-release/git'), false, `${kind}: @semantic-release/git`);
      assert.equal(pluginNames(config).includes('@semantic-release/changelog'), false, `${kind}: @semantic-release/changelog`);
    }
  });

  it('produces a loadable config regardless of GITHUB_REF_NAME', () => {
    // Knip and other tooling load .releaserc.cjs on PR runners where
    // GITHUB_REF_NAME is the merge ref. semantic-release itself enforces the
    // main-only rule by refusing to publish when the current branch does not
    // match a configured release branch, so the config must not throw at load.
    for (const kind of ['rc', 'stable']) {
      assert.doesNotThrow(() => releaseBranches({ KTX_RELEASE_KIND: kind, GITHUB_REF_NAME: '180/merge' }));
    }
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
    assert.deepEqual(
      analyzer[1].releaseRules.filter((rule) => rule.breaking || rule.type === 'major'),
      [
        { breaking: true, release: 'minor' },
        { type: 'major', release: 'minor' },
      ],
    );
  });
});
