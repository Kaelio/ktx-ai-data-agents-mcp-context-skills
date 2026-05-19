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

function currentBranch(env) {
  return env.GITHUB_REF_NAME || env.INPUT_BRANCH || 'main';
}

function releaseKind(env) {
  return env.KTX_RELEASE_KIND || env.INPUT_RELEASE_KIND || 'rc';
}

function prereleaseBranch(env) {
  return env.KTX_PRERELEASE_BRANCH || env.INPUT_PRERELEASE_BRANCH || 'next';
}

function releaseTag(kind) {
  return kind === 'rc' ? 'next' : 'latest';
}

function releaseChangelogPlugins(kind) {
  return kind === 'rc' ? ['@semantic-release/changelog'] : [];
}

function releaseGitPlugins(kind) {
  if (kind !== 'rc') {
    return [];
  }

  return [
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json', 'release-policy.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ];
}

function releaseBranches(env = process.env) {
  const branch = currentBranch(env);
  const kind = releaseKind(env);

  if (kind === 'rc') {
    return ['main', { name: prereleaseBranch(env), prerelease: 'rc', channel: 'next' }];
  }

  if (kind === 'stable') {
    if (branch !== 'main') {
      throw new Error(`Stable KTX releases must run from main, got ${branch}`);
    }
    return ['main'];
  }

  throw new Error(`Unsupported KTX_RELEASE_KIND: ${kind}`);
}

function createReleaseConfig(env = process.env) {
  const kind = releaseKind(env);
  const tag = releaseTag(kind);

  return {
    tagFormat: 'v${version}',
    branches: releaseBranches(env),
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
      ...releaseChangelogPlugins(kind),
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
        '@semantic-release/npm',
        {
          pkgRoot: 'dist/public-npm-package',
          tarballDir: 'dist/artifacts/npm',
        },
      ],
      [
        '@semantic-release/exec',
        {
          publishCmd: 'pnpm run release:published-smoke',
        },
      ],
      ...releaseGitPlugins(kind),
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
  prereleaseBranch,
  releaseBranches,
  releaseKind,
  releaseTag,
};
