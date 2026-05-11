import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CLI_PYTHON_ASSET_MANIFEST,
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
  artifactManifestPath,
  buildArtifactCommands,
  copyRuntimeWheelAssets,
  findPythonArtifacts,
  NPM_ARTIFACT_PACKAGES,
  npmDemoSmokeSource,
  npmRuntimeSmokeSource,
  npmSmokePackageJson,
  npmSmokePythonEnv,
  npmVerifySource,
  packageArtifactLayout,
  packageReleaseMetadata,
  pythonArtifactInstallArgs,
  pythonVerifySource,
  verifyArtifactManifest,
  writeArtifactManifest,
} from './package-artifacts.mjs';

const STALE_METABASE_UNSUPPORTED = ['Standalone Metabase scheduled fetch', 'is intentionally unsupported'].join(' ');

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const CONNECTOR_PACKAGE_NAMES = [
  '@ktx/connector-bigquery',
  '@ktx/connector-clickhouse',
  '@ktx/connector-mysql',
  '@ktx/connector-postgres',
  '@ktx/connector-posthog',
  '@ktx/connector-snowflake',
  '@ktx/connector-sqlite',
  '@ktx/connector-sqlserver',
];

const NPM_BUILD_PACKAGE_ORDER = ['@ktx/llm', '@ktx/context', ...CONNECTOR_PACKAGE_NAMES, '@ktx/cli'];

function packageRootForName(packageName) {
  return `packages/${packageName.replace('@ktx/', '')}`;
}

function expectedNpmArtifactPath(packageName) {
  return `npm/${packageName.replace('@ktx/', 'ktx-')}-0.0.0-private.tgz`;
}

async function writeReleaseMetadataInputs(root) {
  const npmPackages = ['@ktx/context', '@ktx/llm', ...CONNECTOR_PACKAGE_NAMES, '@ktx/cli'];

  for (const packageName of npmPackages) {
    const packageRoot = packageName === '@ktx/context' ? 'packages/context' : packageRootForName(packageName);
    await mkdir(join(root, packageRoot), { recursive: true });
    await writeJson(join(root, packageRoot, 'package.json'), {
      name: packageName,
      version: '0.0.0-private',
      private: true,
    });
  }

  await mkdir(join(root, 'python', 'ktx-sl'), { recursive: true });
  await mkdir(join(root, 'python', 'ktx-daemon'), { recursive: true });
  await writeFile(
    join(root, 'python', 'ktx-sl', 'pyproject.toml'),
    ['[project]', 'name = "ktx-sl"', 'version = "0.1.0"', ''].join('\n'),
  );
  await writeFile(
    join(root, 'python', 'ktx-daemon', 'pyproject.toml'),
    ['[project]', 'name = "ktx-daemon"', 'version = "0.1.0"', ''].join('\n'),
  );
}

async function writeUploadableArtifactFixtures(layout) {
  await mkdir(layout.npmDir, { recursive: true });
  await mkdir(layout.pythonDir, { recursive: true });

  const fileContents = new Map([
    ...NPM_ARTIFACT_PACKAGES.map((packageInfo) => [
      layout.npmTarballs[packageInfo.name],
      `${packageInfo.name}-tarball`,
    ]),
    [
      join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
      'kaelio-ktx-runtime-wheel',
    ],
    [join(layout.pythonDir, 'ktx_sl-0.1.0-py3-none-any.whl'), 'ktx-sl-wheel'],
    [join(layout.pythonDir, 'ktx_sl-0.1.0.tar.gz'), 'ktx-sl-sdist'],
    [join(layout.pythonDir, 'ktx_daemon-0.1.0-py3-none-any.whl'), 'ktx-daemon-wheel'],
    [join(layout.pythonDir, 'ktx_daemon-0.1.0.tar.gz'), 'ktx-daemon-sdist'],
  ]);

  for (const [path, contents] of fileContents) {
    await writeFile(path, contents);
  }
}

describe('packageArtifactLayout', () => {
  it('uses stable artifact paths under ktx/dist/artifacts', () => {
    const layout = packageArtifactLayout('/repo/ktx');

    assert.equal(layout.artifactDir, '/repo/ktx/dist/artifacts');
    assert.equal(layout.npmDir, '/repo/ktx/dist/artifacts/npm');
    assert.equal(layout.pythonDir, '/repo/ktx/dist/artifacts/python');
    assert.equal(layout.contextTarball, '/repo/ktx/dist/artifacts/npm/ktx-context-0.0.0-private.tgz');
    assert.equal(layout.cliTarball, '/repo/ktx/dist/artifacts/npm/ktx-cli-0.0.0-private.tgz');
    assert.equal(
      layout.connectorTarballs['@ktx/connector-sqlite'],
      '/repo/ktx/dist/artifacts/npm/ktx-connector-sqlite-0.0.0-private.tgz',
    );
    assert.equal(
      layout.connectorTarballs['@ktx/connector-postgres'],
      '/repo/ktx/dist/artifacts/npm/ktx-connector-postgres-0.0.0-private.tgz',
    );
    assert.deepEqual(
      Object.keys(layout.npmTarballs),
      NPM_ARTIFACT_PACKAGES.map((packageInfo) => packageInfo.name),
    );
  });
});

describe('buildArtifactCommands', () => {
  it('builds TypeScript packages in dependency order before packing npm artifacts and builds Python packages', () => {
    const layout = packageArtifactLayout('/repo/ktx');
    const commands = buildArtifactCommands(layout);

    assert.deepEqual(
      commands.slice(0, NPM_ARTIFACT_PACKAGES.length).map((command) => [command.command, command.args]),
      NPM_BUILD_PACKAGE_ORDER.map((packageName) => ['pnpm', ['--filter', packageName, 'run', 'build']]),
    );
    assert.deepEqual(
      commands
        .slice(NPM_ARTIFACT_PACKAGES.length, NPM_ARTIFACT_PACKAGES.length + 3)
        .map((command) => [command.command, command.args]),
      [
        [
          process.execPath,
          ['scripts/build-python-runtime-wheel.mjs'],
        ],
        [
          'uv',
          ['build', '--package', 'ktx-sl', '--out-dir', '/repo/ktx/dist/artifacts/python'],
        ],
        [
          'uv',
          ['build', '--package', 'ktx-daemon', '--out-dir', '/repo/ktx/dist/artifacts/python'],
        ],
      ],
    );
    assert.deepEqual(
      commands.slice(NPM_ARTIFACT_PACKAGES.length + 3).map((command) => [command.command, command.args]),
      NPM_ARTIFACT_PACKAGES.map((packageInfo) => [
        'pnpm',
        ['--filter', packageInfo.name, 'pack', '--out', layout.npmTarballs[packageInfo.name]],
      ]),
    );
  });
});

describe('packageReleaseMetadata', () => {
  it('reads package identities and versions from package manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-metadata-test-'));
    try {
      await writeReleaseMetadataInputs(root);

      assert.deepEqual(await packageReleaseMetadata(root), [
        ...NPM_ARTIFACT_PACKAGES.map((packageInfo) => ({
          ecosystem: 'npm',
          packageName: packageInfo.name,
          packageRoot: packageInfo.packageRoot,
          packageVersion: '0.0.0-private',
          private: true,
          releaseMode: 'ci-artifact-only',
        })),
        {
          ecosystem: 'python',
          packageName: 'ktx-sl',
          packageRoot: 'python/ktx-sl',
          packageVersion: '0.1.0',
          private: false,
          releaseMode: 'ci-artifact-only',
        },
        {
          ecosystem: 'python',
          packageName: 'ktx-daemon',
          packageRoot: 'python/ktx-daemon',
          packageVersion: '0.1.0',
          private: false,
          releaseMode: 'ci-artifact-only',
        },
        {
          ecosystem: 'python',
          packageName: 'kaelio-ktx',
          packageRoot: 'python/runtime-wheel',
          packageVersion: '0.1.0',
          private: false,
          releaseMode: 'ci-artifact-only',
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('findPythonArtifacts', () => {
  it('finds one wheel and one source distribution for each Python package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-test-'));
    try {
      await writeFile(join(root, 'kaelio_ktx-0.1.0-py3-none-any.whl'), '');
      await writeFile(join(root, 'ktx_sl-0.1.0-py3-none-any.whl'), '');
      await writeFile(join(root, 'ktx_sl-0.1.0.tar.gz'), '');
      await writeFile(join(root, 'ktx_daemon-0.1.0-py3-none-any.whl'), '');
      await writeFile(join(root, 'ktx_daemon-0.1.0.tar.gz'), '');

      assert.deepEqual(await findPythonArtifacts(root), {
        runtimeWheel: join(root, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
        ktxSlWheel: join(root, 'ktx_sl-0.1.0-py3-none-any.whl'),
        ktxSlSdist: join(root, 'ktx_sl-0.1.0.tar.gz'),
        ktxDaemonWheel: join(root, 'ktx_daemon-0.1.0-py3-none-any.whl'),
        ktxDaemonSdist: join(root, 'ktx_daemon-0.1.0.tar.gz'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws when a required Python artifact is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-test-'));
    try {
      await assert.rejects(() => findPythonArtifacts(root), /Missing Python artifact: kaelio-ktx runtime wheel/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('artifact manifest', () => {
  it('writes release metadata, source revision, checksums, and byte counts for every uploadable artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-manifest-test-'));
    const layout = packageArtifactLayout(root);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);

      const manifest = await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });

      assert.equal(artifactManifestPath(layout), join(root, 'dist', 'artifacts', 'manifest.json'));
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.generatedAt, '2026-04-28T12:00:00.000Z');
      assert.equal(manifest.sourceRevision, 'abc123');
      assert.deepEqual(
        manifest.packages.filter((entry) => entry.ecosystem === 'npm'),
        NPM_ARTIFACT_PACKAGES.map((packageInfo) => ({
          ecosystem: 'npm',
          packageName: packageInfo.name,
          packageRoot: packageInfo.packageRoot,
          packageVersion: '0.0.0-private',
          private: true,
          releaseMode: 'ci-artifact-only',
        })),
      );
      assert.deepEqual(
        manifest.packages.filter((entry) => entry.ecosystem === 'python'),
        [
          {
            ecosystem: 'python',
            packageName: 'ktx-sl',
            packageRoot: 'python/ktx-sl',
            packageVersion: '0.1.0',
            private: false,
            releaseMode: 'ci-artifact-only',
          },
          {
            ecosystem: 'python',
            packageName: 'ktx-daemon',
            packageRoot: 'python/ktx-daemon',
            packageVersion: '0.1.0',
            private: false,
            releaseMode: 'ci-artifact-only',
          },
          {
            ecosystem: 'python',
            packageName: 'kaelio-ktx',
            packageRoot: 'python/runtime-wheel',
            packageVersion: '0.1.0',
            private: false,
            releaseMode: 'ci-artifact-only',
          },
        ],
      );
      assert.deepEqual(
        manifest.files
          .filter((file) => file.ecosystem === 'npm')
          .map((file) => ({
            artifactKind: file.artifactKind,
            ecosystem: file.ecosystem,
            packageName: file.packageName,
            packageVersion: file.packageVersion,
            path: file.path,
          }))
          .sort((left, right) => left.packageName.localeCompare(right.packageName)),
        NPM_ARTIFACT_PACKAGES.map((packageInfo) => ({
          artifactKind: 'tarball',
          ecosystem: 'npm',
          packageName: packageInfo.name,
          packageVersion: '0.0.0-private',
          path: expectedNpmArtifactPath(packageInfo.name),
        })).sort((left, right) => left.packageName.localeCompare(right.packageName)),
      );
      assert.deepEqual(
        manifest.files
          .filter((file) => file.ecosystem === 'python')
          .map((file) => ({
            artifactKind: file.artifactKind,
            ecosystem: file.ecosystem,
            packageName: file.packageName,
            packageVersion: file.packageVersion,
            path: file.path,
          })),
        [
          {
            artifactKind: 'wheel',
            ecosystem: 'python',
            packageName: 'kaelio-ktx',
            packageVersion: '0.1.0',
            path: 'python/kaelio_ktx-0.1.0-py3-none-any.whl',
          },
          {
            artifactKind: 'wheel',
            ecosystem: 'python',
            packageName: 'ktx-daemon',
            packageVersion: '0.1.0',
            path: 'python/ktx_daemon-0.1.0-py3-none-any.whl',
          },
          {
            artifactKind: 'sdist',
            ecosystem: 'python',
            packageName: 'ktx-daemon',
            packageVersion: '0.1.0',
            path: 'python/ktx_daemon-0.1.0.tar.gz',
          },
          {
            artifactKind: 'wheel',
            ecosystem: 'python',
            packageName: 'ktx-sl',
            packageVersion: '0.1.0',
            path: 'python/ktx_sl-0.1.0-py3-none-any.whl',
          },
          {
            artifactKind: 'sdist',
            ecosystem: 'python',
            packageName: 'ktx-sl',
            packageVersion: '0.1.0',
            path: 'python/ktx_sl-0.1.0.tar.gz',
          },
        ],
      );

      const sqliteEntry = manifest.files.find((file) => file.path === 'npm/ktx-connector-sqlite-0.0.0-private.tgz');
      assert.ok(sqliteEntry);
      assert.equal(sqliteEntry.bytes, Buffer.byteLength('@ktx/connector-sqlite-tarball'));
      assert.equal(sqliteEntry.sha256, createHash('sha256').update('@ktx/connector-sqlite-tarball').digest('hex'));

      const writtenManifest = JSON.parse(await readFile(artifactManifestPath(layout), 'utf-8'));
      assert.deepEqual(writtenManifest, manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('verifyArtifactManifest', () => {
  it('accepts a schema version 2 manifest that matches the artifact directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-verify-manifest-test-'));
    const layout = packageArtifactLayout(root);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);
      await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });

      const manifest = await verifyArtifactManifest(layout, {
        expectedSourceRevision: 'abc123',
      });

      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.sourceRevision, 'abc123');
      assert.equal(manifest.files.length, NPM_ARTIFACT_PACKAGES.length + 5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a manifest when a file checksum has drifted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-checksum-drift-test-'));
    const layout = packageArtifactLayout(root);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);
      await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });
      await writeFile(layout.contextTarball, 'changed-context-tarball');

      await assert.rejects(
        () => verifyArtifactManifest(layout),
        /Artifact manifest files do not match artifact contents/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a manifest with an unsafe artifact path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-path-test-'));
    const layout = packageArtifactLayout(root);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);
      const manifest = await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });
      manifest.files[0].path = '../outside.tgz';
      await writeFile(artifactManifestPath(layout), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(() => verifyArtifactManifest(layout), /Unsafe artifact manifest path: \.\.\/outside\.tgz/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a manifest from the wrong source revision when one is required', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-revision-test-'));
    const layout = packageArtifactLayout(root);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);
      await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });

      await assert.rejects(
        () =>
          verifyArtifactManifest(layout, {
            expectedSourceRevision: 'def456',
          }),
        /Artifact manifest sourceRevision mismatch: expected def456, got abc123/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('copyRuntimeWheelAssets', () => {
  it('copies the runtime wheel and checksum manifest into CLI assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-runtime-assets-test-'));
    const layout = packageArtifactLayout(root);
    try {
      await mkdir(layout.pythonDir, { recursive: true });
      await writeFile(
        join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
        'kaelio-ktx-runtime-wheel',
      );

      const assets = await copyRuntimeWheelAssets(layout, {
        runtimeWheel: join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
      });

      assert.equal(
        assets.wheelPath,
        join(root, 'packages', 'cli', 'assets', 'python', 'kaelio_ktx-0.1.0-py3-none-any.whl'),
      );
      assert.equal(
        assets.manifestPath,
        join(root, 'packages', 'cli', 'assets', 'python', CLI_PYTHON_ASSET_MANIFEST),
      );
      const manifest = JSON.parse(await readFile(assets.manifestPath, 'utf8'));
      assert.deepEqual(manifest, {
        schemaVersion: 1,
        distributionName: RUNTIME_WHEEL_DISTRIBUTION_NAME,
        normalizedName: RUNTIME_WHEEL_NORMALIZED_NAME,
        version: RUNTIME_WHEEL_PACKAGE_VERSION,
        wheel: {
          file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
          sha256: createHash('sha256')
            .update('kaelio-ktx-runtime-wheel')
            .digest('hex'),
          bytes: Buffer.byteLength('kaelio-ktx-runtime-wheel'),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('pythonArtifactInstallArgs', () => {
  it('installs the built Python wheels by artifact path', () => {
    const args = pythonArtifactInstallArgs('/tmp/smoke/.venv/bin/python', {
      runtimeWheel: '/repo/ktx/dist/artifacts/python/kaelio_ktx-0.1.0-py3-none-any.whl',
      ktxSlWheel: '/repo/ktx/dist/artifacts/python/ktx_sl-0.1.0-py3-none-any.whl',
      ktxSlSdist: '/repo/ktx/dist/artifacts/python/ktx_sl-0.1.0.tar.gz',
      ktxDaemonWheel: '/repo/ktx/dist/artifacts/python/ktx_daemon-0.1.0-py3-none-any.whl',
      ktxDaemonSdist: '/repo/ktx/dist/artifacts/python/ktx_daemon-0.1.0.tar.gz',
    });

    assert.deepEqual(args, [
      'pip',
      'install',
      '--python',
      '/tmp/smoke/.venv/bin/python',
      '/repo/ktx/dist/artifacts/python/kaelio_ktx-0.1.0-py3-none-any.whl',
    ]);
    assert.equal(args.includes('ktx-daemon'), false);
    assert.equal(args.includes('ktx-sl'), false);
    assert.equal(args.includes('--find-links'), false);
  });
});

describe('npmSmokePythonEnv', () => {
  it('prepends the npm smoke virtualenv bin directory to PATH', () => {
    const env = npmSmokePythonEnv('/tmp/ktx-npm-smoke', { PATH: '/usr/bin' });

    assert.match(env.PATH, /^\/tmp\/ktx-npm-smoke\/\.venv\/(bin|Scripts)/);
    assert.match(env.PATH, /\/usr\/bin$/);
  });
});

describe('verification snippets', () => {
  it('pins smoke dependencies and connector packages to clean-install-safe artifacts', () => {
    const layout = packageArtifactLayout('/repo/ktx');
    const packageJson = npmSmokePackageJson(layout);

    for (const packageInfo of NPM_ARTIFACT_PACKAGES) {
      assert.equal(packageJson.dependencies[packageInfo.name], `file:${layout.npmTarballs[packageInfo.name]}`);
      assert.equal(packageJson.pnpm.overrides[packageInfo.name], `file:${layout.npmTarballs[packageInfo.name]}`);
    }
    assert.equal(packageJson.dependencies['@modelcontextprotocol/sdk'], '^1.27.1');
    assert.deepEqual(packageJson.pnpm.onlyBuiltDependencies, ['better-sqlite3']);
  });

  it('exposes manifest verification as a package artifact command', async () => {
    const source = await readFile(new URL('./package-artifacts.mjs', import.meta.url), 'utf8');
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.match(source, /if \(command === 'verify-manifest'\)/);
    assert.match(source, /await verifyArtifactManifest\(layout\)/);
    assert.equal(packageJson.scripts['artifacts:verify-demo'], 'node scripts/package-artifacts.mjs verify-demo');
    assert.equal(packageJson.scripts['artifacts:verify-manifest'], 'node scripts/package-artifacts.mjs verify-manifest');
  });

  it('verifies installed dbt extraction exports from @ktx/context/ingest', () => {
    const source = npmVerifySource();

    assert.match(source, /const ingest = await import\('@ktx\/context\/ingest'\);/);
    assert.match(source, /const dbtExtractionExports = \[/);
    assert.match(source, /throw new Error\('Missing dbt extraction export: ' \+ exportName\);/);

    for (const exportName of [
      'parseMetricflowFiles',
      'parseMetricflowPullConfig',
      'importMetricflowSemanticModels',
      'parseDbtSchemaFiles',
      'toDescriptionUpdates',
      'toRelationshipUpdates',
      'mergeSemanticModelTables',
      'loadProjectInfo',
      'loadDbtSchemaFiles',
    ]) {
      assert.match(source, new RegExp(`\\['${exportName}', ingest\\.${exportName}\\]`));
    }
  });

  it('asserts the public npm and connector entry points that clean installs must expose', () => {
    const source = npmVerifySource();

    assert.match(source, /@ktx\/context/);
    assert.match(source, /@ktx\/context\/project/);
    assert.match(source, /@ktx\/context\/mcp/);
    assert.match(source, /@ktx\/context\/memory/);
    assert.match(source, /@ktx\/context\/daemon/);
    assert.match(source, /@ktx\/cli/);
    assert.match(source, /@ktx\/llm/);
    assert.match(source, /createKtxLlmProvider/);
    assert.match(source, /KtxMessageBuilder/);
    assert.match(source, /createKtxEmbeddingProvider/);
    assert.doesNotMatch(source, /createGatewayLlmProvider/);
    assert.match(source, /createLocalProjectMemoryCapture/);
    for (const packageName of CONNECTOR_PACKAGE_NAMES) {
      assert.match(source, new RegExp(packageName.replace('/', '\\/')));
    }
    assert.match(source, /KtxSqliteScanConnector/);
    assert.match(source, /KtxPostgresScanConnector/);
    assert.match(source, /KtxBigQueryScanConnector/);
    assert.match(source, /KtxSnowflakeScanConnector/);
    assert.match(source, /KtxPostHogScanConnector/);
  });

  it('asserts installed hybrid search exports and CLI smoke coverage', () => {
    const verifySource = npmVerifySource();
    const runtimeSource = npmRuntimeSmokeSource();
    const demoSource = npmDemoSmokeSource();

    assert.match(verifySource, /const search = await import\('@ktx\/context\/search'\);/);
    assert.match(verifySource, /HybridSearchCore/);
    assert.match(verifySource, /assertSearchBackendConformanceCase/);
    assert.match(verifySource, /assertSearchBackendCapabilities/);

    assert.match(runtimeSource, /ktx agent wiki search hybrid metadata verified/);
    assert.match(runtimeSource, /ktx agent sl list hybrid metadata verified/);
    assert.match(runtimeSource, /agent_sl_search_missing_project/);
    assert.match(runtimeSource, /agent_sl_search_no_connections/);
    assert.match(runtimeSource, /agent_sl_search_no_indexed_sources/);

    assert.match(demoSource, /ktx seeded demo agent wiki search verified/);
    assert.match(demoSource, /ktx seeded demo agent sl search verified/);
  });

  it('runs installed CLI commands and MCP through an installed daemon HTTP server', () => {
    const source = npmRuntimeSmokeSource();

    assert.match(source, /@modelcontextprotocol\/sdk\/client\/index\.js/);
    assert.match(source, /@modelcontextprotocol\/sdk\/client\/stdio\.js/);
    assert.match(source, /spawn\(command, args/);
    assert.match(source, /createServer/);
    assert.match(source, /request as httpRequest/);
    assert.match(source, /getAvailablePort/);
    assert.match(source, /startSemanticDaemon/);
    assert.match(source, /waitForHttpHealth/);
    assert.match(source, /stopSemanticDaemon/);
    assert.match(source, /'ktx-daemon'/);
    assert.match(source, /'serve-http'/);
    assert.match(source, /'--host'/);
    assert.match(source, /'127\.0\.0\.1'/);
    assert.match(source, /'--port'/);
    assert.match(source, /\/health/);
    assert.match(source, /--semantic-compute-url/);
    assert.match(source, /createDaemonLookerTableIdentifierParser/);
    assert.match(source, /LocalLookerRuntimeStore/);
    assert.match(source, /Looker daemon table identifier parser verified/);
    assert.match(source, /Looker local runtime store verified/);
    assert.match(source, /semanticComputeUrl/);
    assert.match(source, /run\('pnpm', \[\s*'exec',\s*'ktx',\s*'setup'/);
    assert.match(source, /knowledge', 'global', 'revenue\.md'/);
    assert.match(source, /run\('pnpm', \[\s*'exec',\s*'ktx',\s*'agent',\s*'wiki',\s*'search'/);
    assert.match(source, /semantic-layer', 'warehouse', 'orders\.yaml'/);
    assert.match(source, /run\('pnpm', \[\s*'exec',\s*'ktx',\s*'agent',\s*'sl',\s*'list'/);
    assert.match(source, /run\('pnpm', \[\s*'exec',\s*'ktx',\s*'agent',\s*'sl',\s*'query'/);
    assert.match(source, /orders\.order_count/);
    assert.match(source, /sqlite3/);
    assert.match(source, /driver: sqlite/);
    assert.match(source, /path: warehouse\.db/);
    assert.match(source, /live-database/);
    assert.match(source, /'--execute'/);
    assert.match(source, /'--execute-queries'/);
    assert.match(source, /slValidateResult\.success, true/);
    assert.match(source, /slQueryResult\.dialect, 'sqlite'/);
    assert.match(source, /slQueryResult\.plan\.execution\.driver, 'sqlite'/);
    assert.match(source, /"mode": "compile_only"/);
    assert.match(source, /"mode": "executed"/);
    assert.match(source, /ktx agent sl query sqlite execute/);
    assert.match(source, /run\('pnpm', \[\s*'exec',\s*'ktx',\s*'dev',\s*'scan',\s*'warehouse'/);
    assert.match(source, /'--mode',\s*'enriched'/);
    assert.doesNotMatch(source, /'--enrich'/);
    assert.match(source, /ktx scan structural verified/);
    assert.match(source, /ktx scan enriched verified/);
    assert.match(source, /scanReportJson\.artifactPaths\.manifestShards/);
    assert.match(source, /scanReportJson\.artifactPaths\.enrichmentArtifacts/);
    assert.match(source, /enrichment:/);
    assert.match(source, /mode: deterministic/);
    assert.match(source, /backend: gateway/);
    assert.match(source, /models:/);
    assert.match(source, /default: smoke\/provider/);
    assert.match(source, /api_key: env:AI_GATEWAY_API_KEY/);
    assert.match(source, /run\('pnpm', \['exec', 'ktx', 'dev', 'ingest', 'run'/);
    assert.match(source, /'serve', '--mcp', 'stdio'/);
    assert.doesNotMatch(source, /'--semantic-compute',\n\s*'--execute-queries'/);
    assert.match(source, /'--memory-capture', '--memory-model', 'smoke\/provider'/);
    assert.match(source, /mcpServerStderr/);
    assert.match(source, /ktx serve stderr/);
    assert.match(source, /sl_validate/);
    assert.match(source, /sl_query/);
    assert.match(source, /memory_capture/);
    assert.match(source, /memory_capture_status/);
    assert.match(source, /connection_test/);
    assert.match(source, /scan_trigger/);
    assert.match(source, /scan_status/);
    assert.match(source, /scan_report/);
    assert.match(source, /scan_list_artifacts/);
    assert.match(source, /scan_read_artifact/);
    assert.match(source, /mcpScanArtifacts\.artifacts\.find/);
    assert.match(source, /AI_GATEWAY_API_KEY/);
    assert.match(source, /access\(join\(projectDir, '\.ktx', 'db\.sqlite'\)\)/);
    assert.match(source, /SQLite knowledge index/);
    assert.match(source, /ktx dev ingest run requires llm\\.provider\\.backend: anthropic, vertex, or gateway/);
    assert.match(source, /ktx dev ingest provider guard verified/);
  });

  describe('npmDemoSmokeSource', () => {
    it('exercises the public packed-demo first-run contract', () => {
      const source = npmDemoSmokeSource();

      assert.match(source, /pnpm', \['exec', 'ktx', '--help'\]/);
      assert.match(source, /'demo', '--project-dir', projectDir, '--no-input', '--plain'/);
      assert.match(source, /Mode: seeded/);
      assert.match(source, /Source: packaged demo project/);
      assert.match(source, /LLM calls: none/);
      assert.match(source, /ktx serve --mcp stdio/);
      assert.doesNotMatch(source, new RegExp(["'demo'", "'--mode'", "'deterministic'"].join(', ')));
      assert.match(source, /'dev', 'doctor', 'setup', '--no-input'/);
      assert.match(source, /'--plain'/);
      assert.match(source, /ktx setup demo seeded wrote unexpected stderr/);
    });
  });

  it('checks packaged ingest runtime assets in the installed npm smoke', () => {
    const source = npmRuntimeSmokeSource();

    assert.match(source, /notion_synthesize\/SKILL\.md/);
    assert.match(source, /skills\/page_triage_classifier\.md/);
    assert.match(source, /skills\/light_extraction\.md/);
  });

  it('asserts the Python modules that clean installs must expose', () => {
    const source = pythonVerifySource();

    assert.match(source, /semantic_layer/);
    assert.match(source, /ktx_daemon/);
    assert.match(source, /importlib.metadata/);
  });
});
