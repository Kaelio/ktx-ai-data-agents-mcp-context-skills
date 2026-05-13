#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
} from './build-python-runtime-wheel.mjs';
import {
  PUBLIC_NPM_PACKAGE_NAME,
  PUBLIC_NPM_PACKAGE_VERSION,
  publicNpmPackageTarballName,
} from './build-public-npm-package.mjs';

export {
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
};

export const INTERNAL_NPM_WORKSPACE_PACKAGES = [
  { name: '@ktx/context', packageRoot: 'packages/context' },
  { name: '@ktx/llm', packageRoot: 'packages/llm' },
  { name: '@ktx/connector-bigquery', packageRoot: 'packages/connector-bigquery' },
  { name: '@ktx/connector-clickhouse', packageRoot: 'packages/connector-clickhouse' },
  { name: '@ktx/connector-mysql', packageRoot: 'packages/connector-mysql' },
  { name: '@ktx/connector-postgres', packageRoot: 'packages/connector-postgres' },
  { name: '@ktx/connector-snowflake', packageRoot: 'packages/connector-snowflake' },
  { name: '@ktx/connector-sqlite', packageRoot: 'packages/connector-sqlite' },
  { name: '@ktx/connector-sqlserver', packageRoot: 'packages/connector-sqlserver' },
  { name: '@ktx/cli', packageRoot: 'packages/cli' },
];

export const NPM_ARTIFACT_PACKAGES = [{ name: PUBLIC_NPM_PACKAGE_NAME, packageRoot: 'packages/cli' }];

export const CLI_PYTHON_ASSET_MANIFEST = 'manifest.json';

const CONNECTOR_PACKAGE_NAMES = INTERNAL_NPM_WORKSPACE_PACKAGES
  .map((packageInfo) => packageInfo.name)
  .filter((packageName) => packageName.startsWith('@ktx/connector-'));

const NPM_ARTIFACT_BUILD_ORDER = ['@ktx/llm', '@ktx/context', ...CONNECTOR_PACKAGE_NAMES, '@ktx/cli'];

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function npmPackageTarballName(packageName) {
  if (packageName !== PUBLIC_NPM_PACKAGE_NAME) {
    throw new Error(`Unsupported npm artifact package: ${packageName}`);
  }
  return publicNpmPackageTarballName(PUBLIC_NPM_PACKAGE_VERSION);
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
    contextTarball: npmTarballs[PUBLIC_NPM_PACKAGE_NAME],
    cliTarball: npmTarballs[PUBLIC_NPM_PACKAGE_NAME],
    connectorTarballs: {},
    manifestPath: join(artifactDir, 'manifest.json'),
  };
}

export function buildArtifactCommands(layout) {
  const packagesByName = new Map(INTERNAL_NPM_WORKSPACE_PACKAGES.map((packageInfo) => [packageInfo.name, packageInfo]));
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
  const publicPackageCommand = {
    command: process.execPath,
    args: ['scripts/build-public-npm-package.mjs'],
    cwd: layout.rootDir,
  };

  return [
    ...npmBuildCommands,
    {
      command: process.execPath,
      args: ['scripts/build-python-runtime-wheel.mjs'],
      cwd: layout.rootDir,
    },
    publicPackageCommand,
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

function findOne(files, distributionName, suffix, label, pythonDir, version) {
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
      'kaelio-ktx dev runtime wheel',
      pythonDir,
      RUNTIME_WHEEL_PACKAGE_VERSION,
    ),
  };
}

export function artifactManifestPath(layout) {
  return layout.manifestPath ?? join(layout.artifactDir, 'manifest.json');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
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
  const expectedSourceName = packageInfo.name === PUBLIC_NPM_PACKAGE_NAME ? '@ktx/cli' : packageInfo.name;
  if (packageJson.name !== expectedSourceName) {
    throw new Error(
      `Unexpected package name in ${packageInfo.packageRoot}/package.json: expected ${expectedSourceName}, got ${packageJson.name}`,
    );
  }
  const isPublicKtxPackage = packageInfo.name === PUBLIC_NPM_PACKAGE_NAME;
  return releaseMetadataEntry({
    ecosystem: 'npm',
    packageName: packageInfo.name,
    packageRoot: packageInfo.packageRoot,
    packageVersion: isPublicKtxPackage ? PUBLIC_NPM_PACKAGE_VERSION : packageJson.version,
    privatePackage: isPublicKtxPackage ? false : packageJson.private === true,
  });
}

export async function packageReleaseMetadata(rootDir = scriptRootDir()) {
  const npmPackages = await Promise.all(
    NPM_ARTIFACT_PACKAGES.map((packageInfo) => readNpmPackageMetadata(rootDir, packageInfo)),
  );

  return [
    ...npmPackages,
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

export function npmSmokePackageJson(layout) {
  return {
    name: 'ktx-artifact-npm-smoke',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@kaelio/ktx': `file:${layout.cliTarball}`,
    },
  };
}

export function npmSmokePnpmWorkspaceYaml() {
  return ['packages:', '  - "."', 'allowBuilds:', '  better-sqlite3: true', ''].join('\n');
}

export function npmVerifySource() {
  return `
const cli = await import('@kaelio/ktx');

if (cli.getKtxCliPackageInfo().name !== '@kaelio/ktx') {
  throw new Error('Unexpected @kaelio/ktx package info');
}
if (typeof cli.runKtxCli !== 'function') {
  throw new Error('Missing runKtxCli export');
}
`;
}

export function npmRuntimeSmokeSource() {
  return `
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

function requireProjectStderr(label, result, projectDir) {
  assert.equal(
    result.code,
    0,
    label + ' failed with code ' + result.code + '\\nstdout:\\n' + result.stdout + '\\nstderr:\\n' + result.stderr,
  );
  assert.equal(result.stderr, 'Project: ' + projectDir + '\\n', label + ' wrote unexpected stderr');
}

function requireSuccessWithStderr(label, result, stderrPattern) {
  assert.equal(
    result.code,
    0,
    label + ' failed with code ' + result.code + '\\nstdout:\\n' + result.stdout + '\\nstderr:\\n' + result.stderr,
  );
  assert.match(result.stderr, stderrPattern, label + ' stderr did not match ' + stderrPattern);
}

function requireOutput(label, result, text) {
  assert.match(result.stdout, text, label + ' output did not match ' + text);
}

function parseJsonResult(label, result) {
  requireSuccess(label, result);
  return JSON.parse(result.stdout);
}

function parseJsonResultWithExitCode(label, result, expectedCode) {
  assert.equal(
    result.code,
    expectedCode,
    label + ' failed with code ' + result.code + '\\nstdout:\\n' + result.stdout + '\\nstderr:\\n' + result.stderr,
  );
  return JSON.parse(result.stdout);
}

function requireIncludes(values, expected, label) {
  assert.ok(Array.isArray(values), label + ' must be an array');
  assert.ok(values.includes(expected), label + ' did not include ' + expected + ': ' + values.join(', '));
}

function getRunId(stdout) {
  const match = stdout.match(/^Run: (.+)$/m);
  assert.ok(match, 'ingest output did not include a run id');
  return match[1];
}

async function writeSqliteWarehouse(projectDir) {
  const database = new DatabaseSync(join(projectDir, 'warehouse.db'));
  try {
    database.exec(\`
DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  amount INTEGER NOT NULL
);
INSERT INTO orders (status, amount) VALUES ('paid', 20), ('paid', 30), ('open', 10);
\`);
  } finally {
    database.close();
  }
}

const root = await mkdtemp(join(tmpdir(), 'ktx-installed-cli-smoke-'));
const previousRuntimeRoot = process.env.KTX_RUNTIME_ROOT;
process.env.KTX_RUNTIME_ROOT = join(root, 'managed-runtime');
let daemonStarted = false;
try {
  const projectDir = join(root, 'project');

  const version = await run('pnpm', ['exec', 'ktx', '--version']);
  requireSuccess('ktx public package version', version);
  requireOutput('ktx public package version', version, /@kaelio\\/ktx 0\\.1\\.0/);

  const runtimeStatusBefore = parseJsonResultWithExitCode(
    'ktx dev runtime status missing',
    await run('pnpm', ['exec', 'ktx', 'dev', 'runtime', 'status', '--json']),
    1,
  );
  assert.equal(runtimeStatusBefore.kind, 'missing');
  assert.equal(runtimeStatusBefore.layout.runtimeRoot, process.env.KTX_RUNTIME_ROOT);
  process.stdout.write('ktx managed runtime starts missing in isolated root\\n');

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
  requireProjectStderr('ktx setup', init, projectDir);
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
  requireProjectStderr('ktx setup empty project', emptyInit, emptyProjectDir);
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
      '',
    ].join('\\n'),
    'utf-8',
  );
  await writeSqliteWarehouse(projectDir);

  await mkdir(join(projectDir, 'wiki', 'global'), { recursive: true });
  await writeFile(
    join(projectDir, 'wiki', 'global', 'revenue.md'),
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

  const wikiSearch = await run('pnpm', [
    'exec',
    'ktx',
    'wiki',
    'search',
    'revenue',
    '--json',
    '--limit',
    '5',
    '--project-dir',
    projectDir,
  ]);
  const wikiSearchJson = parseJsonResult('ktx wiki search', wikiSearch);
  assert.equal(wikiSearchJson.kind, 'list');
  assert.equal(wikiSearchJson.data.items.length, 1);
  assert.equal(wikiSearchJson.data.items[0].key, 'revenue');
  assert.equal(wikiSearchJson.data.items[0].path, 'wiki/global/revenue.md');
  assert.equal(typeof wikiSearchJson.data.items[0].score, 'number');
  requireIncludes(wikiSearchJson.data.items[0].matchReasons, 'lexical', 'wiki search match reasons');
  process.stdout.write('ktx wiki search hybrid metadata verified\\n');
  await access(join(projectDir, '.ktx', 'db.sqlite'));
  process.stdout.write('SQLite wiki index: ' + join(projectDir, '.ktx', 'db.sqlite') + '\\n');

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

  const slSearch = await run('pnpm', [
    'exec',
    'ktx',
    'sl',
    'search',
    'orders',
    '--json',
    '--connection-id',
    'warehouse',
    '--project-dir',
    projectDir,
  ]);
  const slSearchJson = parseJsonResult('ktx sl search', slSearch);
  assert.equal(slSearchJson.kind, 'list');
  assert.equal(slSearchJson.data.items.length, 1);
  assert.equal(slSearchJson.data.items[0].connectionId, 'warehouse');
  assert.equal(slSearchJson.data.items[0].name, 'orders');
  assert.equal(typeof slSearchJson.data.items[0].score, 'number');
  requireIncludes(slSearchJson.data.items[0].matchReasons, 'lexical', 'sl search match reasons');
  process.stdout.write('ktx sl search hybrid metadata verified\\n');

  const slQuery = await run('pnpm', ['exec', 'ktx', 'sl', 'query',
    '--connection-id',
    'warehouse',
    '--measure',
    'orders.order_count',
    '--format',
    'json',
    '--yes',
    '--project-dir',
    projectDir,
  ]);
  requireSuccessWithStderr(
    'ktx sl query first managed runtime install',
    slQuery,
    /Installing KTX Python runtime \\(core\\) with uv[\\s\\S]*KTX Python runtime ready:/,
  );
  requireOutput('ktx sl query first managed runtime install', slQuery, /"mode": "compile_only"/);
  requireOutput('ktx sl query first managed runtime install', slQuery, /orders/);

  const runtimeStatusAfter = parseJsonResult(
    'ktx dev runtime status ready',
    await run('pnpm', ['exec', 'ktx', 'dev', 'runtime', 'status', '--json']),
  );
  assert.equal(runtimeStatusAfter.kind, 'ready');
  assert.deepEqual(runtimeStatusAfter.manifest.features, ['core']);
  assert.equal(runtimeStatusAfter.layout.runtimeRoot, process.env.KTX_RUNTIME_ROOT);
  process.stdout.write('ktx managed runtime lazy install verified\\n');

  const sqliteSlQuery = await run('pnpm', ['exec', 'ktx', 'sl', 'query',
    '--connection-id',
    'warehouse',
    '--measure',
    'orders.order_count',
    '--format',
    'json',
    '--execute',
    '--max-rows',
    '100',
    '--yes',
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx sl query sqlite execute', sqliteSlQuery);
  requireOutput('ktx sl query sqlite execute', sqliteSlQuery, /"dialect": "sqlite"/);
  requireOutput('ktx sl query sqlite execute', sqliteSlQuery, /"mode": "executed"/);
  requireOutput('ktx sl query sqlite execute', sqliteSlQuery, /"driver": "sqlite"/);
  requireOutput('ktx sl query sqlite execute', sqliteSlQuery, /"rows": \\[\\s*\\[\\s*3\\s*\\]\\s*\\]/);
  process.stdout.write('ktx sl query sqlite execute verified\\n');

  const runtimeDoctor = await run('pnpm', ['exec', 'ktx', 'dev', 'runtime', 'status']);
  requireSuccess('ktx dev runtime status', runtimeDoctor);
  requireOutput('ktx dev runtime status', runtimeDoctor, /KTX Python runtime/);
  requireOutput('ktx dev runtime status', runtimeDoctor, /status: ready/);
  process.stdout.write('ktx dev runtime status verified\\n');

  const runtimeStart = await run('pnpm', ['exec', 'ktx', 'dev', 'runtime', 'start']);
  requireSuccess('ktx dev runtime start', runtimeStart);
  daemonStarted = true;
  requireOutput('ktx dev runtime start', runtimeStart, /Started KTX Python daemon/);
  requireOutput('ktx dev runtime start', runtimeStart, /url: http:\\/\\/127\\.0\\.0\\.1:\\d+/);
  requireOutput('ktx dev runtime start', runtimeStart, /features: core/);

  const runtimeStartReuse = await run('pnpm', ['exec', 'ktx', 'dev', 'runtime', 'start']);
  requireSuccess('ktx dev runtime start reuse', runtimeStartReuse);
  requireOutput('ktx dev runtime start reuse', runtimeStartReuse, /Using existing KTX Python daemon/);
  requireOutput('ktx dev runtime start reuse', runtimeStartReuse, /features: core/);

  const runtimeStop = await run('pnpm', ['exec', 'ktx', 'dev', 'runtime', 'stop']);
  requireSuccess('ktx dev runtime stop', runtimeStop);
  daemonStarted = false;
  requireOutput('ktx dev runtime stop', runtimeStop, /Stopped KTX Python daemon/);
  process.stdout.write('ktx dev runtime daemon lifecycle verified\\n');

  const structuralScan = await run('pnpm', ['exec', 'ktx', 'ingest', 'warehouse',
    '--project-dir',
    projectDir,
    '--fast',
    '--no-input',
  ]);
  requireProjectStderr('ktx ingest fast', structuralScan, projectDir);
  requireOutput('ktx ingest fast', structuralScan, /Ingest finished/);
  requireOutput('ktx ingest fast', structuralScan, /Database schema/);
  requireOutput('ktx ingest fast', structuralScan, /warehouse\\s+done/);
  const structuralScanRunId = getRunId(structuralScan.stdout);
  await access(join(projectDir, 'semantic-layer', 'warehouse', '_schema', 'public.yaml'));
  process.stdout.write('ktx ingest fast verified: ' + structuralScanRunId + '\\n');

  const enrichedScan = await run('pnpm', ['exec', 'ktx', 'ingest', 'warehouse',
    '--project-dir',
    projectDir,
    '--deep',
    '--no-input',
  ]);
  requireProjectStderr('ktx ingest deep', enrichedScan, projectDir);
  requireOutput('ktx ingest deep', enrichedScan, /Ingest finished/);
  requireOutput('ktx ingest deep', enrichedScan, /Database schema/);
  requireOutput('ktx ingest deep', enrichedScan, /warehouse\\s+done/);
  const enrichedScanRunId = getRunId(enrichedScan.stdout);
  process.stdout.write('ktx ingest deep verified: ' + enrichedScanRunId + '\\n');

  await access(join(projectDir, '.ktx', 'db.sqlite'));
  process.stdout.write('ktx ingest state verified\\n');
} finally {
  if (daemonStarted) {
    await run('pnpm', ['exec', 'ktx', 'dev', 'runtime', 'stop']);
  }
  if (previousRuntimeRoot === undefined) {
    delete process.env.KTX_RUNTIME_ROOT;
  } else {
    process.env.KTX_RUNTIME_ROOT = previousRuntimeRoot;
  }
  await rm(root, { recursive: true, force: true });
}
`;
}

export function npmCliSmokeSource() {
  return `
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

const root = await mkdtemp(join(tmpdir(), 'ktx-cli-smoke-'));
try {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packageJson.dependencies), ['@kaelio/ktx']);

  const help = await run('pnpm', ['exec', 'ktx', '--help']);
  requireSuccess('ktx --help', help);
  requireStdout('ktx --help', help, /Usage: ktx/);
  requireStdout('ktx --help', help, /setup/);

  const setupHelp = await run('pnpm', ['exec', 'ktx', 'setup', '--help']);
  requireSuccess('ktx setup --help', setupHelp);
  requireStdout('ktx setup --help', setupHelp, /Usage: ktx setup/);
  requireStdout('ktx setup --help', setupHelp, /--no-input/);

  const doctor = await run('pnpm', ['exec', 'ktx', 'status', '--no-input']);
  assert.ok([0, 1].includes(doctor.code), 'ktx status setup exit code must be 0 or 1');
  requireStdout('ktx status setup', doctor, /KTX setup doctor/);
  requireStdout('ktx status setup', doctor, /Node 22\\+/);
  assert.equal(doctor.stderr, '', 'ktx status setup wrote unexpected stderr');
} finally {
  await rm(root, { recursive: true, force: true });
}
`;
}

async function buildArtifacts(layout) {
  await rm(layout.artifactDir, { recursive: true, force: true });
  await mkdir(layout.npmDir, { recursive: true });
  await mkdir(layout.pythonDir, { recursive: true });

  const commands = buildArtifactCommands(layout);
  const npmBuildCount = NPM_ARTIFACT_BUILD_ORDER.length;
  const npmPackStart = commands.length - 1;

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

  const projectDir = join(tmpRoot, 'npm-clean-install');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'package.json'),
    `${JSON.stringify(npmSmokePackageJson(layout), null, 2)}\n`,
  );
  await writeFile(join(projectDir, 'pnpm-workspace.yaml'), npmSmokePnpmWorkspaceYaml());
  await writeFile(join(projectDir, 'verify-npm.mjs'), npmVerifySource());
  await writeFile(join(projectDir, 'verify-installed-cli.mjs'), npmRuntimeSmokeSource());
  await writeFile(join(projectDir, 'verify-installed-cli-commands.mjs'), npmCliSmokeSource());

  await runCommand('pnpm', ['install'], { cwd: projectDir });
  await runCommand('pnpm', ['rebuild', 'better-sqlite3'], { cwd: projectDir });
  await runCommand('node', ['verify-npm.mjs'], { cwd: projectDir });
  await runCommand('pnpm', ['exec', 'ktx', '--version'], { cwd: projectDir });
  await runCommand('node', ['verify-installed-cli.mjs'], { cwd: projectDir });
  await runCommand('node', ['verify-installed-cli-commands.mjs'], { cwd: projectDir });
}

async function verifyNpmCliArtifacts(layout, tmpRoot) {
  for (const packageInfo of NPM_ARTIFACT_PACKAGES) {
    await assertPathExists(layout.npmTarballs[packageInfo.name], `${packageInfo.name} tarball`);
  }

  const projectDir = join(tmpRoot, 'npm-cli-clean-install');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'package.json'), `${JSON.stringify(npmSmokePackageJson(layout), null, 2)}\n`);
  await writeFile(join(projectDir, 'pnpm-workspace.yaml'), npmSmokePnpmWorkspaceYaml());
  await writeFile(join(projectDir, 'verify-installed-cli-commands.mjs'), npmCliSmokeSource());

  await runCommand('pnpm', ['install'], { cwd: projectDir });
  await runCommand('node', ['verify-installed-cli-commands.mjs'], { cwd: projectDir });
}

async function verifyArtifacts(layout) {
  await verifyArtifactManifest(layout);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'ktx-artifacts-'));
  try {
    await verifyNpmArtifacts(layout, tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function verifyCliArtifacts(layout) {
  await verifyArtifactManifest(layout);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'ktx-cli-artifacts-'));
  try {
    await verifyNpmCliArtifacts(layout, tmpRoot);
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
    await verifyCliArtifacts(layout);
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
