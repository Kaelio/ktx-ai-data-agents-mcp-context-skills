import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { createReleaseConfig, releaseBranches, releaseKind, releaseTag } = require('./semantic-release-config.cjs');

function prepareExecOptions(config) {
  return config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].prepareCmd)[1];
}

function publishExecOptions(config) {
  return config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].publishCmd)[1];
}

function gitPluginOptions(config) {
  const found = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/git');
  return found ? found[1] : undefined;
}

function pluginNames(config) {
  return config.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
}

describe('semantic-release config', () => {
  it('configures rc releases as a prerelease on main', () => {
    assert.equal(releaseKind({ KTX_RELEASE_KIND: 'rc' }), 'rc');
    assert.equal(releaseTag('rc', { GITHUB_REF_NAME: 'main' }), 'next');
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
      prepareExecOptions(config).prepareCmd,
      /update-public-release-version\.mjs "\$\{nextRelease\.version\}" "next"/,
    );
    assert.match(
      publishExecOptions(config).publishCmd,
      /^npm publish dist\/artifacts\/npm\/kaelio-ktx-\$\{nextRelease\.version\}\.tgz --tag next --access public --provenance/,
    );
    assert.match(publishExecOptions(config).publishCmd, /pnpm run release:published-smoke/);
    assert.doesNotMatch(JSON.stringify(config.plugins), /release:npm-publish/);
  });

  it('configures rc releases from branches with branch-specific prerelease and npm tag', () => {
    assert.equal(releaseTag('rc', { GITHUB_REF_NAME: 'feature/branch-release' }), 'branch-feature-branch-release');
    assert.deepEqual(releaseBranches({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'feature/branch-release' }), [
      { name: 'main', prerelease: 'rc', channel: 'next' },
      { name: 'feature/branch-release', prerelease: 'feature-branch-release', channel: 'branch-feature-branch-release' },
    ]);

    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'rc', GITHUB_REF_NAME: 'feature/branch-release' });
    assert.match(
      prepareExecOptions(config).prepareCmd,
      /update-public-release-version\.mjs "\$\{nextRelease\.version\}" "branch-feature-branch-release"/,
    );
    assert.match(
      publishExecOptions(config).publishCmd,
      /^npm publish dist\/artifacts\/npm\/kaelio-ktx-\$\{nextRelease\.version\}\.tgz --tag branch-feature-branch-release --access public --provenance/,
    );
  });

  it('configures stable releases only from main with latest tag', () => {
    assert.equal(releaseKind({ KTX_RELEASE_KIND: 'stable' }), 'stable');
    assert.equal(releaseTag('stable'), 'latest');
    assert.deepEqual(releaseBranches({ KTX_RELEASE_KIND: 'stable', GITHUB_REF_NAME: 'main' }), ['main']);

    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'stable', GITHUB_REF_NAME: 'main' });
    assert.match(
      prepareExecOptions(config).prepareCmd,
      /update-public-release-version\.mjs "\$\{nextRelease\.version\}" "latest"/,
    );
    assert.match(
      publishExecOptions(config).publishCmd,
      /^npm publish dist\/artifacts\/npm\/kaelio-ktx-\$\{nextRelease\.version\}\.tgz --tag latest --access public --provenance/,
    );
    assert.equal(config.plugins.includes('./scripts/semantic-release-version-policy.cjs'), false);
  });

  it('commits release version files back to the branch via @semantic-release/git', () => {
    for (const kind of ['rc', 'stable']) {
      const config = createReleaseConfig({ KTX_RELEASE_KIND: kind, GITHUB_REF_NAME: 'main' });
      const git = gitPluginOptions(config);
      assert.ok(git, `${kind}: @semantic-release/git plugin must be configured`);
      assert.deepEqual(git.assets, [
        'package.json',
        'release-policy.json',
        'packages/cli/package.json',
        'python/ktx-daemon/pyproject.toml',
        'python/ktx-sl/pyproject.toml',
      ]);
      assert.match(git.message, /^chore\(release\): \$\{nextRelease\.version\} \[skip ci\]/);
    }
  });

  it('keeps @semantic-release/npm and @semantic-release/changelog out of the plugin chain', () => {
    for (const kind of ['rc', 'stable']) {
      const config = createReleaseConfig({ KTX_RELEASE_KIND: kind, GITHUB_REF_NAME: 'main' });
      assert.equal(pluginNames(config).includes('@semantic-release/npm'), false, `${kind}: @semantic-release/npm`);
      assert.equal(pluginNames(config).includes('@semantic-release/changelog'), false, `${kind}: @semantic-release/changelog`);
    }
  });

  it('orders the prepare exec before @semantic-release/git before the publish exec', () => {
    const config = createReleaseConfig({ KTX_RELEASE_KIND: 'stable', GITHUB_REF_NAME: 'main' });
    const prepareIndex = config.plugins.findIndex(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].prepareCmd,
    );
    const gitIndex = config.plugins.findIndex(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/git',
    );
    const publishIndex = config.plugins.findIndex(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec' && plugin[1].publishCmd,
    );
    assert.ok(prepareIndex !== -1 && gitIndex !== -1 && publishIndex !== -1);
    assert.ok(prepareIndex < gitIndex, 'prepare exec must run before @semantic-release/git');
    assert.ok(gitIndex < publishIndex, '@semantic-release/git must run before the publish exec');
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
