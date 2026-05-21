#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_NPM_PACKAGE_NAME = '@kaelio/ktx';
export const PUBLIC_NPM_RELEASE_TAGS = new Set(['latest', 'next']);
export const PUBLIC_NPM_BRANCH_RELEASE_TAG_PATTERN = /^branch-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function publicNpmPackageTarballName(version) {
  return `kaelio-ktx-${version}.tgz`;
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SEMVER_PARTS_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function releasePolicyPath(rootDir = scriptRootDir()) {
  return join(rootDir, 'release-policy.json');
}

function readJsonSync(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function assertPublicNpmPackageVersion(version) {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid public npm package version: ${version}`);
  }
  return version;
}

export function publicNpmPackageVersionToPythonVersion(version) {
  const safeVersion = assertPublicNpmPackageVersion(version);
  const match = SEMVER_PARTS_PATTERN.exec(safeVersion);
  if (!match) {
    throw new Error(`Invalid public npm package version: ${version}`);
  }

  const [, major, minor, patch, prerelease, buildMetadata] = match;
  if (buildMetadata) {
    throw new Error(`Unsupported public npm build metadata for Python runtime version: ${safeVersion}`);
  }

  const baseVersion = `${major}.${minor}.${patch}`;
  if (!prerelease) {
    return baseVersion;
  }

  const rcMatch = /^rc\.([1-9]\d*|0)$/.exec(prerelease);
  if (!rcMatch) {
    throw new Error(`Unsupported public npm prerelease for Python runtime version: ${safeVersion}`);
  }
  return `${baseVersion}rc${rcMatch[1]}`;
}

export function assertPublicNpmReleaseTag(tag) {
  if (typeof tag !== 'string') {
    throw new Error(`Invalid public npm release tag: ${tag}`);
  }
  if (PUBLIC_NPM_RELEASE_TAGS.has(tag) || PUBLIC_NPM_BRANCH_RELEASE_TAG_PATTERN.test(tag)) {
    return tag;
  }
  throw new Error(`Invalid public npm release tag: ${tag}`);
}

export function readPublicNpmReleaseMetadata(rootDir = scriptRootDir()) {
  const policy = readJsonSync(releasePolicyPath(rootDir));
  const version = assertPublicNpmPackageVersion(policy.publicNpmPackageVersion);
  const tag = assertPublicNpmReleaseTag(policy.npm?.tag);

  return {
    packageName: PUBLIC_NPM_PACKAGE_NAME,
    version,
    tag,
  };
}

export function publicNpmPackageVersion(rootDir = scriptRootDir()) {
  return readPublicNpmReleaseMetadata(rootDir).version;
}

export const PUBLIC_NPM_PACKAGE_VERSION = publicNpmPackageVersion();

export function publicPythonRuntimePackageVersion(rootDir = scriptRootDir()) {
  return publicNpmPackageVersionToPythonVersion(publicNpmPackageVersion(rootDir));
}
