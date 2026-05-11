import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const DEFAULT_VERSION_TAG = 'latest';
export const NO_PACKAGE_REASON =
  'Set KTX_PUBLISHED_KTX_PACKAGE or release-policy.json publishedPackageSmoke.packageName to the published npm package name after the release decision.';

function optionalTrimmedString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function assertSafePackageName(packageName, label) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    throw new Error(`Invalid ${label}: ${packageName}`);
  }
}

function assertSafeVersionTag(version, label) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version)) {
    throw new Error(`Invalid ${label}: ${version}`);
  }
}

function assertHttpRegistry(registry, label) {
  const parsed = new URL(registry);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL`);
  }
}

function registryEnv(config) {
  return config.registry ? { npm_config_registry: config.registry } : {};
}

function runtimeCommandEnv(config, runtimeRoot) {
  return { ...registryEnv(config), KTX_RUNTIME_ROOT: runtimeRoot };
}

function semanticQueryArgs(projectDir) {
  return [
    'sl',
    'query',
    '--project-dir',
    projectDir,
    '--connection-id',
    'orbit_demo',
    '--measure',
    'contracts.contract_count',
    '--format',
    'sql',
    '--yes',
  ];
}

function normalizePolicyConfig(policyConfig = {}) {
  if (policyConfig === null || policyConfig === undefined) {
    return { packageName: null, version: DEFAULT_VERSION_TAG, registry: null };
  }

  if (typeof policyConfig !== 'object' || Array.isArray(policyConfig)) {
    throw new Error('release-policy.json publishedPackageSmoke must be a JSON object');
  }

  const normalized = {
    packageName: optionalTrimmedString(policyConfig.packageName),
    version: optionalTrimmedString(policyConfig.version) ?? DEFAULT_VERSION_TAG,
    registry: optionalTrimmedString(policyConfig.registry),
  };
  assertSafeVersionTag(normalized.version, 'release-policy.json publishedPackageSmoke.version');
  if (normalized.registry) {
    assertHttpRegistry(normalized.registry, 'release-policy.json publishedPackageSmoke.registry');
  }
  return normalized;
}

export function readPublishedPackageSmokeConfig(env = process.env, args = process.argv.slice(2), policyConfig = {}) {
  const requireConfig = args.includes('--require-config');
  const policy = normalizePolicyConfig(policyConfig);

  const envPackageName = optionalTrimmedString(env.KTX_PUBLISHED_KTX_PACKAGE);
  const packageName = envPackageName ?? policy.packageName;

  if (!packageName) {
    return {
      enabled: false,
      requireConfig,
      reason: NO_PACKAGE_REASON,
    };
  }

  const configSource = envPackageName ? 'environment' : 'release-policy';
  assertSafePackageName(
    packageName,
    configSource === 'environment'
      ? 'KTX_PUBLISHED_KTX_PACKAGE'
      : 'release-policy.json publishedPackageSmoke.packageName',
  );

  const packageVersion = optionalTrimmedString(env.KTX_PUBLISHED_KTX_VERSION) ?? policy.version;
  assertSafeVersionTag(
    packageVersion,
    optionalTrimmedString(env.KTX_PUBLISHED_KTX_VERSION)
      ? 'KTX_PUBLISHED_KTX_VERSION'
      : 'release-policy.json publishedPackageSmoke.version',
  );

  const registry = optionalTrimmedString(env.KTX_PUBLISHED_KTX_REGISTRY) ?? policy.registry;
  if (registry) {
    assertHttpRegistry(
      registry,
      optionalTrimmedString(env.KTX_PUBLISHED_KTX_REGISTRY)
        ? 'KTX_PUBLISHED_KTX_REGISTRY'
        : 'release-policy.json publishedPackageSmoke.registry',
    );
  }

  return {
    enabled: true,
    requireConfig,
    configSource,
    packageName,
    packageVersion,
    registry,
  };
}

export async function readPublishedPackageSmokeConfigFromPolicyFile(
  policyPath,
  env = process.env,
  args = process.argv.slice(2),
) {
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  return readPublishedPackageSmokeConfig(env, args, policy.publishedPackageSmoke ?? {});
}

export function publishedPackageSpec(config) {
  assert.equal(config.enabled, true, 'publishedPackageSpec requires an enabled smoke config');
  return `${config.packageName}@${config.packageVersion}`;
}

export function buildPublishedPackageNpxCommand(config, args, label = 'published package command', extraEnv = {}) {
  return {
    label,
    command: 'npx',
    args: ['--yes', publishedPackageSpec(config), ...args],
    env: { ...registryEnv(config), ...extraEnv },
  };
}

export function buildPublishedPackageSmokeCommands(
  config,
  projectDir,
  runtimeRoot = join(dirname(projectDir), 'managed-runtime'),
) {
  const runtimeEnv = runtimeCommandEnv(config, runtimeRoot);
  const packageEnv = registryEnv(config);
  const queryArgs = semanticQueryArgs(projectDir);

  return [
    buildPublishedPackageNpxCommand(config, ['--version'], 'published package npx version'),
    buildPublishedPackageNpxCommand(
      config,
      ['setup', 'demo', '--project-dir', projectDir, '--no-input', '--plain'],
      'published package setup demo',
      { KTX_RUNTIME_ROOT: runtimeRoot },
    ),
    buildPublishedPackageNpxCommand(config, queryArgs, 'published package npx sl query', {
      KTX_RUNTIME_ROOT: runtimeRoot,
    }),
    {
      label: 'published package local install',
      command: 'pnpm',
      args: ['add', publishedPackageSpec(config)],
      env: packageEnv,
    },
    {
      label: 'published package local version',
      command: 'npx',
      args: ['ktx', '--version'],
      env: packageEnv,
    },
    {
      label: 'published package local sl query',
      command: 'npx',
      args: ['ktx', ...queryArgs],
      env: runtimeEnv,
    },
    {
      label: 'published package global install',
      command: 'pnpm',
      args: ['add', '--global', publishedPackageSpec(config)],
      env: packageEnv,
    },
    {
      label: 'published package global version',
      command: 'ktx',
      args: ['--version'],
      env: packageEnv,
    },
    {
      label: 'published package global sl query',
      command: 'ktx',
      args: queryArgs,
      env: runtimeEnv,
    },
  ];
}
