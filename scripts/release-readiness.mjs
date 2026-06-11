#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packageArtifactLayout, packageReleaseMetadata, verifyArtifactManifest } from './package-artifacts.mjs';
import { publicNpmPackageVersion } from './public-npm-release-metadata.mjs';
import { readPublishedPackageSmokeConfig } from './published-package-smoke-config.mjs';

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function releasePolicyPath(rootDir = scriptRootDir()) {
  return join(rootDir, 'release-policy.json');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

const CI_ARTIFACT_ONLY_RELEASE_MODE = 'ci-artifact-only';
const PUBLISHED_PACKAGE_SMOKE_REQUIRED_RELEASE_MODE = 'published-package-smoke-required';
const NPM_PUBLIC_RELEASE_READY_MODE = 'npm-public-release-ready';
const SUPPORTED_RELEASE_MODES = new Set([
  CI_ARTIFACT_ONLY_RELEASE_MODE,
  PUBLISHED_PACKAGE_SMOKE_REQUIRED_RELEASE_MODE,
  NPM_PUBLIC_RELEASE_READY_MODE,
]);

export async function readReleasePolicy(rootDir = scriptRootDir()) {
  return readJson(releasePolicyPath(rootDir));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertString(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
}

function assertNullableString(value, label) {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${label} must be a string or null`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function assertNpmAccess(value) {
  if (value !== 'public') {
    throw new Error('Release policy npm.access must be public');
  }
}

function assertNpmTag(value) {
  assertString(value, 'Release policy npm.tag');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid Release policy npm.tag: ${value}`);
  }
}

function assertSupportedReleaseMode(releaseMode) {
  assertString(releaseMode, 'Release policy releaseMode');
  if (!SUPPORTED_RELEASE_MODES.has(releaseMode)) {
    throw new Error(`Unsupported release policy releaseMode: ${releaseMode}`);
  }
}

function assertRequiredBeforePublishing(policy) {
  assertStringArray(policy.requiredBeforePublishing, 'Release policy requiredBeforePublishing');

  if (policy.releaseMode === CI_ARTIFACT_ONLY_RELEASE_MODE && policy.requiredBeforePublishing.length === 0) {
    throw new Error('Release policy requiredBeforePublishing must list the remaining publishing decisions');
  }

  if (
    (policy.releaseMode === PUBLISHED_PACKAGE_SMOKE_REQUIRED_RELEASE_MODE ||
      policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE) &&
    policy.requiredBeforePublishing.length > 0
  ) {
    throw new Error(`${policy.releaseMode} release mode requires requiredBeforePublishing to be empty`);
  }
}

function assertRuntimeInstallerPolicy(policy) {
  assertPlainObject(policy.runtimeInstaller, 'Release policy runtimeInstaller');
  assertString(policy.runtimeInstaller.uvStrategy, 'Release policy runtimeInstaller.uvStrategy');
  assertBoolean(policy.runtimeInstaller.bootstrapUv, 'Release policy runtimeInstaller.bootstrapUv');
  assertString(
    policy.runtimeInstaller.missingUvBehavior,
    'Release policy runtimeInstaller.missingUvBehavior',
  );

  if (policy.runtimeInstaller.uvStrategy !== 'path-prerequisite') {
    throw new Error('Release policy runtimeInstaller.uvStrategy must be path-prerequisite');
  }
  if (policy.runtimeInstaller.bootstrapUv !== false) {
    throw new Error('Release policy runtimeInstaller.bootstrapUv must be false');
  }
  if (policy.runtimeInstaller.missingUvBehavior !== 'focused-error') {
    throw new Error('Release policy runtimeInstaller.missingUvBehavior must be focused-error');
  }
}

function assertSameMembers(actual, expected, label) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} mismatch: expected ${sortedExpected.join(', ')}, got ${sortedActual.join(', ')}`);
  }
}

export function validateReleasePolicy(policy) {
  assertPlainObject(policy, 'Release policy');

  if (policy.schemaVersion !== 1) {
    throw new Error(`Unsupported release policy schemaVersion: ${policy.schemaVersion}`);
  }
  assertSupportedReleaseMode(policy.releaseMode);
  assertPlainObject(policy.npm, 'Release policy npm');
  assertPlainObject(policy.python, 'Release policy python');
  assertPlainObject(policy.publishedPackageSmoke, 'Release policy publishedPackageSmoke');

  assertBoolean(policy.npm.publish, 'Release policy npm.publish');
  assertNullableString(policy.npm.registry, 'Release policy npm.registry');
  assertNpmAccess(policy.npm.access);
  assertNpmTag(policy.npm.tag);
  assertStringArray(policy.npm.packages, 'Release policy npm.packages');

  assertBoolean(policy.python.publish, 'Release policy python.publish');
  assertNullableString(policy.python.repository, 'Release policy python.repository');
  assertStringArray(policy.python.packages, 'Release policy python.packages');
  assertNullableString(policy.publishedPackageSmoke.packageName, 'Release policy publishedPackageSmoke.packageName');
  assertString(policy.publishedPackageSmoke.version, 'Release policy publishedPackageSmoke.version');
  assertNullableString(policy.publishedPackageSmoke.registry, 'Release policy publishedPackageSmoke.registry');
  readPublishedPackageSmokeConfig({}, [], policy.publishedPackageSmoke);
  assertRequiredBeforePublishing(policy);
  assertRuntimeInstallerPolicy(policy);

  return policy;
}

function metadataNames(metadata, ecosystem) {
  return metadata.filter((entry) => entry.ecosystem === ecosystem).map((entry) => entry.packageName);
}

function publishedPackageSmokeGate(policy) {
  const config = readPublishedPackageSmokeConfig({}, [], policy.publishedPackageSmoke);

  if (
    (policy.releaseMode === PUBLISHED_PACKAGE_SMOKE_REQUIRED_RELEASE_MODE ||
      policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE) &&
    !config.enabled
  ) {
    throw new Error(`${policy.releaseMode} release mode requires release-policy.json publishedPackageSmoke.packageName`);
  }

  const base =
    policy.releaseMode === CI_ARTIFACT_ONLY_RELEASE_MODE
      ? {
          status: 'not_required',
          reason: 'Published package smoke remains pending until release-policy.json enables npm registry publishing.',
        }
      : policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE
        ? {
            status: 'required',
            reason: 'Run the published package smoke after the npm package is published.',
          }
      : {
          status: 'required',
          reason: 'Run the published package smoke before accepting the hybrid-search release.',
        };

  return {
    ...base,
    script: 'pnpm run release:published-smoke',
    configSource: config.enabled ? config.configSource : null,
    packageName: config.enabled ? config.packageName : null,
    version: config.enabled ? config.packageVersion : policy.publishedPackageSmoke.version,
    registry: config.enabled ? (config.registry ?? null) : policy.publishedPackageSmoke.registry,
  };
}

function assertNonPublishingArtifactPolicy(policy, metadata, publicPackageVersion) {
  const policyLabel =
    policy.releaseMode === CI_ARTIFACT_ONLY_RELEASE_MODE ? 'ci-artifact-only policy' : `${policy.releaseMode} policy`;

  if (policy.npm.publish !== false) {
    throw new Error(`${policyLabel} must keep npm.publish false`);
  }
  if (policy.python.publish !== false) {
    throw new Error(`${policyLabel} must keep python.publish false`);
  }
  if (policy.npm.registry !== null) {
    throw new Error(`${policyLabel} must keep npm.registry null`);
  }
  if (policy.python.repository !== null) {
    throw new Error(`${policyLabel} must keep python.repository null`);
  }

  assertSameMembers(policy.npm.packages, metadataNames(metadata, 'npm'), 'Release policy npm.packages');
  assertSameMembers(policy.python.packages, metadataNames(metadata, 'python'), 'Release policy python.packages');

  for (const entry of metadata) {
    if (entry.releaseMode !== CI_ARTIFACT_ONLY_RELEASE_MODE) {
      throw new Error(`Package ${entry.packageName} releaseMode must remain ci-artifact-only`);
    }
    if (entry.ecosystem !== 'npm') {
      continue;
    }
    if (entry.packageName !== '@kaelio/ktx') {
      throw new Error(`${policyLabel} unexpected npm package ${entry.packageName}`);
    }
    if (entry.private !== false) {
      throw new Error(`${policyLabel} npm package @kaelio/ktx must be publishable when npm.publish is false`);
    }
    if (entry.packageVersion !== publicPackageVersion) {
      throw new Error(`${policyLabel} npm package @kaelio/ktx must use public version ${publicPackageVersion}`);
    }
  }
}

function assertNpmPublicReleaseReadyPolicy(policy, metadata, publicPackageVersion) {
  if (policy.npm.publish !== true) {
    throw new Error('npm-public-release-ready policy requires npm.publish true');
  }
  if (policy.python.publish !== false) {
    throw new Error('npm-public-release-ready policy keeps python.publish false');
  }
  if (policy.python.repository !== null) {
    throw new Error('npm-public-release-ready policy keeps python.repository null');
  }

  assertSameMembers(policy.npm.packages, ['@kaelio/ktx'], 'Release policy npm.packages');
  assertSameMembers(policy.python.packages, metadataNames(metadata, 'python'), 'Release policy python.packages');

  const npmMetadata = metadata.find((entry) => entry.ecosystem === 'npm' && entry.packageName === '@kaelio/ktx');
  if (!npmMetadata) {
    throw new Error('npm-public-release-ready policy requires @kaelio/ktx artifact metadata');
  }
  if (npmMetadata.private !== false) {
    throw new Error('npm-public-release-ready policy requires @kaelio/ktx to be publishable');
  }
  if (npmMetadata.packageVersion !== publicPackageVersion) {
    throw new Error(
      `npm-public-release-ready policy expected @kaelio/ktx ${publicPackageVersion}, got ${npmMetadata.packageVersion}`,
    );
  }
  if (policy.publishedPackageSmoke.packageName !== '@kaelio/ktx') {
    throw new Error('npm-public-release-ready policy requires publishedPackageSmoke.packageName @kaelio/ktx');
  }
  if (policy.publishedPackageSmoke.version !== publicPackageVersion) {
    throw new Error(`npm-public-release-ready policy requires publishedPackageSmoke.version ${publicPackageVersion}`);
  }
}

export async function releaseReadinessReport(rootDir = scriptRootDir()) {
  const policy = validateReleasePolicy(await readReleasePolicy(rootDir));
  const publicPackageVersion = publicNpmPackageVersion(rootDir);
  const layout = packageArtifactLayout(rootDir, publicPackageVersion);
  const manifest = await verifyArtifactManifest(layout);
  const metadata = await packageReleaseMetadata(rootDir, publicPackageVersion);

  if (policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE) {
    assertNpmPublicReleaseReadyPolicy(policy, metadata, publicPackageVersion);
  } else {
    assertNonPublishingArtifactPolicy(policy, metadata, publicPackageVersion);
  }

  return {
    schemaVersion: 1,
    releaseMode: policy.releaseMode,
    sourceRevision: manifest.sourceRevision,
    npmPublishEnabled: policy.npm.publish,
    pythonPublishEnabled: policy.python.publish,
    packageNames: metadata.map((entry) => entry.packageName),
    publishedPackageSmokeGate: publishedPackageSmokeGate(policy),
    runtimeInstaller: policy.runtimeInstaller,
    npmPublish:
      policy.releaseMode === NPM_PUBLIC_RELEASE_READY_MODE
        ? {
            packageName: '@kaelio/ktx',
            version: publicPackageVersion,
            access: policy.npm.access,
            tag: policy.npm.tag,
            registry: policy.npm.registry,
          }
        : null,
    blockedPublishingDecisions: policy.requiredBeforePublishing,
  };
}

async function main() {
  const report = await releaseReadinessReport();

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`ktx release mode: ${report.releaseMode}\n`);
  process.stdout.write(`ktx source revision: ${report.sourceRevision ?? 'local'}\n`);
  process.stdout.write(`ktx packages: ${report.packageNames.join(', ')}\n`);
  process.stdout.write(`Published package smoke: ${report.publishedPackageSmokeGate.status}\n`);
  process.stdout.write(`Published package smoke script: ${report.publishedPackageSmokeGate.script}\n`);
  process.stdout.write(`Published package smoke reason: ${report.publishedPackageSmokeGate.reason}\n`);
  process.stdout.write(`Published package smoke package: ${report.publishedPackageSmokeGate.packageName ?? 'not configured'}\n`);
  process.stdout.write(`Published package smoke version: ${report.publishedPackageSmokeGate.version}\n`);
  process.stdout.write(
    `Published package smoke registry: ${report.publishedPackageSmokeGate.registry ?? 'default npm registry'}\n`,
  );
  process.stdout.write(`Runtime uv strategy: ${report.runtimeInstaller.uvStrategy}\n`);
  process.stdout.write(
    `Runtime uv bootstrap: ${report.runtimeInstaller.bootstrapUv ? 'enabled' : 'disabled'}\n`,
  );
  if (report.npmPublish) {
    process.stdout.write(
      `NPM publish target: ${report.npmPublish.packageName}@${report.npmPublish.version} (${report.npmPublish.tag})\n`,
    );
  } else {
    process.stdout.write('Registry publishing remains disabled by release-policy.json.\n');
  }
  process.stdout.write('Required decisions before publishing:\n');
  for (const decision of report.blockedPublishingDecisions) {
    process.stdout.write(`- ${decision}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
