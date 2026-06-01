const releaseRules = [
  { breaking: true, release: 'minor' },
  { revert: true, release: 'patch' },
  { type: 'feat', release: 'minor' },
  { type: 'feature', release: 'minor' },
  { type: 'enhancement', release: 'minor' },
  { type: 'fix', release: 'patch' },
  { type: 'bug', release: 'patch' },
  { type: 'bugfix', release: 'patch' },
  { type: 'patch', release: 'patch' },
  { type: 'perf', release: 'patch' },
  { type: 'performance', release: 'patch' },
  { type: 'optimization', release: 'patch' },
  { type: 'security', release: 'patch' },
  { type: 'vulnerability', release: 'patch' },
  { type: 'deps', release: 'patch' },
  { type: 'dependencies', release: 'patch' },
  { type: 'upgrade', release: 'patch' },
  { type: 'update', release: 'patch' },
  { type: 'style', release: 'patch' },
  { type: 'refactor', release: 'patch' },
  { type: 'refactoring', release: 'patch' },
  { type: 'cleanup', release: 'patch' },
  { type: 'test', release: 'patch' },
  { type: 'tests', release: 'patch' },
  { type: 'testing', release: 'patch' },
  { type: 'build', release: 'patch' },
  { type: 'ci', release: 'patch' },
  { type: 'cd', release: 'patch' },
  { type: 'config', release: 'patch' },
  { type: 'workflow', release: 'patch' },
  { type: 'pipeline', release: 'patch' },
  { type: 'chore', release: 'patch' },
  { type: 'docs', release: 'patch' },
  { type: 'documentation', release: 'patch' },
  { type: 'breaking', release: 'minor' },
  { type: 'breaking-change', release: 'minor' },
  { type: 'major', release: 'minor' },
];

const releaseNoteTypes = [
  { type: 'feat', section: 'Features', hidden: false },
  { type: 'feature', section: 'Features', hidden: false },
  { type: 'fix', section: 'Bug Fixes', hidden: false },
  { type: 'bug', section: 'Bug Fixes', hidden: false },
  { type: 'bugfix', section: 'Bug Fixes', hidden: false },
  { type: 'perf', section: 'Performance Improvements', hidden: false },
  { type: 'performance', section: 'Performance Improvements', hidden: false },
  { type: 'optimization', section: 'Performance Improvements', hidden: false },
  { type: 'security', section: 'Security', hidden: false },
  { type: 'vulnerability', section: 'Security', hidden: false },
  { type: 'deps', section: 'Dependencies', hidden: false },
  { type: 'dependencies', section: 'Dependencies', hidden: false },
  { type: 'upgrade', section: 'Dependencies', hidden: false },
  { type: 'update', section: 'Dependencies', hidden: false },
  { type: 'docs', section: 'Documentation', hidden: false },
  { type: 'documentation', section: 'Documentation', hidden: false },
  { type: 'style', section: 'Styling', hidden: false },
  { type: 'refactor', section: 'Code Refactoring', hidden: false },
  { type: 'refactoring', section: 'Code Refactoring', hidden: false },
  { type: 'cleanup', section: 'Code Refactoring', hidden: false },
  { type: 'test', section: 'Tests', hidden: false },
  { type: 'tests', section: 'Tests', hidden: false },
  { type: 'testing', section: 'Tests', hidden: false },
  { type: 'build', section: 'Build System', hidden: false },
  { type: 'ci', section: 'Continuous Integration', hidden: false },
  { type: 'cd', section: 'Continuous Integration', hidden: false },
  { type: 'config', section: 'Configuration', hidden: false },
  { type: 'workflow', section: 'Continuous Integration', hidden: false },
  { type: 'pipeline', section: 'Continuous Integration', hidden: false },
  { type: 'chore', section: 'Other Changes', hidden: false },
  { type: 'breaking', section: 'BREAKING CHANGES', hidden: false },
  { type: 'breaking-change', section: 'BREAKING CHANGES', hidden: false },
  { type: 'major', section: 'BREAKING CHANGES', hidden: false },
];

function releaseKind(env) {
  return env.KTX_RELEASE_KIND || env.INPUT_RELEASE_KIND || 'rc';
}

function currentBranchName(env = process.env) {
  return env.GITHUB_REF_NAME || env.INPUT_BRANCH || 'main';
}

function branchPrereleaseId(branchName) {
  return (
    branchName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'branch'
  );
}

function releaseTag(kind, env = process.env) {
  if (kind !== 'rc') {
    return 'latest';
  }

  const branchName = currentBranchName(env);
  if (branchName === 'main') {
    return 'next';
  }

  return `branch-${branchPrereleaseId(branchName)}`;
}

function repositoryUrl(env = process.env) {
  // @semantic-release/github compares this URL's owner/repo against the live
  // GitHub clone_url with an exact match (no redirect following), so a repo
  // rename breaks the release unless repositoryUrl tracks the *current* name.
  // In CI, derive it from the runner's repository so renames never re-break the
  // release. Outside CI, return undefined so semantic-release falls back to the
  // package.json `repository` field (its documented default).
  const repository = env.GITHUB_REPOSITORY;
  if (!repository) {
    return undefined;
  }

  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  return `${server}/${repository}.git`;
}

function releaseBranches(env = process.env) {
  const kind = releaseKind(env);

  if (kind === 'rc') {
    const branches = [{ name: 'main', prerelease: 'rc', channel: 'next' }];
    const branchName = currentBranchName(env);
    if (branchName !== 'main') {
      const prerelease = branchPrereleaseId(branchName);
      branches.push({ name: branchName, prerelease, channel: `branch-${prerelease}` });
    }
    return branches;
  }

  if (kind === 'stable') {
    return ['main'];
  }

  throw new Error(`Unsupported KTX_RELEASE_KIND: ${kind}`);
}

function createReleaseConfig(env = process.env) {
  const kind = releaseKind(env);
  const tag = releaseTag(kind, env);
  const url = repositoryUrl(env);

  return {
    tagFormat: 'v${version}',
    branches: releaseBranches(env),
    ...(url ? { repositoryUrl: url } : {}),
    plugins: [
      [
        '@semantic-release/commit-analyzer',
        {
          releaseRules,
        },
      ],
      [
        '@semantic-release/exec',
        {
          analyzeCommitsCmd: 'node -e "console.log(process.env.FORCE_RELEASE === \'true\' ? \'patch\' : \'\')"',
        },
      ],
      [
        '@semantic-release/release-notes-generator',
        {
          preset: 'conventionalcommits',
          presetConfig: {
            types: releaseNoteTypes,
          },
        },
      ],
      [
        '@semantic-release/exec',
        {
          prepareCmd: [
            `node scripts/update-public-release-version.mjs "\${nextRelease.version}" "${tag}"`,
            'pnpm run artifacts:check',
            'pnpm run release:readiness',
          ].join(' && '),
        },
      ],
      [
        '@semantic-release/git',
        {
          assets: [
            'package.json',
            'release-policy.json',
            'packages/cli/package.json',
            'python/ktx-daemon/pyproject.toml',
            'python/ktx-sl/pyproject.toml',
          ],
          message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
        },
      ],
      [
        '@semantic-release/exec',
        {
          publishCmd: [
            `npm publish dist/artifacts/npm/kaelio-ktx-\${nextRelease.version}.tgz --tag ${tag} --access public --provenance`,
            'pnpm run release:published-smoke',
          ].join(' && '),
        },
      ],
      [
        '@semantic-release/github',
        {
          successComment: false,
          failComment: false,
          failTitle: false,
          releasedLabels: false,
        },
      ],
    ],
  };
}

module.exports = {
  createReleaseConfig,
  releaseBranches,
  releaseKind,
  releaseTag,
  repositoryUrl,
};
