const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FIRST_STABLE_RELEASE_FLOOR_VERSION = '0.0.0';

function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`Invalid public npm package version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function readReleasePolicy(cwd) {
  return JSON.parse(readFileSync(join(cwd, 'release-policy.json'), 'utf8'));
}

function releaseKind(env) {
  return env.KTX_RELEASE_KIND || env.INPUT_RELEASE_KIND || 'rc';
}

function stableBaseVersion(version) {
  const parsed = parseSemver(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function isFirstStableReleaseFloor(context) {
  return (
    releaseKind(context.env) === 'stable' &&
    context.env.KTX_STABLE_RELEASE_FLOOR_TAG &&
    context.lastRelease.version === FIRST_STABLE_RELEASE_FLOOR_VERSION &&
    context.lastRelease.gitTag === context.env.KTX_STABLE_RELEASE_FLOOR_TAG
  );
}

function analyzeCommits(config, context) {
  if (!isFirstStableReleaseFloor(context)) {
    return undefined;
  }

  context.logger.log('Using temporary stable release floor to publish 0.1.0');
  return 'minor';
}

function assertNoAutomaticMajorRelease(context, policyVersion) {
  const policy = parseSemver(policyVersion);
  const next = parseSemver(context.nextRelease.version);
  if (next.major <= policy.major) {
    return;
  }

  throw new Error(
    [
      `Refusing automatic major release ${context.nextRelease.version}.`,
      `release-policy.json is still on major ${policy.major}.`,
      'Update release-policy.json manually before publishing a new major version.',
    ].join(' '),
  );
}

function assertStableReleaseFloorTarget(context, policyVersion) {
  if (!isFirstStableReleaseFloor(context)) {
    return;
  }

  const expectedVersion = stableBaseVersion(policyVersion);
  if (context.nextRelease.version !== expectedVersion) {
    throw new Error(
      `Stable release floor expected ${expectedVersion}, got ${context.nextRelease.version}.`,
    );
  }
}

function verifyRelease(config, context) {
  const policy = readReleasePolicy(context.cwd);
  const policyVersion = policy.publicNpmPackageVersion;

  assertNoAutomaticMajorRelease(context, policyVersion);
  assertStableReleaseFloorTarget(context, policyVersion);
}

function prepare(config, context) {
  const floorTag = context.env.KTX_STABLE_RELEASE_FLOOR_TAG;
  if (!floorTag) {
    return;
  }

  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['tag', '-d', floorTag], {
    cwd: context.cwd,
    stdio: 'ignore',
  });
  context.logger.log(`Deleted temporary stable release floor tag ${floorTag}`);
}

module.exports = {
  FIRST_STABLE_RELEASE_FLOOR_VERSION,
  analyzeCommits,
  assertNoAutomaticMajorRelease,
  assertStableReleaseFloorTarget,
  isFirstStableReleaseFloor,
  parseSemver,
  prepare,
  stableBaseVersion,
  verifyRelease,
};
