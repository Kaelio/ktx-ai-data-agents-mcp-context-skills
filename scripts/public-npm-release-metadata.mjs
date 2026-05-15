#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_NPM_PACKAGE_NAME = '@kaelio/ktx';
export const PUBLIC_NPM_RELEASE_TAGS = new Set(['latest', 'next']);

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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

export function assertPublicNpmReleaseTag(tag) {
  if (!PUBLIC_NPM_RELEASE_TAGS.has(tag)) {
    throw new Error(`Invalid public npm release tag: ${tag}`);
  }
  return tag;
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
