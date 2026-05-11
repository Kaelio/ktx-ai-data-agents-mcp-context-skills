#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
} from './build-python-runtime-wheel.mjs';

const PACKAGE_VERSION = '0.0.0-private';
const PYTHON_PACKAGE_VERSION = '0.1.0';

export {
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
};

export const NPM_ARTIFACT_PACKAGES = [
  { name: '@ktx/context', packageRoot: 'packages/context' },
  { name: '@ktx/llm', packageRoot: 'packages/llm' },
  { name: '@ktx/connector-bigquery', packageRoot: 'packages/connector-bigquery' },
  { name: '@ktx/connector-clickhouse', packageRoot: 'packages/connector-clickhouse' },
  { name: '@ktx/connector-mysql', packageRoot: 'packages/connector-mysql' },
  { name: '@ktx/connector-postgres', packageRoot: 'packages/connector-postgres' },
  { name: '@ktx/connector-posthog', packageRoot: 'packages/connector-posthog' },
  { name: '@ktx/connector-snowflake', packageRoot: 'packages/connector-snowflake' },
  { name: '@ktx/connector-sqlite', packageRoot: 'packages/connector-sqlite' },
  { name: '@ktx/connector-sqlserver', packageRoot: 'packages/connector-sqlserver' },
  { name: '@ktx/cli', packageRoot: 'packages/cli' },
];

export const CLI_PYTHON_ASSET_MANIFEST = 'manifest.json';

const CONNECTOR_PACKAGE_NAMES = NPM_ARTIFACT_PACKAGES
  .map((packageInfo) => packageInfo.name)
  .filter((packageName) => packageName.startsWith('@ktx/connector-'));

const NPM_ARTIFACT_BUILD_ORDER = ['@ktx/llm', '@ktx/context', ...CONNECTOR_PACKAGE_NAMES, '@ktx/cli'];

const ordersSource = {
  name: 'orders',
  table: 'public.orders',
  grain: ['id'],
  columns: [
    { name: 'id', type: 'number' },
    { name: 'status', type: 'string' },
    { name: 'amount', type: 'number' },
  ],
  measures: [{ name: 'order_count', expr: 'count(*)' }],
  joins: [],
};

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function npmPackageTarballName(packageName) {
  return `${packageName.replace('@ktx/', 'ktx-')}-${PACKAGE_VERSION}.tgz`;
}

function npmPackageTarballs(npmDir) {
  return Object.fromEntries(
    NPM_ARTIFACT_PACKAGES.map((packageInfo) => [packageInfo.name, join(npmDir, npmPackageTarballName(packageInfo.name))]),
  );
}

export function packageArtifactLayout(rootDir = scriptRootDir()) {
  const artifactDir = join(rootDir, 'dist', 'artifacts');
  const npmDir = join(artifactDir, 'npm');
  const pythonDir = join(artifactDir, 'python');
  const npmTarballs = npmPackageTarballs(npmDir);

  return {
    rootDir,
    artifactDir,
    npmDir,
    pythonDir,
    npmTarballs,
    contextTarball: npmTarballs['@ktx/context'],
    cliTarball: npmTarballs['@ktx/cli'],
    connectorTarballs: Object.fromEntries(
      CONNECTOR_PACKAGE_NAMES.map((packageName) => [packageName, npmTarballs[packageName]]),
    ),
    manifestPath: join(artifactDir, 'manifest.json'),
  };
}

export function buildArtifactCommands(layout) {
  const packagesByName = new Map(NPM_ARTIFACT_PACKAGES.map((packageInfo) => [packageInfo.name, packageInfo]));
  const npmBuildCommands = NPM_ARTIFACT_BUILD_ORDER.map((packageName) => {
    const packageInfo = packagesByName.get(packageName);
    if (!packageInfo) {
      throw new Error(`Unknown npm artifact build package: ${packageName}`);
    }
    return {
      command: 'pnpm',
      args: ['--filter', packageInfo.name, 'run', 'build'],
      cwd: layout.rootDir,
    };
  });
  const npmPackCommands = NPM_ARTIFACT_PACKAGES.map((packageInfo) => ({
    command: 'pnpm',
    args: ['--filter', packageInfo.name, 'pack', '--out', layout.npmTarballs[packageInfo.name]],
    cwd: layout.rootDir,
  }));

  return [
    ...npmBuildCommands,
    {
      command: process.execPath,
      args: ['scripts/build-python-runtime-wheel.mjs'],
      cwd: layout.rootDir,
    },
    {
      command: 'uv',
      args: ['build', '--package', 'ktx-sl', '--out-dir', layout.pythonDir],
      cwd: layout.rootDir,
    },
    {
      command: 'uv',
      args: ['build', '--package', 'ktx-daemon', '--out-dir', layout.pythonDir],
      cwd: layout.rootDir,
    },
    ...npmPackCommands,
  ];
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertPathExists(path, label) {
  if (!(await pathExists(path))) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

function normalizePythonDistributionName(name) {
  return name.replaceAll('-', '_');
}

function findOne(files, distributionName, suffix, label, pythonDir, version = PYTHON_PACKAGE_VERSION) {
  const normalized = normalizePythonDistributionName(distributionName);
  const found = files.find((file) => file.startsWith(`${normalized}-${version}`) && file.endsWith(suffix));
  if (!found) {
    throw new Error(`Missing Python artifact: ${label}`);
  }
  return join(pythonDir, found);
}

export async function findPythonArtifacts(pythonDir) {
  const files = await readdir(pythonDir);

  return {
    runtimeWheel: findOne(
      files,
      RUNTIME_WHEEL_DISTRIBUTION_NAME,
      '.whl',
      'kaelio-ktx runtime wheel',
      pythonDir,
      RUNTIME_WHEEL_PACKAGE_VERSION,
    ),
    ktxSlWheel: findOne(files, 'ktx-sl', '.whl', 'ktx-sl wheel', pythonDir),
    ktxSlSdist: findOne(files, 'ktx-sl', '.tar.gz', 'ktx-sl source distribution', pythonDir),
    ktxDaemonWheel: findOne(files, 'ktx-daemon', '.whl', 'ktx-daemon wheel', pythonDir),
    ktxDaemonSdist: findOne(files, 'ktx-daemon', '.tar.gz', 'ktx-daemon source distribution', pythonDir),
  };
}

export function artifactManifestPath(layout) {
  return layout.manifestPath ?? join(layout.artifactDir, 'manifest.json');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function readProjectBlock(toml, sourcePath) {
  const lines = toml.split(/\r?\n/);
  const block = [];
  let inProject = false;

  for (const line of lines) {
    if (/^\[project\]\s*$/.test(line)) {
      inProject = true;
      continue;
    }
    if (inProject && /^\[.*\]\s*$/.test(line)) {
      break;
    }
    if (inProject) {
      block.push(line);
    }
  }

  if (!inProject) {
    throw new Error(`Missing [project] table in ${sourcePath}`);
  }
  return block.join('\n');
}

function readTomlStringField(projectBlock, fieldName, sourcePath) {
  const match = projectBlock.match(new RegExp(`^${fieldName}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  if (!match) {
    throw new Error(`Missing project.${fieldName} in ${sourcePath}`);
  }
  return match[1];
}

async function readPyprojectMetadata(path) {
  const toml = await readFile(path, 'utf-8');
  const projectBlock = readProjectBlock(toml, path);
  return {
    name: readTomlStringField(projectBlock, 'name', path),
    version: readTomlStringField(projectBlock, 'version', path),
  };
}

function releaseMetadataEntry({ ecosystem, packageName, packageRoot, packageVersion, privatePackage }) {
  return {
    ecosystem,
    packageName,
    packageRoot,
    packageVersion,
    private: privatePackage,
    releaseMode: 'ci-artifact-only',
  };
}

async function readNpmPackageMetadata(rootDir, packageInfo) {
  const packageJson = await readJson(join(rootDir, packageInfo.packageRoot, 'package.json'));
  if (packageJson.name !== packageInfo.name) {
    throw new Error(
      `Unexpected package name in ${packageInfo.packageRoot}/package.json: expected ${packageInfo.name}, got ${packageJson.name}`,
    );
  }
  return releaseMetadataEntry({
    ecosystem: 'npm',
    packageName: packageJson.name,
    packageRoot: packageInfo.packageRoot,
    packageVersion: packageJson.version,
    privatePackage: packageJson.private === true,
  });
}

export async function packageReleaseMetadata(rootDir = scriptRootDir()) {
  const npmPackages = await Promise.all(
    NPM_ARTIFACT_PACKAGES.map((packageInfo) => readNpmPackageMetadata(rootDir, packageInfo)),
  );
  const ktxSlPackage = await readPyprojectMetadata(join(rootDir, 'python', 'ktx-sl', 'pyproject.toml'));
  const ktxDaemonPackage = await readPyprojectMetadata(join(rootDir, 'python', 'ktx-daemon', 'pyproject.toml'));

  return [
    ...npmPackages,
    releaseMetadataEntry({
      ecosystem: 'python',
      packageName: ktxSlPackage.name,
      packageRoot: 'python/ktx-sl',
      packageVersion: ktxSlPackage.version,
      privatePackage: false,
    }),
    releaseMetadataEntry({
      ecosystem: 'python',
      packageName: ktxDaemonPackage.name,
      packageRoot: 'python/ktx-daemon',
      packageVersion: ktxDaemonPackage.version,
      privatePackage: false,
    }),
    releaseMetadataEntry({
      ecosystem: 'python',
      packageName: RUNTIME_WHEEL_DISTRIBUTION_NAME,
      packageRoot: 'python/runtime-wheel',
      packageVersion: RUNTIME_WHEEL_PACKAGE_VERSION,
      privatePackage: false,
    }),
  ];
}

function packageMetadataByName(packages) {
  return new Map(packages.map((metadata) => [metadata.packageName, metadata]));
}

function requirePackageMetadata(packagesByName, packageName) {
  const metadata = packagesByName.get(packageName);
  if (!metadata) {
    throw new Error(`Missing package release metadata for ${packageName}`);
  }
  return metadata;
}

function artifactPackageRecords(layout, pythonArtifacts, packages) {
  const packagesByName = packageMetadataByName(packages);
  const npmRecords = NPM_ARTIFACT_PACKAGES.map((packageInfo) => ({
    artifactKind: 'tarball',
    artifactPath: layout.npmTarballs[packageInfo.name],
    metadata: requirePackageMetadata(packagesByName, packageInfo.name),
  }));

  return [
    ...npmRecords,
    {
      artifactKind: 'wheel',
      artifactPath: pythonArtifacts.runtimeWheel,
      metadata: requirePackageMetadata(packagesByName, RUNTIME_WHEEL_DISTRIBUTION_NAME),
    },
    {
      artifactKind: 'wheel',
      artifactPath: pythonArtifacts.ktxSlWheel,
      metadata: requirePackageMetadata(packagesByName, 'ktx-sl'),
    },
    {
      artifactKind: 'sdist',
      artifactPath: pythonArtifacts.ktxSlSdist,
      metadata: requirePackageMetadata(packagesByName, 'ktx-sl'),
    },
    {
      artifactKind: 'wheel',
      artifactPath: pythonArtifacts.ktxDaemonWheel,
      metadata: requirePackageMetadata(packagesByName, 'ktx-daemon'),
    },
    {
      artifactKind: 'sdist',
      artifactPath: pythonArtifacts.ktxDaemonSdist,
      metadata: requirePackageMetadata(packagesByName, 'ktx-daemon'),
    },
  ];
}

function artifactRelativePath(layout, artifactPath) {
  return relative(layout.artifactDir, artifactPath).split(sep).join('/');
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} do not match\nExpected:\n${formatJson(expected)}\nActual:\n${formatJson(actual)}`);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
}

function artifactPathFromManifest(layout, manifestPath) {
  assertString(manifestPath, 'Artifact manifest file path');

  if (
    manifestPath.length === 0 ||
    manifestPath.startsWith('/') ||
    manifestPath.includes('\\') ||
    manifestPath.split('/').some((part) => part.length === 0 || part === '..')
  ) {
    throw new Error(`Unsafe artifact manifest path: ${manifestPath}`);
  }

  const resolvedPath = resolve(layout.artifactDir, manifestPath);
  const relativePath = relative(layout.artifactDir, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Unsafe artifact manifest path: ${manifestPath}`);
  }

  return resolvedPath;
}

function sortedManifestFiles(files) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

function assertManifestShape(manifest) {
  if (!isPlainObject(manifest)) {
    throw new Error('Artifact manifest must be a JSON object');
  }
  if (manifest.schemaVersion !== 2) {
    throw new Error(`Unsupported artifact manifest schemaVersion: ${manifest.schemaVersion}`);
  }
  assertString(manifest.generatedAt, 'Artifact manifest generatedAt');
  if (Number.isNaN(Date.parse(manifest.generatedAt))) {
    throw new Error(`Artifact manifest generatedAt is not an ISO timestamp: ${manifest.generatedAt}`);
  }
  if (manifest.sourceRevision !== null && typeof manifest.sourceRevision !== 'string') {
    throw new Error('Artifact manifest sourceRevision must be a string or null');
  }
  if (!Array.isArray(manifest.packages)) {
    throw new Error('Artifact manifest packages must be an array');
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('Artifact manifest files must be an array');
  }
}

async function artifactManifestEntry(layout, record) {
  const contents = await readFile(record.artifactPath);
  return {
    path: artifactRelativePath(layout, record.artifactPath),
    ecosystem: record.metadata.ecosystem,
    artifactKind: record.artifactKind,
    packageName: record.metadata.packageName,
    packageVersion: record.metadata.packageVersion,
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

export async function buildArtifactManifest(layout, generatedAt = new Date(), options = {}) {
  const pythonArtifacts = await findPythonArtifacts(layout.pythonDir);
  const packages = await packageReleaseMetadata(layout.rootDir);
  const artifactRecords = artifactPackageRecords(layout, pythonArtifacts, packages);
  const files = await Promise.all(artifactRecords.map((record) => artifactManifestEntry(layout, record)));

  return {
    schemaVersion: 2,
    generatedAt: generatedAt.toISOString(),
    sourceRevision: options.sourceRevision ?? process.env.GITHUB_SHA ?? null,
    packages,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export async function writeArtifactManifest(layout, generatedAt = new Date(), options = {}) {
  const manifest = await buildArtifactManifest(layout, generatedAt, options);
  await writeFile(artifactManifestPath(layout), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyArtifactManifest(layout, options = {}) {
  const manifest = await readJson(artifactManifestPath(layout));
  assertManifestShape(manifest);

  const expectedSourceRevision = options.expectedSourceRevision ?? process.env.KTX_EXPECTED_SOURCE_REVISION;
  if (expectedSourceRevision !== undefined && manifest.sourceRevision !== expectedSourceRevision) {
    throw new Error(
      `Artifact manifest sourceRevision mismatch: expected ${expectedSourceRevision}, got ${manifest.sourceRevision}`,
    );
  }

  const expectedPackages = await packageReleaseMetadata(layout.rootDir);
  assertJsonEqual(manifest.packages, expectedPackages, 'Artifact manifest packages');

  for (const file of manifest.files) {
    if (!isPlainObject(file)) {
      throw new Error('Artifact manifest file entries must be JSON objects');
    }
    artifactPathFromManifest(layout, file.path);
  }

  const pythonArtifacts = await findPythonArtifacts(layout.pythonDir);
  const expectedFiles = await Promise.all(
    artifactPackageRecords(layout, pythonArtifacts, expectedPackages).map((record) => artifactManifestEntry(layout, record)),
  );
  assertJsonEqual(
    sortedManifestFiles(manifest.files),
    sortedManifestFiles(expectedFiles),
    'Artifact manifest files do not match artifact contents',
  );

  return manifest;
}

function runtimeWheelAssetName(runtimeWheelPath) {
  return runtimeWheelPath.split(sep).at(-1);
}

export async function copyRuntimeWheelAssets(layout, pythonArtifacts) {
  const assetDir = join(layout.rootDir, 'packages', 'cli', 'assets', 'python');
  const wheelFile = runtimeWheelAssetName(pythonArtifacts.runtimeWheel);
  if (!wheelFile) {
    throw new Error(`Unable to determine runtime wheel filename: ${pythonArtifacts.runtimeWheel}`);
  }
  const wheelContents = await readFile(pythonArtifacts.runtimeWheel);
  await rm(assetDir, { recursive: true, force: true });
  await mkdir(assetDir, { recursive: true });
  const wheelPath = join(assetDir, wheelFile);
  const manifestPath = join(assetDir, CLI_PYTHON_ASSET_MANIFEST);
  await writeFile(wheelPath, wheelContents);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distributionName: RUNTIME_WHEEL_DISTRIBUTION_NAME,
        normalizedName: RUNTIME_WHEEL_NORMALIZED_NAME,
        version: RUNTIME_WHEEL_PACKAGE_VERSION,
        wheel: {
          file: wheelFile,
          sha256: createHash('sha256').update(wheelContents).digest('hex'),
          bytes: wheelContents.byteLength,
        },
      },
      null,
      2,
    )}\n`,
  );
  return { assetDir, wheelPath, manifestPath };
}

export function pythonArtifactInstallArgs(python, pythonArtifacts) {
  return ['pip', 'install', '--python', python, pythonArtifacts.runtimeWheel];
}

function runCommand(command, args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);

  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: 1024 * 1024 * 20,
      },
      (error, stdout, stderr) => {
        if (stdout) {
          process.stdout.write(stdout);
        }
        if (stderr) {
          process.stderr.write(stderr);
        }
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

function npmTarballDependencyEntries(layout) {
  return Object.fromEntries(
    NPM_ARTIFACT_PACKAGES.map((packageInfo) => [
      packageInfo.name,
      `file:${layout.npmTarballs[packageInfo.name]}`,
    ]),
  );
}

export function npmSmokePackageJson(layout) {
  const npmTarballDependencies = npmTarballDependencyEntries(layout);
  return {
    name: 'ktx-artifact-npm-smoke',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      ...npmTarballDependencies,
      '@modelcontextprotocol/sdk': '^1.27.1',
    },
    pnpm: {
      overrides: npmTarballDependencies,
      onlyBuiltDependencies: ['better-sqlite3'],
    },
  };
}

export function npmVerifySource() {
  return `
const context = await import('@ktx/context');
const project = await import('@ktx/context/project');
const mcp = await import('@ktx/context/mcp');
const memory = await import('@ktx/context/memory');
const daemon = await import('@ktx/context/daemon');
const ingest = await import('@ktx/context/ingest');
const search = await import('@ktx/context/search');
const llm = await import('@ktx/llm');
const cli = await import('@ktx/cli');
const bigqueryConnector = await import('@ktx/connector-bigquery');
const clickhouseConnector = await import('@ktx/connector-clickhouse');
const mysqlConnector = await import('@ktx/connector-mysql');
const postgresConnector = await import('@ktx/connector-postgres');
const posthogConnector = await import('@ktx/connector-posthog');
const snowflakeConnector = await import('@ktx/connector-snowflake');
const sqliteConnector = await import('@ktx/connector-sqlite');
const sqlserverConnector = await import('@ktx/connector-sqlserver');

if (context.ktxContextPackageInfo.name !== '@ktx/context') {
  throw new Error('Unexpected @ktx/context package info');
}
if (typeof llm.createKtxLlmProvider !== 'function') {
  throw new Error('Missing createKtxLlmProvider export');
}
if (typeof llm.KtxMessageBuilder !== 'function') {
  throw new Error('Missing KtxMessageBuilder export');
}
if (typeof llm.createKtxEmbeddingProvider !== 'function') {
  throw new Error('Missing createKtxEmbeddingProvider export');
}
if (typeof project.initKtxProject !== 'function') {
  throw new Error('Missing initKtxProject export');
}
if (typeof mcp.createDefaultKtxMcpServer !== 'function') {
  throw new Error('Missing createDefaultKtxMcpServer export');
}
if (typeof memory.createLocalProjectMemoryCapture !== 'function') {
  throw new Error('Missing createLocalProjectMemoryCapture export');
}
if (typeof search.HybridSearchCore !== 'function') {
  throw new Error('Missing HybridSearchCore export from @ktx/context/search');
}
if (typeof search.assertSearchBackendConformanceCase !== 'function') {
  throw new Error('Missing assertSearchBackendConformanceCase export from @ktx/context/search');
}
if (typeof search.assertSearchBackendCapabilities !== 'function') {
  throw new Error('Missing assertSearchBackendCapabilities export from @ktx/context/search');
}
if (typeof daemon.createPythonSemanticLayerComputePort !== 'function') {
  throw new Error('Missing createPythonSemanticLayerComputePort export');
}
const dbtExtractionExports = [
  ['parseMetricflowFiles', ingest.parseMetricflowFiles],
  ['parseMetricflowPullConfig', ingest.parseMetricflowPullConfig],
  ['importMetricflowSemanticModels', ingest.importMetricflowSemanticModels],
  ['parseDbtSchemaFiles', ingest.parseDbtSchemaFiles],
  ['toDescriptionUpdates', ingest.toDescriptionUpdates],
  ['toRelationshipUpdates', ingest.toRelationshipUpdates],
  ['mergeSemanticModelTables', ingest.mergeSemanticModelTables],
  ['loadProjectInfo', ingest.loadProjectInfo],
  ['loadDbtSchemaFiles', ingest.loadDbtSchemaFiles],
];

for (const [exportName, exportValue] of dbtExtractionExports) {
  if (typeof exportValue !== 'function') {
    throw new Error('Missing dbt extraction export: ' + exportName);
  }
}

const metricflowConfig = ingest.parseMetricflowPullConfig({
  repoUrl: 'https://example.com/acme/analytics.git',
});
if (metricflowConfig.branch !== 'main' || metricflowConfig.path !== null) {
  throw new Error('Unexpected MetricFlow pull-config defaults from installed @ktx/context/ingest');
}
if (cli.getKtxCliPackageInfo().name !== '@ktx/cli') {
  throw new Error('Unexpected @ktx/cli package info');
}

const connectorExports = [
  ['@ktx/connector-bigquery', bigqueryConnector.KtxBigQueryScanConnector, bigqueryConnector.KtxBigQueryDialect],
  ['@ktx/connector-clickhouse', clickhouseConnector.KtxClickHouseScanConnector, clickhouseConnector.KtxClickHouseDialect],
  ['@ktx/connector-mysql', mysqlConnector.KtxMysqlScanConnector, mysqlConnector.KtxMysqlDialect],
  ['@ktx/connector-postgres', postgresConnector.KtxPostgresScanConnector, postgresConnector.KtxPostgresDialect],
  ['@ktx/connector-posthog', posthogConnector.KtxPostHogScanConnector, posthogConnector.KtxPostHogDialect],
  ['@ktx/connector-snowflake', snowflakeConnector.KtxSnowflakeScanConnector, snowflakeConnector.KtxSnowflakeDialect],
  ['@ktx/connector-sqlite', sqliteConnector.KtxSqliteScanConnector, sqliteConnector.KtxSqliteDialect],
  ['@ktx/connector-sqlserver', sqlserverConnector.KtxSqlServerScanConnector, sqlserverConnector.KtxSqlServerDialect],
];

for (const [packageName, ScanConnector, Dialect] of connectorExports) {
  if (typeof ScanConnector !== 'function') {
    throw new Error('Missing scan connector export from ' + packageName);
  }
  if (typeof Dialect !== 'function') {
    throw new Error('Missing dialect export from ' + packageName);
  }
}
`;
}

export function npmRuntimeSmokeSource() {
  return `
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createDaemonLookerTableIdentifierParser,
  LocalLookerRuntimeStore,
} from '@ktx/context/ingest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const contextPackageRoot = dirname(require.resolve('@ktx/context/package.json'));

async function requireContextRuntimeAsset(relativePath) {
  await access(join(contextPackageRoot, relativePath));
}

async function run(command, args, options = {}) {
  process.stdout.write('$ ' + command + ' ' + args.join(' ') + '\\n');
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

function requireSuccess(label, result) {
  assert.equal(
    result.code,
    0,
    label + ' failed with code ' + result.code + '\\nstdout:\\n' + result.stdout + '\\nstderr:\\n' + result.stderr,
  );
  assert.equal(result.stderr, '', label + ' wrote unexpected stderr');
}

function requireOutput(label, result, text) {
  assert.match(result.stdout, text, label + ' output did not match ' + text);
}

function parseJsonResult(label, result) {
  requireSuccess(label, result);
  return JSON.parse(result.stdout);
}

function parseJsonFailure(label, result) {
  assert.equal(result.code, 1, label + ' should fail with exit code 1');
  assert.equal(result.stdout, '', label + ' should not write stdout when failing');
  return JSON.parse(result.stderr);
}

function requireIncludes(values, expected, label) {
  assert.ok(Array.isArray(values), label + ' must be an array');
  assert.ok(values.includes(expected), label + ' did not include ' + expected + ': ' + values.join(', '));
}

function getRunId(stdout) {
  const match = stdout.match(/^Run: (.+)$/m);
  assert.ok(match, 'ingest run output did not include a run id');
  return match[1];
}

function requireToolNames(tools, expectedNames) {
  const names = tools.tools.map((tool) => tool.name).sort();
  for (const expectedName of expectedNames) {
    assert.ok(names.includes(expectedName), 'MCP tool list did not include ' + expectedName + ': ' + names.join(', '));
  }
}

function structuredContent(result) {
  assert.ok(result.structuredContent, 'MCP result did not include structuredContent');
  return result.structuredContent;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('expected TCP server address for daemon smoke');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

function httpGetOk(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET' }, (response) => {
      response.resume();
      response.on('end', () => resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300));
    });
    request.on('error', reject);
    request.end();
  });
}

function spawnLogged(command, args, options = {}) {
  const stdout = [];
  const stderr = [];
  let spawnError;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', (error) => {
    spawnError = error;
  });
  return {
    child,
    error() {
      return spawnError;
    },
    output() {
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
    },
  };
}

async function waitForHttpHealth(url, daemon) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (daemon.error()) {
      const output = daemon.output();
      throw new Error(
        'Failed to start ktx-daemon serve-http: ' +
          daemon.error().message +
          '\\nstdout:\\n' +
          output.stdout +
          '\\nstderr:\\n' +
          output.stderr,
      );
    }
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      const output = daemon.output();
      throw new Error(
        'ktx-daemon serve-http exited before health check passed\\nstdout:\\n' +
          output.stdout +
          '\\nstderr:\\n' +
          output.stderr,
      );
    }
    try {
      if (await httpGetOk(url)) {
        return;
      }
    } catch {
      await sleep(100);
      continue;
    }
    await sleep(100);
  }
  const output = daemon.output();
  throw new Error('Timed out waiting for ' + url + '\\nstdout:\\n' + output.stdout + '\\nstderr:\\n' + output.stderr);
}

async function startSemanticDaemon(port) {
  const daemon = spawnLogged('ktx-daemon', [
    'serve-http',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--log-level',
    'warning',
  ]);
  await waitForHttpHealth('http://127.0.0.1:' + port + '/health', daemon);
  return daemon;
}

async function stopSemanticDaemon(daemon) {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
    return;
  }
  daemon.child.kill('SIGTERM');
  const closed = once(daemon.child, 'close').then(() => true);
  const timedOut = sleep(5_000).then(() => false);
  if (!(await Promise.race([closed, timedOut]))) {
    daemon.child.kill('SIGKILL');
    await once(daemon.child, 'close');
  }
}

async function writeSqliteWarehouse(projectDir) {
  const createDb = await run('python', [
    '-c',
    [
      'import sqlite3',
      'import sys',
      'db_path = sys.argv[1]',
      'conn = sqlite3.connect(db_path)',
      'conn.executescript("""',
      'DROP TABLE IF EXISTS orders;',
      'CREATE TABLE orders (',
      '  id INTEGER PRIMARY KEY,',
      '  status TEXT NOT NULL,',
      '  amount INTEGER NOT NULL',
      ');',
      "INSERT INTO orders (status, amount) VALUES ('paid', 20), ('paid', 30), ('open', 10);",
      '""")',
      'conn.close()',
    ].join('\\n'),
    join(projectDir, 'warehouse.db'),
  ]);
  requireSuccess('create sqlite warehouse', createDb);
}

await requireContextRuntimeAsset('skills/notion_synthesize/SKILL.md');
await requireContextRuntimeAsset('prompts/skills/page_triage_classifier.md');
await requireContextRuntimeAsset('prompts/skills/light_extraction.md');
process.stdout.write('packaged ingest runtime assets verified\\n');

const root = await mkdtemp(join(tmpdir(), 'ktx-installed-cli-smoke-'));
try {
  const projectDir = join(root, 'project');
  const sourceDir = join(root, 'source');

  const missingProjectDir = join(root, 'missing-project');
  await mkdir(missingProjectDir, { recursive: true });
  const missingProjectSearch = await run('pnpm', [
    'exec',
    'ktx',
    'agent',
    'sl',
    'list',
    '--json',
    '--query',
    'revenue',
    '--project-dir',
    missingProjectDir,
  ]);
  const missingProjectError = parseJsonFailure('ktx agent sl list missing project', missingProjectSearch);
  assert.equal(missingProjectError.error.code, 'agent_sl_search_missing_project');
  assert.deepEqual(missingProjectError.error.nextSteps, [
    'ktx demo',
    'ktx setup --project-dir ' + missingProjectDir,
    'ktx ingest <connection>',
    'ktx agent sl list --json --query "revenue" --project-dir ' + missingProjectDir,
  ]);
  process.stdout.write('ktx agent sl list missing project guidance verified\\n');

  const init = await run('pnpm', [
    'exec',
    'ktx',
    'setup',
    '--project-dir',
    projectDir,
    '--new',
    '--no-input',
    '--yes',
    '--skip-llm',
    '--skip-embeddings',
    '--skip-databases',
    '--skip-sources',
    '--skip-agents',
  ]);
  requireSuccess('ktx setup', init);
  requireOutput('ktx setup', init, /Project: /);

  const emptyProjectDir = join(root, 'empty-project');
  const emptyInit = await run('pnpm', [
    'exec',
    'ktx',
    'setup',
    '--project-dir',
    emptyProjectDir,
    '--new',
    '--no-input',
    '--yes',
    '--skip-llm',
    '--skip-embeddings',
    '--skip-databases',
    '--skip-sources',
    '--skip-agents',
  ]);
  requireSuccess('ktx setup empty project', emptyInit);
  const emptySearch = await run('pnpm', [
    'exec',
    'ktx',
    'agent',
    'sl',
    'list',
    '--json',
    '--query',
    'revenue',
    '--project-dir',
    emptyProjectDir,
  ]);
  const emptySearchError = parseJsonFailure('ktx agent sl list no connections', emptySearch);
  assert.equal(emptySearchError.error.code, 'agent_sl_search_no_connections');
  assert.deepEqual(emptySearchError.error.nextSteps, [
    'ktx demo',
    'ktx setup --project-dir ' + emptyProjectDir,
    'ktx ingest <connection>',
    'ktx agent sl list --json --query "revenue" --project-dir ' + emptyProjectDir,
  ]);
  process.stdout.write('ktx agent sl list no connections guidance verified\\n');

  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: sqlite',
      '    path: warehouse.db',
      '    readonly: true',
      'storage:',
      '  state: sqlite',
      '  search: sqlite-fts5',
      'scan:',
      '  enrichment:',
      '    mode: deterministic',
      'ingest:',
      '  adapters:',
      '    - fake',
      '    - live-database',
      '',
    ].join('\\n'),
    'utf-8',
  );
  await writeSqliteWarehouse(projectDir);

  const lookerStore = new LocalLookerRuntimeStore({ dbPath: join(projectDir, '.ktx', 'db.sqlite') });
  await lookerStore.setCursors('prod-looker', {
    dashboardsLastSyncedAt: null,
    looksLastSyncedAt: null,
  });
  await lookerStore.upsertConnectionMapping({
    lookerConnectionId: 'prod-looker',
    lookerConnectionName: 'analytics',
    ktxConnectionId: 'warehouse',
    source: 'cli',
  });
  const lookerMappings = await lookerStore.readMappings('prod-looker');
  assert.equal(lookerMappings.length, 1);
  assert.equal(lookerMappings[0].ktxConnectionId, 'warehouse');
  process.stdout.write('Looker local runtime store verified\\n');

  await mkdir(join(projectDir, 'knowledge', 'global'), { recursive: true });
  await writeFile(
    join(projectDir, 'knowledge', 'global', 'revenue.md'),
    [
      '---',
      'summary: Paid order value',
      'tags:',
      '  - finance',
      'refs: []',
      'sl_refs: []',
      'usage_mode: auto',
      '---',
      '',
      'Revenue is the sum of paid order amounts.',
      '',
    ].join('\\n'),
    'utf-8',
  );

  const agentWikiSearch = await run('pnpm', [
    'exec',
    'ktx',
    'agent',
    'wiki',
    'search',
    'revenue',
    '--json',
    '--limit',
    '5',
    '--project-dir',
    projectDir,
  ]);
  const agentWikiSearchJson = parseJsonResult('ktx agent wiki search', agentWikiSearch);
  assert.equal(agentWikiSearchJson.totalFound, 1);
  assert.equal(agentWikiSearchJson.results[0].key, 'revenue');
  assert.equal(agentWikiSearchJson.results[0].path, 'knowledge/global/revenue.md');
  assert.equal(typeof agentWikiSearchJson.results[0].score, 'number');
  requireIncludes(agentWikiSearchJson.results[0].matchReasons, 'lexical', 'agent wiki search match reasons');
  process.stdout.write('ktx agent wiki search hybrid metadata verified\\n');
  await access(join(projectDir, '.ktx', 'db.sqlite'));
  process.stdout.write('SQLite knowledge index: ' + join(projectDir, '.ktx', 'db.sqlite') + '\\n');

  const noSourceSearch = await run('pnpm', [
    'exec',
    'ktx',
    'agent',
    'sl',
    'list',
    '--json',
    '--connection-id',
    'warehouse',
    '--query',
    'revenue',
    '--project-dir',
    projectDir,
  ]);
  const noSourceSearchError = parseJsonFailure('ktx agent sl list no indexed sources', noSourceSearch);
  assert.equal(noSourceSearchError.error.code, 'agent_sl_search_no_indexed_sources');
  assert.deepEqual(noSourceSearchError.error.nextSteps, [
    'ktx demo',
    'ktx setup --project-dir ' + projectDir,
    'ktx ingest <connection>',
    'ktx agent sl list --json --query "revenue" --project-dir ' + projectDir,
  ]);
  process.stdout.write('ktx agent sl list no indexed sources guidance verified\\n');

  const slYaml = [
    'name: orders',
    'table: orders',
    'grain:',
    '  - id',
    'columns:',
    '  - name: id',
    '    type: number',
    '  - name: amount',
    '    type: number',
    'measures:',
    '  - name: order_count',
    '    expr: count(*)',
    'joins: []',
    '',
  ].join('\\n');

  await mkdir(join(projectDir, 'semantic-layer', 'warehouse'), { recursive: true });
  await writeFile(join(projectDir, 'semantic-layer', 'warehouse', 'orders.yaml'), slYaml, 'utf-8');

  const agentSlSearch = await run('pnpm', [
    'exec',
    'ktx',
    'agent',
    'sl',
    'list',
    '--json',
    '--connection-id',
    'warehouse',
    '--query',
    'orders',
    '--project-dir',
    projectDir,
  ]);
  const agentSlSearchJson = parseJsonResult('ktx agent sl list', agentSlSearch);
  assert.equal(agentSlSearchJson.totalSources, 1);
  assert.equal(agentSlSearchJson.sources[0].connectionId, 'warehouse');
  assert.equal(agentSlSearchJson.sources[0].name, 'orders');
  assert.equal(typeof agentSlSearchJson.sources[0].score, 'number');
  requireIncludes(agentSlSearchJson.sources[0].matchReasons, 'lexical', 'agent sl search match reasons');
  process.stdout.write('ktx agent sl list hybrid metadata verified\\n');

  const slQueryFile = join(projectDir, 'sl-query.json');
  await writeFile(slQueryFile, '{"measures":["orders.order_count"],"dimensions":[]}\\n', 'utf-8');

  const slQuery = await run('pnpm', ['exec', 'ktx', 'agent', 'sl', 'query',
    '--json',
    '--connection-id',
    'warehouse',
    '--query-file',
    slQueryFile,
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx agent sl query', slQuery);
  requireOutput('ktx agent sl query', slQuery, /"mode": "compile_only"/);
  requireOutput('ktx agent sl query', slQuery, /orders/);

  const sqliteSlQuery = await run('pnpm', ['exec', 'ktx', 'agent', 'sl', 'query',
    '--json',
    '--connection-id',
    'warehouse',
    '--query-file',
    slQueryFile,
    '--execute',
    '--max-rows',
    '100',
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx agent sl query sqlite execute', sqliteSlQuery);
  requireOutput('ktx agent sl query sqlite execute', sqliteSlQuery, /"dialect": "sqlite"/);
  requireOutput('ktx agent sl query sqlite execute', sqliteSlQuery, /"mode": "executed"/);
  requireOutput('ktx agent sl query sqlite execute', sqliteSlQuery, /"driver": "sqlite"/);
  requireOutput('ktx agent sl query sqlite execute', sqliteSlQuery, /"rows": \\[\\s*\\[\\s*3\\s*\\]\\s*\\]/);
  process.stdout.write('ktx agent sl query sqlite execute verified\\n');

  const structuralScan = await run('pnpm', ['exec', 'ktx', 'dev', 'scan', 'warehouse',
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx scan structural', structuralScan);
  requireOutput('ktx scan structural', structuralScan, /Status: done/);
  requireOutput('ktx scan structural', structuralScan, /Mode: structural/);
  requireOutput('ktx scan structural', structuralScan, /Needs attention\\s+None/);
  const structuralScanRunId = getRunId(structuralScan.stdout);

  const scanStatus = await run('pnpm', ['exec', 'ktx', 'dev', 'scan', 'status',
    '--project-dir',
    projectDir,
    structuralScanRunId,
  ]);
  requireSuccess('ktx scan status', scanStatus);
  requireOutput('ktx scan status', scanStatus, new RegExp('Run: ' + structuralScanRunId));
  requireOutput('ktx scan status', scanStatus, /Status: done/);
  requireOutput('ktx scan status', scanStatus, /Mode: structural/);

  const scanReport = await run('pnpm', ['exec', 'ktx', 'dev', 'scan', 'report',
    '--project-dir',
    projectDir,
    '--json',
    structuralScanRunId,
  ]);
  requireSuccess('ktx scan report', scanReport);
  const scanReportJson = JSON.parse(scanReport.stdout);
  assert.equal(scanReportJson.mode, 'structural');
  assert.equal(scanReportJson.connectionId, 'warehouse');
  assert.equal(scanReportJson.manifestShardsWritten, 1);
  assert.deepEqual(scanReportJson.artifactPaths.enrichmentArtifacts, []);
  assert.deepEqual(scanReportJson.artifactPaths.manifestShards, ['semantic-layer/warehouse/_schema/public.yaml']);
  await access(join(projectDir, 'semantic-layer', 'warehouse', '_schema', 'public.yaml'));
  process.stdout.write('ktx scan structural verified: ' + structuralScanRunId + '\\n');

  const enrichedScan = await run('pnpm', ['exec', 'ktx', 'dev', 'scan', 'warehouse',
    '--project-dir',
    projectDir,
    '--mode',
    'enriched',
  ]);
  requireSuccess('ktx scan enriched', enrichedScan);
  requireOutput('ktx scan enriched', enrichedScan, /Status: done/);
  requireOutput('ktx scan enriched', enrichedScan, /Mode: enriched/);
  const enrichedScanRunId = getRunId(enrichedScan.stdout);
  const enrichedScanReport = await run('pnpm', ['exec', 'ktx', 'dev', 'scan', 'report',
    '--project-dir',
    projectDir,
    '--json',
    enrichedScanRunId,
  ]);
  requireSuccess('ktx scan enriched report', enrichedScanReport);
  const enrichedScanReportJson = JSON.parse(enrichedScanReport.stdout);
  assert.equal(enrichedScanReportJson.mode, 'enriched');
  assert.ok(enrichedScanReportJson.artifactPaths.enrichmentArtifacts.length > 0);
  assert.deepEqual(enrichedScanReportJson.artifactPaths.manifestShards, ['semantic-layer/warehouse/_schema/public.yaml']);
  process.stdout.write('ktx scan enriched verified: ' + enrichedScanRunId + '\\n');

  await mkdir(join(sourceDir, 'orders'), { recursive: true });
  await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\\n', 'utf-8');

  const ingestRun = await run('pnpm', ['exec', 'ktx', 'dev', 'ingest', 'run',
    '--project-dir',
    projectDir,
    '--connection-id',
    'warehouse',
    '--adapter',
    'fake',
    '--source-dir',
    sourceDir,
  ]);
  assert.equal(ingestRun.code, 1, 'ktx dev ingest run without an LLM provider must fail');
  assert.match(
    ingestRun.stderr,
    /ktx dev ingest run requires llm\\.provider\\.backend: anthropic, vertex, or gateway, or an injected agentRunner/,
  );

  await access(join(projectDir, '.ktx', 'db.sqlite'));
  process.stdout.write('ktx dev ingest provider guard verified\\n');

  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: sqlite',
      '    path: warehouse.db',
      '    readonly: true',
      'storage:',
      '  state: sqlite',
      '  search: sqlite-fts5',
      'scan:',
      '  enrichment:',
      '    mode: deterministic',
      'llm:',
      '  provider:',
      '    backend: gateway',
      '    gateway:',
      '      api_key: env:AI_GATEWAY_API_KEY',
      '  models:',
      '    default: smoke/provider',
      'ingest:',
      '  adapters:',
      '    - fake',
      '    - live-database',
      '',
    ].join('\\n'),
    'utf-8',
  );

  const daemonPort = await getAvailablePort();
  const semanticComputeUrl = 'http://127.0.0.1:' + daemonPort;
  process.stdout.write('ktx-daemon serve-http --host 127.0.0.1 --port ' + daemonPort + '\\n');
  const daemon = await startSemanticDaemon(daemonPort);
  const lookerParser = createDaemonLookerTableIdentifierParser({ baseUrl: semanticComputeUrl });
  const parsedLookerTables = await lookerParser.parse([
    { key: 'orders', sql_table_name: 'orders', dialect: 'sqlite' },
  ]);
  assert.equal(parsedLookerTables.orders.ok, true);
  assert.equal(parsedLookerTables.orders.name, 'orders');
  assert.equal(parsedLookerTables.orders.canonical_table, 'orders');
  process.stdout.write('Looker daemon table identifier parser verified\\n');
  const client = new Client({ name: 'ktx-artifact-smoke-client', version: '0.0.0' });
  process.stdout.write('ktx serve --mcp stdio --semantic-compute-url ' + semanticComputeUrl + ' --execute-queries\\n');
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: [
      'exec',
      'ktx',
      'serve', '--mcp', 'stdio',
      '--project-dir',
      projectDir,
      '--user-id',
      'artifact-smoke-user',
      '--semantic-compute-url',
      semanticComputeUrl,
      '--execute-queries',
      '--memory-capture', '--memory-model', 'smoke/provider',
    ],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...process.env,
      AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? 'artifact-smoke-token',
    },
  });
  const mcpServerStderr = [];
  transport.stderr?.on('data', (chunk) => mcpServerStderr.push(chunk));

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    requireToolNames(tools, [
      'connection_list',
      'connection_test',
      'ingest_status',
      'ingest_trigger',
      'knowledge_read',
      'knowledge_search',
      'knowledge_write',
      'memory_capture',
      'memory_capture_status',
      'scan_list_artifacts',
      'scan_read_artifact',
      'scan_report',
      'scan_status',
      'scan_trigger',
      'sl_list_sources',
      'sl_query',
      'sl_read_source',
      'sl_validate',
      'sl_write_source',
    ]);
    const slValidateResult = structuredContent(await client.callTool({
      name: 'sl_validate',
      arguments: {
        connectionId: 'warehouse',
        names: ['orders'],
      },
    }));
    assert.equal(slValidateResult.success, true);
    assert.deepEqual(slValidateResult.errors, []);
    const slQueryResult = structuredContent(await client.callTool({
      name: 'sl_query',
      arguments: {
        connectionId: 'warehouse',
        measures: ['orders.order_count'],
        limit: 5,
      },
    }));
    assert.equal(slQueryResult.connectionId, 'warehouse');
    assert.equal(slQueryResult.dialect, 'sqlite');
    assert.match(slQueryResult.sql, /orders/);
    assert.deepEqual(slQueryResult.headers, ['order_count']);
    assert.deepEqual(slQueryResult.rows, [[3]]);
    assert.equal(slQueryResult.totalRows, 1);
    assert.equal(slQueryResult.plan.execution.mode, 'executed');
    assert.equal(slQueryResult.plan.execution.driver, 'sqlite');

    const connectionTest = structuredContent(await client.callTool({
      name: 'connection_test',
      arguments: {
        connectionId: 'warehouse',
      },
    }));
    assert.equal(connectionTest.id, 'warehouse');
    assert.equal(connectionTest.ok, true);

    const mcpScanTrigger = structuredContent(await client.callTool({
      name: 'scan_trigger',
      arguments: {
        connectionId: 'warehouse',
        mode: 'structural',
      },
    }));
    assert.equal(mcpScanTrigger.connectionId, 'warehouse');
    assert.equal(mcpScanTrigger.report.mode, 'structural');
    assert.equal(mcpScanTrigger.report.manifestShardsWritten, 1);

    const mcpScanStatus = structuredContent(await client.callTool({
      name: 'scan_status',
      arguments: {
        runId: mcpScanTrigger.runId,
      },
    }));
    assert.equal(mcpScanStatus.runId, mcpScanTrigger.runId);
    assert.equal(mcpScanStatus.status, 'done');

    const mcpScanReport = structuredContent(await client.callTool({
      name: 'scan_report',
      arguments: {
        runId: mcpScanTrigger.runId,
      },
    }));
    assert.equal(mcpScanReport.runId, mcpScanTrigger.runId);
    assert.deepEqual(mcpScanReport.artifactPaths.manifestShards, ['semantic-layer/warehouse/_schema/public.yaml']);

    const mcpScanArtifacts = structuredContent(await client.callTool({
      name: 'scan_list_artifacts',
      arguments: {
        runId: mcpScanTrigger.runId,
      },
    }));
    const manifestArtifact = mcpScanArtifacts.artifacts.find((artifact) => artifact.type === 'manifest_shard');
    assert.ok(manifestArtifact, 'scan_list_artifacts did not include a manifest shard');
    assert.equal(manifestArtifact.path, 'semantic-layer/warehouse/_schema/public.yaml');

    const mcpManifestRead = structuredContent(await client.callTool({
      name: 'scan_read_artifact',
      arguments: {
        runId: mcpScanTrigger.runId,
        path: manifestArtifact.path,
      },
    }));
    assert.equal(mcpManifestRead.path, 'semantic-layer/warehouse/_schema/public.yaml');
    assert.equal(mcpManifestRead.type, 'manifest_shard');
    assert.match(mcpManifestRead.content, /orders:/);
  } catch (error) {
    const stderr = Buffer.concat(mcpServerStderr).toString('utf8');
    if (stderr) {
      error.message += '\\nktx serve stderr:\\n' + stderr;
    }
    throw error;
  } finally {
    await client.close();
    await stopSemanticDaemon(daemon);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
`;
}

export function npmDemoSmokeSource() {
  return `
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  process.stdout.write('$ ' + command + ' ' + args.join(' ') + '\\n');
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      timeout: 45_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

function requireSuccess(label, result) {
  assert.equal(
    result.code,
    0,
    label + ' failed with code ' + result.code + '\\nstdout:\\n' + result.stdout + '\\nstderr:\\n' + result.stderr,
  );
}

function requireStdout(label, result, pattern) {
  assert.match(result.stdout, pattern, label + ' stdout did not match ' + pattern);
}

const root = await mkdtemp(join(tmpdir(), 'ktx-packed-demo-smoke-'));
try {
  const projectDir = join(root, 'demo-project');

  const help = await run('pnpm', ['exec', 'ktx', '--help']);
  requireSuccess('ktx --help', help);
  requireStdout('ktx --help', help, /Usage: ktx/);
  requireStdout('ktx --help', help, /setup/);

  const seeded = await run(
    'pnpm',
    ['exec', 'ktx', 'setup', 'demo', '--project-dir', projectDir, '--no-input', '--plain'],
  );
  requireSuccess('ktx setup demo seeded', seeded);
  requireStdout('ktx setup demo seeded', seeded, /Mode: seeded/);
  requireStdout('ktx setup demo seeded', seeded, /Source: packaged demo project/);
  requireStdout('ktx setup demo seeded', seeded, /LLM calls: none/);
  requireStdout('ktx setup demo seeded', seeded, /ktx serve --mcp stdio/);
  assert.doesNotMatch(seeded.stdout, new RegExp(['--mode', 'deterministic'].join(' ')));
  assert.doesNotMatch(seeded.stdout, /KTX memory flow/);
  assert.equal(seeded.stderr, '', 'ktx setup demo seeded wrote unexpected stderr');

  const demoWikiSearch = await run('pnpm', [
    'exec',
    'ktx',
    'agent',
    'wiki',
    'search',
    'ARR contract',
    '--json',
    '--limit',
    '5',
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx seeded demo agent wiki search', demoWikiSearch);
  const demoWikiSearchJson = JSON.parse(demoWikiSearch.stdout);
  assert.ok(demoWikiSearchJson.totalFound > 0, 'seeded demo wiki search should find results');
  assert.ok(
    demoWikiSearchJson.results.some((result) => Array.isArray(result.matchReasons) && result.matchReasons.length > 0),
    'seeded demo wiki search should expose match reasons',
  );
  process.stdout.write('ktx seeded demo agent wiki search verified\\n');

  const demoSlSearch = await run('pnpm', [
    'exec',
    'ktx',
    'agent',
    'sl',
    'list',
    '--json',
    '--query',
    'ARR',
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx seeded demo agent sl search', demoSlSearch);
  const demoSlSearchJson = JSON.parse(demoSlSearch.stdout);
  assert.ok(demoSlSearchJson.totalSources > 0, 'seeded demo semantic-layer search should find sources');
  assert.ok(
    demoSlSearchJson.sources.some((source) => Array.isArray(source.matchReasons) && source.matchReasons.length > 0),
    'seeded demo semantic-layer search should expose match reasons',
  );
  process.stdout.write('ktx seeded demo agent sl search verified\\n');

  const doctor = await run('pnpm', ['exec', 'ktx', 'dev', 'doctor', 'setup', '--no-input']);
  assert.ok([0, 1].includes(doctor.code), 'ktx dev doctor setup exit code must be 0 or 1');
  requireStdout('ktx dev doctor setup', doctor, /KTX setup doctor/);
  requireStdout('ktx dev doctor setup', doctor, /Node 22\\+/);
  assert.equal(doctor.stderr, '', 'ktx dev doctor setup wrote unexpected stderr');
} finally {
  await rm(root, { recursive: true, force: true });
}
`;
}

export function pythonVerifySource() {
  return `
import importlib.metadata

import semantic_layer
import ktx_daemon

assert importlib.metadata.version("kaelio-ktx") == "0.1.0"
assert semantic_layer is not None
assert ktx_daemon.PACKAGE_NAME == "ktx-daemon"
`;
}

function pythonExecutable(projectDir) {
  if (process.platform === 'win32') {
    return join(projectDir, '.venv', 'Scripts', 'python.exe');
  }
  return join(projectDir, '.venv', 'bin', 'python');
}

export function npmSmokePythonEnv(projectDir, baseEnv = process.env) {
  const binDir = process.platform === 'win32' ? join(projectDir, '.venv', 'Scripts') : join(projectDir, '.venv', 'bin');
  const existingPath = baseEnv.PATH ?? '';

  return Object.assign({}, baseEnv, {
    PATH: existingPath ? `${binDir}${delimiter}${existingPath}` : binDir,
  });
}

async function buildArtifacts(layout) {
  await rm(layout.artifactDir, { recursive: true, force: true });
  await mkdir(layout.npmDir, { recursive: true });
  await mkdir(layout.pythonDir, { recursive: true });

  const commands = buildArtifactCommands(layout);
  const npmBuildCount = NPM_ARTIFACT_PACKAGES.length;
  const npmPackStart = commands.length - NPM_ARTIFACT_PACKAGES.length;

  for (const command of commands.slice(0, npmBuildCount)) {
    await runCommand(command.command, command.args, { cwd: command.cwd });
  }
  for (const command of commands.slice(npmBuildCount, npmPackStart)) {
    await runCommand(command.command, command.args, { cwd: command.cwd });
  }
  const pythonArtifacts = await findPythonArtifacts(layout.pythonDir);
  await copyRuntimeWheelAssets(layout, pythonArtifacts);
  for (const command of commands.slice(npmPackStart)) {
    await runCommand(command.command, command.args, { cwd: command.cwd });
  }

  for (const packageInfo of NPM_ARTIFACT_PACKAGES) {
    await assertPathExists(layout.npmTarballs[packageInfo.name], `${packageInfo.name} tarball`);
  }
  await writeArtifactManifest(layout);
  await assertPathExists(artifactManifestPath(layout), 'artifact manifest');
}

async function verifyNpmArtifacts(layout, tmpRoot) {
  for (const packageInfo of NPM_ARTIFACT_PACKAGES) {
    await assertPathExists(layout.npmTarballs[packageInfo.name], `${packageInfo.name} tarball`);
  }
  const pythonArtifacts = await findPythonArtifacts(layout.pythonDir);

  const projectDir = join(tmpRoot, 'npm-clean-install');
  const python = pythonExecutable(projectDir);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'package.json'),
    `${JSON.stringify(npmSmokePackageJson(layout), null, 2)}\n`,
  );
  await writeFile(join(projectDir, 'verify-npm.mjs'), npmVerifySource());
  await writeFile(join(projectDir, 'verify-installed-cli.mjs'), npmRuntimeSmokeSource());
  await writeFile(join(projectDir, 'verify-installed-demo.mjs'), npmDemoSmokeSource());

  await runCommand('pnpm', ['install'], { cwd: projectDir });
  await runCommand('pnpm', ['rebuild', 'better-sqlite3'], { cwd: projectDir });
  await runCommand('uv', ['venv', '.venv'], { cwd: projectDir });
  await runCommand('uv', pythonArtifactInstallArgs(python, pythonArtifacts), {
    cwd: projectDir,
  });
  await runCommand('node', ['verify-npm.mjs'], { cwd: projectDir });
  await runCommand('pnpm', ['exec', 'ktx', '--version'], { cwd: projectDir });
  await runCommand('node', ['verify-installed-cli.mjs'], {
    cwd: projectDir,
    env: npmSmokePythonEnv(projectDir),
  });
  await runCommand('node', ['verify-installed-demo.mjs'], {
    cwd: projectDir,
    env: npmSmokePythonEnv(projectDir),
  });
}

async function verifyNpmDemoArtifacts(layout, tmpRoot) {
  for (const packageInfo of NPM_ARTIFACT_PACKAGES) {
    await assertPathExists(layout.npmTarballs[packageInfo.name], `${packageInfo.name} tarball`);
  }

  const projectDir = join(tmpRoot, 'npm-demo-clean-install');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'package.json'), `${JSON.stringify(npmSmokePackageJson(layout), null, 2)}\n`);
  await writeFile(join(projectDir, 'verify-installed-demo.mjs'), npmDemoSmokeSource());

  await runCommand('pnpm', ['install'], { cwd: projectDir });
  await runCommand('node', ['verify-installed-demo.mjs'], { cwd: projectDir });
}

async function verifyPythonArtifacts(layout, tmpRoot) {
  const pythonArtifacts = await findPythonArtifacts(layout.pythonDir);

  const projectDir = join(tmpRoot, 'python-clean-install');
  await mkdir(projectDir, { recursive: true });
  const python = pythonExecutable(projectDir);
  await writeFile(join(projectDir, 'verify_python.py'), pythonVerifySource());

  await runCommand('uv', ['venv', '.venv'], { cwd: projectDir });
  await runCommand('uv', pythonArtifactInstallArgs(python, pythonArtifacts), {
    cwd: projectDir,
  });
  await runCommand(python, ['verify_python.py'], { cwd: projectDir });
  await runCommand(python, ['-m', 'ktx_daemon', 'semantic-validate'], {
    cwd: projectDir,
    input: `${JSON.stringify({ sources: [ordersSource], dialect: 'postgres' })}\n`,
  });
}

async function verifyArtifacts(layout) {
  await verifyArtifactManifest(layout);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'ktx-artifacts-'));
  try {
    await verifyNpmArtifacts(layout, tmpRoot);
    await verifyPythonArtifacts(layout, tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function verifyDemoArtifacts(layout) {
  await verifyArtifactManifest(layout);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'ktx-demo-artifacts-'));
  try {
    await verifyNpmDemoArtifacts(layout, tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function main() {
  const command = process.argv[2] ?? 'check';
  const layout = packageArtifactLayout();

  if (command === 'build') {
    await buildArtifacts(layout);
    return;
  }
  if (command === 'verify') {
    await verifyArtifacts(layout);
    return;
  }
  if (command === 'verify-demo') {
    await verifyDemoArtifacts(layout);
    return;
  }
  if (command === 'verify-manifest') {
    await verifyArtifactManifest(layout);
    return;
  }
  if (command === 'check') {
    await buildArtifacts(layout);
    await verifyArtifacts(layout);
    return;
  }

  throw new Error(`Unknown package artifact command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
